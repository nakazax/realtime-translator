from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict

from server.azure_realtime import build_azure_ws_url


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    azure_openai_endpoint: str = ""
    azure_openai_api_key: str = ""
    azure_openai_whisper_deployment: str = "gpt-realtime-whisper"
    azure_openai_translate_deployment: str = "gpt-realtime-translate"
    default_target_language: str = "ja"
    # Compose box: Databricks pay-per-token chat endpoint for typed ja->en.
    compose_serving_endpoint: str = "databricks-claude-haiku-4-5"
    # Local development only; on Databricks Apps the SP credentials are ambient.
    compose_profile: str = ""
    # Test/debug override; when set, used verbatim instead of the derived Azure URL.
    azure_realtime_ws_url: str = ""

    def realtime_ws_url(self) -> str:
        if self.azure_realtime_ws_url:
            return self.azure_realtime_ws_url
        return build_azure_ws_url(
            self.azure_openai_endpoint, self.azure_openai_translate_deployment
        )


@lru_cache
def get_settings() -> Settings:
    return Settings()
