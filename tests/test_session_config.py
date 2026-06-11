import pytest

from server.azure_realtime import (
    ALLOWED_LANGUAGES,
    build_azure_ws_url,
    build_session_update,
    normalize_target_language,
)


class TestNormalizeTargetLanguage:
    @pytest.mark.parametrize("language", sorted(ALLOWED_LANGUAGES))
    def test_accepts_supported_languages(self, language):
        assert normalize_target_language(language) == language

    def test_normalizes_case_and_whitespace(self):
        assert normalize_target_language("  JA ") == "ja"

    @pytest.mark.parametrize("language", ["", "  ", None, 123])
    def test_rejects_missing_values(self, language):
        with pytest.raises(ValueError):
            normalize_target_language(language)

    @pytest.mark.parametrize("language", ["klingon", "xx", "j a", "ja;rm"])
    def test_rejects_unsupported_or_malformed(self, language):
        with pytest.raises(ValueError):
            normalize_target_language(language)


class TestBuildAzureWsUrl:
    def test_builds_translations_url(self):
        url = build_azure_ws_url(
            "https://my-res.openai.azure.com/", "gpt-realtime-translate"
        )
        assert url == (
            "wss://my-res.openai.azure.com/openai/v1/realtime/translations"
            "?model=gpt-realtime-translate"
        )

    def test_quotes_deployment_name(self):
        url = build_azure_ws_url("https://r.openai.azure.com", "my deployment")
        assert url.endswith("?model=my%20deployment")

    def test_requires_endpoint(self):
        with pytest.raises(ValueError):
            build_azure_ws_url("", "gpt-realtime-translate")


class TestBuildSessionUpdate:
    def test_shape_matches_verified_contract(self):
        update = build_session_update("ja", "my-whisper")
        assert update == {
            "type": "session.update",
            "session": {
                "audio": {
                    "input": {
                        "transcription": {"model": "my-whisper"},
                        "noise_reduction": None,
                    },
                    "output": {"language": "ja"},
                },
            },
        }

    def test_rejects_bad_language(self):
        with pytest.raises(ValueError):
            build_session_update("nope", "my-whisper")
