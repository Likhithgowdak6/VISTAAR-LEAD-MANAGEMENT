"""
Settings for the Python CRM API.

READS THE SAME VARIABLES THE NODE BACKEND ALREADY HAS, and deliberately defines no new ones.
`MONGODB_URI`, `REDIS_URL` and `JWT_ACCESS_SECRET` are supplied to this container from the same
place Node reads them, which is the whole basis of coexistence: the two services are different
implementations of one backend, not two systems that happen to share a database. A second set of
credentials would be a second thing to rotate and a second way for them to disagree.

NOTHING HERE IS LOGGED. The secret is a `str` on a settings object and never reaches a log line,
an error message or a health response - see `app/main.py`, which reports whether dependencies are
reachable and nothing about how it reaches them.
"""

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(".env", "../.env", "backend/.env", "../backend/.env"),
        extra="ignore",
    )

    # The same connection string Mongoose uses. It must carry `replicaSet=rs0`: the deployment
    # runs mongod with `--replSet rs0` and the Node backend opens transactions against it, so a
    # URI without it would appear to work here - health only reads - and fail much later when
    # the first migrated module needs a transaction. `app/db.py` asserts the topology rather
    # than trusting the string.
    mongodb_uri: str = ""

    redis_url: str = ""

    # Verifies tokens the Node backend signed. Same secret, same algorithm; see app/auth.py.
    jwt_access_secret: str = ""

    # Mirrored only so `meta.environment` matches Node's health response exactly. The React app
    # reads these responses and must not be able to tell which service answered.
    node_env: str = "development"

    # Background runner activation gate.
    # Defaults to False so multi-worker API servers (e.g. uvicorn --workers 4) do NOT duplicate
    # the 13 background sweep loops across worker processes.
    # Set to True on dedicated single-instance background worker processes (app.worker) or
    # in single-process container deployments.
    enable_background_runners: bool = False

    # The replica set this database is expected to be part of. Named rather than assumed so the
    # readiness probe can say "connected to the wrong cluster" instead of just "connected".
    expected_replica_set: str = "rs0"

    # ---------------------------------------------------------------------------------------
    # ai-brain-service. Added in Phase 3 for POST /api/v1/templates/generate.
    #
    # THE SAME FOUR VARIABLES NODE ALREADY READS, with the same names and the same defaults, so
    # there is one value per setting on the box rather than one per service. `AI_BRAIN_ENABLED`
    # defaults to FALSE on purpose, matching `config/env.ts`: a service that cannot reach the
    # brain must answer 409 and say so, not time out against a URL that was never configured.
    #
    # `ai_brain_service_key` is a secret and is treated like `jwt_access_secret` - it is never
    # logged, never put in an error body, and never reported by the health endpoints.
    # ---------------------------------------------------------------------------------------
    ai_brain_enabled: bool = False
    ai_brain_service_url: str = ""
    ai_brain_service_key: str = ""
    ai_brain_request_timeout_ms: int = 90_000
    ai_enabled: bool = False
    ai_draft_rate_limit_per_hour: int = 60
    ai_draft_context_message_count: int = 20

    # --- assistant throttling ------------------------------------------------------------
    #
    # DELIBERATELY LOWER THAN THE DRAFT LIMIT, because one assistant question is up to
    # `assistant_agent.MAX_STEPS` (6) model calls while one draft is exactly one.
    #
    # NOTE THE DEFAULT ABOVE IS NOT THE DEPLOYED VALUE: `backend/.env` sets
    # AI_DRAFT_RATE_LIMIT_PER_HOUR=30, so the real budget for a one-call feature is 30/hour.
    # Setting the assistant to 30 as well would have allowed 180 model calls an hour — six
    # times the draft budget, under a number that looks like the same budget. That is exactly
    # the trap worth avoiding here.
    #
    # At 20/hour: ~40 model calls in typical use (most questions resolve in one tool call plus
    # an answer) and 120 in the worst case. THIS IS A JUDGEMENT CALL, not a derived figure —
    # strict model-call parity with drafts would mean 5 questions an hour, which is unusable
    # for a conversational feature. Raise or lower it with the environment variable.
    #
    # The per-minute counter is what makes "rapid repeated requests" bounded: without it the
    # whole hourly budget can be spent in fifteen seconds, which is both the worst cost case
    # and the most likely way to trip Anthropic's own rate limits.
    #
    # All three are environment variables (ASSISTANT_RATE_LIMIT_PER_MINUTE and friends), so
    # these numbers change without deploying new code.
    assistant_rate_limit_per_minute: int = 5
    assistant_rate_limit_per_hour: int = 20
    assistant_org_rate_limit_per_hour: int = 150

    # --- assistant cost reporting --------------------------------------------------------
    #
    # BOTH DEFAULT TO ZERO ON PURPOSE. Token counts come from the provider and are always
    # real; cost does not, because published rates change, vary by plan, and are not ours to
    # assume. Until these are set from an actual Anthropic invoice the usage page reports
    # tokens and shows cost as unconfigured, rather than displaying a confident wrong number.
    #
    # Quoted per MILLION tokens, matching how provider pricing is published.
    assistant_input_cost_per_mtok: float = 0.0
    assistant_output_cost_per_mtok: float = 0.0
    ai_provider: str = "anthropic"
    ai_model: str = "claude-3-5-sonnet-20241022"
    ai_max_output_tokens: int = 1000
    anthropic_api_key: str = ""
    grok_api_key: str = ""
    xai_api_key: str = ""
    groq_api_key: str = ""

    # Phase 4. The same variable Node reads, with the same default and the same meaning.
    # `config/env.ts` constrains it to 12..15; a lower value here would mint hashes that are
    # cheaper to attack than every hash already in the collection, with nothing to show for it.
    bcrypt_rounds: int = 12

    # Phase 5. Every analytics boundary is a LOCAL midnight in this zone - see date_range.py.
    # The default matches config/env.ts; a mismatch between the services would shift every
    # number on the dashboard by the offset, with nothing looking wrong.
    whatsapp_business_timezone: str = "Asia/Kolkata"

    # ---------------------------------------------------------------------------------------
    # Phase 6. Python becomes a token ISSUER here, not only a verifier - so every one of these
    # must match the Node value exactly or the two services mint tokens the other rejects.
    # Defaults mirror config/env.ts.
    # ---------------------------------------------------------------------------------------
    jwt_access_expires_in: str = "15m"
    refresh_token_bytes: int = 64
    refresh_token_ttl_days: int = 30

    # `SameSite=None` for the Capacitor WebView, which is cross-site to this API. Only honoured
    # alongside `Secure`, so switching it on without TLS gets the cookie rejected outright.
    auth_cookie_cross_site: bool = False

    # ---------------------------------------------------------------------------------------
    # Phase 7. Read ONLY to report which are missing on /push/status - this service does not
    # send a push, and will not until the reminder runner moves in Phase 8. The private key is
    # a secret and is handled like jwt_access_secret: never logged, never in a response body.
    # ---------------------------------------------------------------------------------------
    push_enabled: bool = False
    firebase_project_id: str = ""
    firebase_client_email: str = ""
    firebase_private_key: str = ""

    # Phase 9. Frontend origin for deep links and CORS.
    frontend_origin: str = ""

    # Phase 9. Reminder sweep runner.
    reminders_enabled: bool = False
    reminder_sweep_interval_ms: int = 5_000
    clock_alarm_push_enabled: bool = False

    # Phase 9. Promise follow-up sweep runner.
    promise_follow_up_enabled: bool = False
    whatsapp_enabled: bool = False
    whatsapp_send_text_poc_enabled: bool = False
    whatsapp_outbound_delivery_enabled: bool = False
    promise_sweep_interval_ms: int = 5 * 60 * 1000

    # Phase 9. Media storage and inbound media download.
    media_storage_dir: str = "var/media"
    media_max_upload_bytes: int = 16 * 1024 * 1024
    media_inbound_max_download_bytes: int = 16 * 1024 * 1024
    media_inbound_download_enabled: bool = False

    # Phase 9. Meta Lead Ads & Facebook OAuth
    meta_lead_ads_enabled: bool = False
    meta_graph_timeout_ms: int = 15_000
    meta_graph_max_pages_per_tick: int = 10
    meta_app_id: str = ""
    meta_app_secret: str = ""
    meta_redirect_uri: str = ""
    meta_webhook_verify_token: str = ""
    meta_oauth_state_ttl_ms: int = 600_000

    # Phase 9. Realtime outbox runner
    realtime_outbox_poll_interval_ms: int = 1000
    realtime_outbox_batch_size: int = 100

    # Phase 9. Lead import scheduled runner
    lead_import_enabled: bool = False
    lead_import_poll_interval_ms: int = 600_000
    lead_import_max_rows_per_tick: int = 200

    # Phase 10. AI Brain & Background Sweeps
    ai_brain_intent_timeout_ms: int = 8_000
    nurture_enabled: bool = False
    nurture_sweep_interval_ms: int = 1_800_000
    daily_jobs_enabled: bool = False
    digest_hour: int = 9
    lead_auto_greet_sweep_interval_ms: int = 60_000
    event_reminders_enabled: bool = False
    event_reminder_sweep_interval_ms: int = 14_400_000
    owner_call_escalation_enabled: bool = False
    owner_call_escalation_sweep_interval_ms: int = 120_000
    vapi_api_key: str = ""
    vapi_assistant_id: str = ""
    vapi_phone_number_id: str = ""

    # Google Calendar Two-Way Integration
    google_calendar_enabled: bool = False
    google_client_id: str = ""
    google_client_secret: str = ""
    google_redirect_uri: str = ""
    google_calendar_webhook_url: str = ""
    google_calendar_oauth_state_ttl_ms: int = 600_000
    google_calendar_sweep_interval_ms: int = 60_000
    google_calendar_channel_renew_window_hours: int = 24


settings = Settings()
