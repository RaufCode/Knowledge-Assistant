import logging

from pydantic_settings import BaseSettings, SettingsConfigDict

logger = logging.getLogger(__name__)


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
    # How many chunks reach the generator. Four is enough to answer a policy
    # question without burying the prompt in passages the model will not use.
    top_k: int = 4

    # How far down each search looks before the two are fused. Deliberately deeper
    # than `top_k`: a chunk that is outside both lists' top few cannot reach the
    # fused top few either, so searching exactly `top_k` from each would cap the
    # fusion at the two best chunks it already had.
    vector_candidates: int = 10
    keyword_candidates: int = 10

    # The floor below which a chunk is not a match at all, applied per search
    # before fusion. Both are on their own search's scale and neither is
    # comparable to the other.
    #
    # `min_score` is the existing cosine-similarity floor and is tied to
    # `embed_model` — see the note on it below. `keyword_min_score` is a BM25
    # score, whose absolute value depends on corpus size and term rarity rather
    # than on any embedding, so it is set where a single meaningful term match on
    # this corpus clears it and a stray common word does not.
    min_score: float = 0.40
    keyword_min_score: float = 2.0

    # Below `min_score`, nothing is a match — but something is *always* the best
    # available answer, and refusing to show it to the generator throws away the
    # only thing that can judge it properly. This is the floor for that last
    # resort, and it is far lower on purpose: it is reached only when the strict
    # pass found nothing at all, and only to give the generator the chance to
    # answer or decline. It never relaxes `min_score` for a question that already
    # has a real match.
    #
    # Set from the observed spread rather than tuned: questions the corpus can
    # answer score as low as 0.22 on their best chunk, while genuinely unrelated
    # questions peak around 0.32 — the two ranges overlap, which is exactly why
    # this cannot be a relevance threshold and must be a recall one. Whether the
    # chunk actually answers is the generator's call, and it is a good one.
    recall_floor: float = 0.15

    # How many chunks the last resort hands over. More than `top_k` would be
    # pointless and fewer than `top_k` would make this look like a demotion; the
    # point is to give the generator the same evidence it gets for any other
    # question, so that it decides on equal terms.
    recall_candidates: int = 4
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

    # `SameSite` on the auth cookies. `lax` is right whenever the app and the API
    # share an origin, which is how both are set up here: the frontend serves its
    # own `/api` reverse proxy, so every browser request is same-site and the
    # cookies are first-party.
    #
    # `none` is for the case where the API really is on an origin of its own and
    # the browser calls it directly. It makes the cookies third-party, and browsers
    # increasingly refuse to send those at all, so a deployment using it tends to
    # work on a laptop and fail on a phone with no change in the code to explain
    # it. See `cookie_samesite`.
    auth_cookie_samesite: str = "lax"

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
    def cookie_samesite(self) -> str:
        """The `SameSite` attribute on the auth cookies.

        `lax` by default, which is what a deployment that serves the API itself
        wants: the app and the API share an origin, so every request is same-site
        and the browser has no reason to withhold the cookies.

        `none` is only for a deployment that genuinely cannot do that — the API on
        an origin of its own, reached by the browser directly. It makes the cookies
        third-party, which is what browsers are progressively refusing to send at
        all, so it fixes cross-origin sign-in at the cost of making it fragile
        again. Prefer routing the API through the app's own server, which is what
        the frontend's `/api` reverse proxy does.
        """
        configured = self.auth_cookie_samesite.strip().lower()

        if configured not in {"lax", "strict", "none"}:
            return "lax"

        # `SameSite=None` is rejected by every browser unless the cookie is also
        # `Secure`, so asking for one without the other produces cookies that are
        # silently dropped — the failure that is hardest to see from here.
        if configured == "none" and not self.cookies_are_secure:
            logger.warning(
                "AUTH_COOKIE_SAMESITE=none without secure cookies: every browser "
                "will drop them. Set AUTH_COOKIE_SECURE=true, or use 'lax' with the "
                "API served from the app's own origin."
            )

            return "lax"

        return configured

    @property
    def auth_is_usable(self) -> bool:
        """Whether a signing key is long enough to be worth signing anything with.

        Checked at startup rather than trusted, because a known default or a
        truncated secret is a real deployment mistake and produces tokens that
        verify everywhere.
        """
        return len(self.auth_secret_key.strip()) >= 32


settings = Settings()