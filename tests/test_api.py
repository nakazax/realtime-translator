import asyncio
import json
import threading

import pytest
import websockets
from fastapi.testclient import TestClient

from server.config import get_settings


@pytest.fixture
def fake_azure(monkeypatch):
    """A local WS server standing in for Azure's realtime translations endpoint."""
    received = []
    loop = asyncio.new_event_loop()

    async def handler(ws):
        await ws.send(
            json.dumps({"type": "session.created", "session": {"type": "translation"}})
        )
        async for raw in ws:
            event = json.loads(raw)
            received.append(event)
            if event["type"] == "session.update":
                await ws.send(json.dumps({"type": "session.updated"}))
            elif event["type"] == "session.input_audio_buffer.append":
                await ws.send(
                    json.dumps(
                        {"type": "session.output_transcript.delta", "delta": "テスト"}
                    )
                )

    thread = threading.Thread(target=loop.run_forever, daemon=True)
    thread.start()

    async def start():
        return await websockets.serve(handler, "127.0.0.1", 0)

    server = asyncio.run_coroutine_threadsafe(start(), loop).result(timeout=5)
    port = server.sockets[0].getsockname()[1]

    monkeypatch.setenv("AZURE_REALTIME_WS_URL", f"ws://127.0.0.1:{port}")
    monkeypatch.setenv("AZURE_OPENAI_API_KEY", "test-key")
    get_settings.cache_clear()

    yield received

    get_settings.cache_clear()
    asyncio.run_coroutine_threadsafe(_shutdown(server), loop).result(timeout=5)
    loop.call_soon_threadsafe(loop.stop)
    thread.join(timeout=5)


async def _shutdown(server):
    server.close()
    await server.wait_closed()


@pytest.fixture
def client():
    from server.main import app

    with TestClient(app) as test_client:
        yield test_client


def test_static_files_require_revalidation(client):
    response = client.get("/")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-cache"


def test_config_shape(client):
    response = client.get("/api/config")
    assert response.status_code == 200
    body = response.json()
    assert body["defaultTargetLanguage"] == "ja"
    assert "ja" in body["targetLanguages"]
    assert "en" in body["targetLanguages"]
    assert body["transport"] == "ws-proxy"


def test_ws_proxy_relays_session_and_audio(client, fake_azure):
    with client.websocket_connect("/api/ws?target=ja") as ws:
        # Azure-side session.created is relayed to the browser.
        created = ws.receive_json()
        assert created["type"] == "session.created"

        # The proxy injects its own session.update; Azure replies updated.
        updated = ws.receive_json()
        assert updated["type"] == "session.updated"

        # Browser audio is forwarded and the transcript delta comes back.
        ws.send_text(
            json.dumps({"type": "session.input_audio_buffer.append", "audio": "AAAA"})
        )
        delta = ws.receive_json()
        assert delta == {"type": "session.output_transcript.delta", "delta": "テスト"}

    session_update = fake_azure[0]
    assert session_update["type"] == "session.update"
    assert session_update["session"]["audio"]["output"]["language"] == "ja"
    assert (
        session_update["session"]["audio"]["input"]["transcription"]["model"]
        == "gpt-realtime-whisper"
    )


def test_ws_proxy_filters_non_audio_client_events(client, fake_azure):
    with client.websocket_connect("/api/ws?target=ja") as ws:
        ws.receive_json()  # session.created
        ws.receive_json()  # session.updated

        # A client must not be able to reconfigure the session.
        ws.send_text(
            json.dumps({"type": "session.update", "session": {"instructions": "evil"}})
        )
        ws.send_text(
            json.dumps({"type": "session.input_audio_buffer.append", "audio": "AAAA"})
        )
        delta = ws.receive_json()
        assert delta["type"] == "session.output_transcript.delta"

    forwarded_types = [event["type"] for event in fake_azure]
    assert "session.update" in forwarded_types[:1]  # only the proxy's own config
    assert forwarded_types.count("session.update") == 1


def test_ws_proxy_rejects_bad_language(client, fake_azure):
    with client.websocket_connect("/api/ws?target=klingon") as ws:
        # Starlette surfaces the server close as a disconnect message.
        message = ws.receive()
        assert message["type"] == "websocket.close"
        assert message["code"] == 4400


def test_compose_streams_translated_chunks(client, monkeypatch):
    captured = {}

    def fake_stream(text, endpoint, profile=""):
        captured["args"] = (text, endpoint, profile)
        return iter(["May I ", "ask a ", "question?"])

    monkeypatch.setattr("server.main.stream_compose_text", fake_stream)
    response = client.post("/api/compose", json={"text": "質問してもいいですか"})
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/plain")
    assert response.text == "May I ask a question?"
    assert captured["args"][0] == "質問してもいいですか"


def test_compose_rejects_blank_text(client):
    assert client.post("/api/compose", json={"text": ""}).status_code == 422
    assert client.post("/api/compose", json={"text": "   "}).status_code == 400


def test_compose_maps_connect_failure_to_502(client, monkeypatch):
    def boom(text, endpoint, profile=""):
        raise RuntimeError("endpoint unavailable")

    monkeypatch.setattr("server.main.stream_compose_text", boom)
    response = client.post("/api/compose", json={"text": "テスト"})
    assert response.status_code == 502
    assert response.json()["detail"] == "Translation request failed."
