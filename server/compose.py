"""Compose-box translation via Databricks Foundation Model APIs.

The Azure realtime translation sessions are audio-in only, so the typed
compose box ("I want to ask this in English") goes through the Databricks
workspace's pay-per-token chat endpoints instead. On Databricks Apps the
service principal credentials are ambient; locally the SDK authenticates
with the profile named in COMPOSE_PROFILE (or default env auth).
"""

import json
from collections.abc import Iterator
from functools import lru_cache

import requests
from databricks.sdk import WorkspaceClient

COMPOSE_SYSTEM_PROMPT = (
    "You are helping a Japanese speaker take part in an English business "
    "meeting. Translate the user's Japanese message into natural, concise "
    "spoken English they can say aloud in the meeting. If the message is "
    "already in English, polish it instead. Return only the English text, "
    "nothing else."
)


@lru_cache
def _workspace_client(profile: str) -> WorkspaceClient:
    return WorkspaceClient(profile=profile) if profile else WorkspaceClient()


def stream_compose_text(text: str, endpoint: str, profile: str = "") -> Iterator[str]:
    """Open a streaming translation; yields text chunks as the model emits them.

    Connect/HTTP errors raise before the iterator is returned, so the caller
    can still answer with a proper error status.
    """
    config = _workspace_client(profile).config
    response = requests.post(
        f"{config.host}/serving-endpoints/{endpoint}/invocations",
        headers=config.authenticate(),
        json={
            "messages": [
                {"role": "system", "content": COMPOSE_SYSTEM_PROMPT},
                {"role": "user", "content": text},
            ],
            "temperature": 0.2,
            "stream": True,
        },
        stream=True,
        timeout=(10, 120),
    )
    if response.status_code != 200:
        detail = response.text[:300]
        response.close()
        raise RuntimeError(f"serving endpoint HTTP {response.status_code}: {detail}")
    return _iter_sse_content(response)


def _iter_sse_content(response: requests.Response) -> Iterator[str]:
    try:
        for line in response.iter_lines():
            if not line or not line.startswith(b"data: "):
                continue
            payload = line[len(b"data: ") :]
            if payload == b"[DONE]":
                break
            chunk = json.loads(payload)
            choices = chunk.get("choices") or []
            delta = choices[0].get("delta", {}).get("content") if choices else None
            if delta:
                yield delta
    finally:
        response.close()
