"""Azure Realtime Translation session helpers.

The wire contract was verified empirically on 2026-06-10; see
docs/api-verification.md. Translation sessions only work over
``wss://{resource}.openai.azure.com/openai/v1/realtime/translations`` with
``api-key`` header auth, configured via a ``session.update`` event after
connect. Ephemeral client secrets and WebRTC are not available for them.
"""

import re
from urllib.parse import quote

# Output languages supported by gpt-realtime-translate.
ALLOWED_LANGUAGES = frozenset(
    {"es", "pt", "fr", "ja", "ru", "zh", "de", "ko", "hi", "id", "vi", "it", "en"}
)

_LANGUAGE_TAG_PATTERN = re.compile(r"^[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,2}$")


def normalize_target_language(target_language: str) -> str:
    if not isinstance(target_language, str) or not target_language.strip():
        raise ValueError("A target language code is required.")
    normalized = target_language.strip().lower()
    if not _LANGUAGE_TAG_PATTERN.match(normalized):
        raise ValueError(
            "Use a compact supported target language code such as ja, en, es, or zh."
        )
    if normalized not in ALLOWED_LANGUAGES:
        raise ValueError(
            "Use a supported target language code: "
            "es, pt, fr, ja, ru, zh, de, ko, hi, id, vi, it, or en."
        )
    return normalized


def build_azure_ws_url(endpoint: str, translate_deployment: str) -> str:
    if not endpoint:
        raise ValueError("AZURE_OPENAI_ENDPOINT is required.")
    base = endpoint.rstrip("/")
    if base.startswith("https://"):
        base = "wss://" + base[len("https://") :]
    return f"{base}/openai/v1/realtime/translations?model={quote(translate_deployment)}"


def build_session_update(
    target_language: str,
    whisper_deployment: str,
    noise_reduction: dict | None = None,
) -> dict:
    """Session config sent to Azure right after the WS connects.

    ``audio.input.transcription.model`` takes the *deployment* name on Azure;
    it is what makes ``session.input_transcript.delta`` (source captions) flow.
    """
    return {
        "type": "session.update",
        "session": {
            "audio": {
                "input": {
                    "transcription": {"model": whisper_deployment},
                    "noise_reduction": noise_reduction,
                },
                "output": {"language": normalize_target_language(target_language)},
            },
        },
    }
