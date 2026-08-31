"""
Everything this service needs to know about its environment.

Deliberately small. This service does not own leads, proposals, WhatsApp
accounts, or a rate card — wam-crm-ai owns all of that. This service is a
"thinking" service: it gets facts handed to it on every call and returns a
decision. The one exception is `database_url` below, which is NOT for
business data — it is only where LangGraph stores its checkpoints, i.e. its
memory of "which step is this conversation on right now."
"""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Only for LangGraph's checkpoint tables (conversation "where are we"
    # state). Empty means "use the in-memory checkpointer" - fine for local
    # development and tests, but conversations are forgotten on restart.
    database_url: str = ""

    # llm
    llm_provider: str = "groq"          # groq | openai | anthropic | any OpenAI-compatible host
    llm_api_key: str = ""
    llm_base_url: str = ""
    llm_model: str = "openai/gpt-oss-120b"

    # How long one model call may take, and how many times it may be retried.
    #
    # These matter because wam-crm-ai aborts its HTTP call to this service after
    # AI_BRAIN_REQUEST_TIMEOUT_MS. Anything this service is still doing past that moment is work
    # nobody will ever read - and on a rate-limited key it is also quota spent to produce an
    # answer that gets thrown away. Keep timeout x (retries + 1) under the caller's timeout.
    #
    # Retries default to 1 rather than 3 for the same reason: a provider answering 429 with a
    # long Retry-After turns each extra attempt into tens of seconds of waiting, which is how a
    # single call reached 95s and blew a 30s caller budget.
    llm_timeout_seconds: float = 20.0
    llm_max_retries: int = 1

    # Stop asking qualifying questions after this many, whatever is missing.
    max_qualifying_questions: int = 6

    # A shared secret wam-crm-ai sends on every call, so this service only
    # answers its own CRM and not the open internet.
    service_api_key: str = ""


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
