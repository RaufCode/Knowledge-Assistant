from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Deployment shape. Only `production` changes behaviour: `Secure` cookies and
    # the strict origin check. Anything else is treated as a development or test
    # process, which is why the app never infers this from the request.
    environment: str = "development"

    # Generation key. NVIDIA's OpenAI-compatible API, so the OpenAI SDK talks to
    # it with nothing changed but the base URL.
    nvidia_api_key: str = ""
    nvidia_base_url: str = "https://integrate.api.nvidia.com/v1"
    # Chosen for time-to-first-token, not size. The previous default
    # (`z-ai/glm-5.3-flash`) reasoned for ~90s before writing a word, which no
    # amount of streaming can make feel responsive; this one starts in ~2s on the
    # same retrieval prompt while still following the answer-only-from-context
    # instructions. Verified provisioned on the generation key, unlike several
    # other fast candidates (nemotron-nano-3-30b, mistral-7b-instruct) which 404.
    llm_model: str = "openai/gpt-oss-20b"
    llm_temperature: float = 0.5
    llm_top_p: float = 1
    llm_max_tokens: int = 1024

    # A separate key for retrieval, so the embedding traffic has its own quota
    # and a generation throttle cannot stop the index from being built.
    nvidia_embedding_api_key: str = ""

    # Purpose-built for question retrieval rather than general embeddings, and
    # verified to be provisioned on the retrieval key. Others this project could
    # have used answer 404 "function not found for account"
    # (nv-embedqa-mistral-7b-v2, embed-qa-4, arctic-embed-l) or 410 Gone
    # (llama-3.2-nv-embedqa-1b-v2, nv-embedqa-e5-v5, nv-embed-v1, bge-m3).
    embed_model: str = "nvidia/nemotron-3-embed-1b"
    data_dir: str = "data"
    top_k: int = 4
    min_score: float = 0.40
    database_url: str = "postgresql://user:password@localhost:5432/knowledge_assistant"
    allowed_origins: str = "*"

    # Per-model attempts before giving up. A 429/5xx is load that usually clears,
    # so it is worth waiting on; a 4xx is a rejected key or a model the account
    # cannot reach, and asking again can only fail the same way.
    llm_max_attempts: int = 3
    llm_retry_base_seconds: float = 0.5

    # ---------------------------------------------------------------- auth ----
    # The one secret both token types are signed with. It is never sent anywhere
    # and never returned, and rotating it signs every existing session out at once
    # rather than leaving tokens verifiable under a key that is being retired.
    auth_secret_key: str = ""

    # Accounts exist only for company email addresses, enforced by the request
    # validators rather than by the browser, which checks it too so the user finds
    # out before the round trip. Stored without the leading "@".
    company_email_domain: str = "acmetech.example"

    # Short enough that a leaked access token is useless by the time anyone holds
    # it, long enough that a person reading is not interrupted mid-answer.
    access_token_ttl_seconds: int = 15 * 60

    # The band a refresh token has to sit in: long enough to survive a working
    # week away, short enough that a stolen cookie is not a month of access.
    refresh_token_ttl_seconds: int = 14 * 24 * 60 * 60

    # How long an invitation can be opened. Long enough to survive a weekend away,
    # short enough that a link forwarded to the wrong inbox stops working.
    invite_ttl_seconds: int = 72 * 60 * 60

    # Cost factor for new password hashes. 12 is about a quarter second on typical
    # server hardware, which is the right order for a login and painful to repeat
    # in bulk.
    bcrypt_rounds: int = 12

    # Sent as `Secure` on the auth cookies unless this is explicitly turned off,
    # which is only ever correct for local http development. Deliberately not
    # inferred from the request: a misconfigured deployment then fails closed,
    # because browsers drop insecure-marked cookies off an https origin, rather
    # than quietly issuing them without the flag.
    auth_cookie_secure: bool = True

    # The double-submit CSRF token is bound to nothing, so its origin check has
    # nothing to trust but this list. Every browser request carries an Origin, and
    # in development the API is a different origin from the app by design.
    csrf_trusted_origins: str = ""

    # Guards the one route that can create the first administrator. An invite-only
    # system has no way to create that account without it, so it is kept separate
    # from the JWT secret: knowing one must not let anybody mint tokens, and
    # knowing the other must not let anybody bootstrap.
    auth_bootstrap_key: str = ""

    # An optional throwaway administrator, seeded at startup when both halves are
    # set. It makes a fresh checkout usable and cannot run in production, where
    # `environment` must be set explicitly and this is refused. Remove the setting
    # once a real administrator exists.
    auth_seed_admin_email: str = ""
    auth_seed_admin_password: str = ""
    auth_seed_admin_name: str = "Administrator"

    # Where an invitation link points. The backend cannot know the app's address on
    # its own, and getting it wrong produces a link that reaches nothing, so it is
    # configured rather than guessed.
    frontend_base_url: str = "http://localhost:4200"

    @property
    def origins_list(self) -> list[str]:
        return [o.strip() for o in self.allowed_origins.split(",")]

    @property
    def is_production(self) -> bool:
        return self.environment.strip().lower() == "production"

    @property
    def has_nvidia_api_key(self) -> bool:
        return bool(self.nvidia_api_key.strip())

    @property
    def has_nvidia_embedding_api_key(self) -> bool:
        return bool(self.nvidia_embedding_api_key.strip())

    @property
    def email_domain(self) -> str:
        """The company domain, normalised, for comparison against an address."""
        return self.company_email_domain.strip().lstrip("@").lower()

    @property
    def csrf_origins_list(self) -> list[str]:
        """Origins allowed to make a cookie-authenticated request.

        Falls back to the CORS origins, which are the same list in practice, so
        there is only one thing to configure unless a deployment serves the API
        from somewhere the browser is also allowed to call.
        """
        configured = [o.strip().rstrip("/") for o in self.csrf_trusted_origins.split(",")]
        chosen = [o for o in configured if o and o != "*"]

        if chosen:
            return chosen

        return [o.rstrip("/") for o in self.origins_list if o != "*"]

    @property
    def cookies_are_secure(self) -> bool:
        """Whether auth cookies carry `Secure`, which production always requires."""
        return self.auth_cookie_secure or self.is_production

    @property
    def auth_is_usable(self) -> bool:
        """Whether a signing key is long enough to be worth signing anything with.

        Checked at startup rather than trusted, because a known default or a
        truncated secret is a real deployment mistake and produces tokens that
        verify everywhere.
        """
        return len(self.auth_secret_key.strip()) >= 32


settings = Settings()