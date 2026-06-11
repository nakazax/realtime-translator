import asyncio
import json
import logging
from pathlib import Path

import websockets
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from server.azure_realtime import (
    ALLOWED_LANGUAGES,
    build_session_update,
    normalize_target_language,
)
from server.compose import stream_compose_text
from server.config import get_settings

logger = logging.getLogger("realtime-translator")

CLIENT_DIR = Path(__file__).resolve().parent.parent / "client"

# Browser clients may only stream audio; session config is owned by the server.
CLIENT_EVENT_ALLOWLIST = frozenset({"session.input_audio_buffer.append"})

app = FastAPI(title="realtime-translator")


@app.get("/api/config")
async def get_config() -> dict:
    settings = get_settings()
    return {
        "targetLanguages": sorted(ALLOWED_LANGUAGES),
        "defaultTargetLanguage": settings.default_target_language,
        "transport": "ws-proxy",
    }


class ComposeRequest(BaseModel):
    text: str = Field(min_length=1, max_length=4000)


@app.post("/api/compose")
def compose(body: ComposeRequest) -> StreamingResponse:
    """Translate a typed message for the compose box, streaming plain text.

    Sync handler on purpose: the requests-based stream blocks, and FastAPI
    runs `def` routes (and sync iterators) in its threadpool, keeping the WS
    proxy loop free. The upstream connection is opened before streaming so
    connect failures still produce a 502 instead of a broken stream.
    """
    settings = get_settings()
    text = body.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Text is empty.")
    try:
        chunks = stream_compose_text(
            text, settings.compose_serving_endpoint, settings.compose_profile
        )
    except Exception as error:
        logger.error("compose translation failed: %r", error)
        raise HTTPException(
            status_code=502, detail="Translation request failed."
        ) from None
    return StreamingResponse(chunks, media_type="text/plain; charset=utf-8")


@app.websocket("/api/ws")
async def realtime_proxy(client_ws: WebSocket, target: str | None = None) -> None:
    """Relay a browser WebSocket to an Azure realtime translation session.

    Browsers cannot send the ``api-key`` header and Azure offers no ephemeral
    tokens for translation sessions (docs/api-verification.md), so the key
    stays server-side and every session flows through this proxy.
    """
    settings = get_settings()
    await client_ws.accept()

    try:
        language = normalize_target_language(target or settings.default_target_language)
    except ValueError as error:
        await client_ws.close(code=4400, reason=str(error))
        return

    try:
        azure_ws = await websockets.connect(
            settings.realtime_ws_url(),
            additional_headers={"api-key": settings.azure_openai_api_key},
            max_size=2**24,
        )
    except Exception as error:  # handshake/network failure
        logger.error("Azure WS connect failed: %s", error)
        await _close_quietly(client_ws, code=1011, reason="Azure connection failed")
        return

    try:
        await azure_ws.send(
            json.dumps(
                build_session_update(language, settings.azure_openai_whisper_deployment)
            )
        )

        async def pump_client_to_azure() -> None:
            while True:
                text = await client_ws.receive_text()
                try:
                    event_type = json.loads(text).get("type")
                except (json.JSONDecodeError, AttributeError):
                    continue
                if event_type in CLIENT_EVENT_ALLOWLIST:
                    await azure_ws.send(text)
                else:
                    logger.debug("dropping client event: %s", event_type)

        async def pump_azure_to_client() -> None:
            async for message in azure_ws:
                if isinstance(message, bytes):
                    message = message.decode("utf-8", errors="replace")
                await client_ws.send_text(message)

        tasks = [
            asyncio.create_task(pump_client_to_azure()),
            asyncio.create_task(pump_azure_to_client()),
        ]
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        for task in done:
            error = task.exception()
            if error and not isinstance(
                error, (WebSocketDisconnect, websockets.ConnectionClosed)
            ):
                logger.error("proxy pump failed: %r", error)
    finally:
        await azure_ws.close()
        await _close_quietly(client_ws)


async def _close_quietly(client_ws: WebSocket, code: int = 1000, reason: str = "") -> None:
    try:
        await client_ws.close(code=code, reason=reason)
    except RuntimeError:
        pass  # already closed


@app.middleware("http")
async def revalidate_static(request, call_next):
    """Make browsers revalidate static files on every load.

    StaticFiles sends ETag/Last-Modified but no Cache-Control, so browsers
    apply heuristic freshness and keep serving a stale UI after deploys.
    no-cache still allows 304s, so repeat loads stay cheap.
    """
    response = await call_next(request)
    if not request.url.path.startswith("/api/"):
        response.headers.setdefault("Cache-Control", "no-cache")
    return response


if CLIENT_DIR.is_dir():
    app.mount("/", StaticFiles(directory=CLIENT_DIR, html=True), name="static")
