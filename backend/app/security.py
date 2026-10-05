"""Signing, hashing and normalisation for the auth layer.

Everything in here is deliberately small and standalone: bcrypt through passlib,
JWTs through `jose`, and one text sanitiser. The rest of the auth layer is
FastAPI's own dependencies and a router.

`jose` earns its place by not being this file. A JWT is a header, a payload and a
signature joined by a base64url convention, and writing that by hand is how
subtle comparison and claim-check bugs get in. The library does the part that is
easy to get subtly wrong, and nothing here decides what a token is allowed to do.
"""

import logging
import re
import secrets
import unicodedata
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from jose import JWTError, jwt
from passlib.context import CryptContext

from app.config import settings

logger = logging.getLogger(__name__)

# bcrypt is deliberately the only scheme. One way to hash means a stored hash is
# never ambiguous about which scheme made it, so a future change is a migration
# rather than a guess at verification time.
#
# Contexts are cached per cost factor rather than built once, so the factor is a
# value read from settings at the moment it is used. Building it once at import
# would mean the cost could only ever be changed by editing code, and
# `needs_update` would compare against whatever was configured when the process
# started rather than what is configured now.
#
# `deprecated="auto"` marks a hash made at a lower cost as needing an update, which
# is what makes the rehash-on-sign-in path reachable.
#
# `bcrypt` is pinned below 4.1 in requirements.txt: passlib 1.7.4 probes the backend
# at import and raises on 4.1+, with a message about password length that points
# nowhere near the real cause.
_contexts: dict[int, CryptContext] = {}


def _context(rounds: int) -> CryptContext:
    context = _contexts.get(rounds)

    if context is None:
        context = CryptContext(
            schemes=["bcrypt"],
            deprecated="auto",
            bcrypt__rounds=rounds,
        )
        _contexts[rounds] = context

    return context

# HS256 rather than anything asymmetric. Both token types are verified by the same
# process that mints them and by nobody else, so there is no second party to verify
# a signature against and no public key to distribute. Asymmetric signing buys
# nothing here and costs a key pair to manage.
ALGORITHM = "HS256"

ACCESS_TOKEN_TYPE = "access"
REFRESH_TOKEN_TYPE = "refresh"

# Both are constants rather than settings: they are checked on every verification,
# so they are part of what a valid token looks like rather than deployment
# configuration. Changing one invalidates every token in the wild, which is what
# should happen.
TOKEN_AUDIENCE = "knowledge-assistant"
TOKEN_ISSUER = "knowledge-assistant"

# bcrypt reads at most 72 bytes and 5.x rejects anything longer outright. The
# request validators cap passwords well below this, and this is the belt to that
# braces: a future caller that forgets the cap gets a truncated hash rather than a
# crash.
BCRYPT_MAX_BYTES = 72


def auth_secret() -> str:
    """The signing key, refusing to sign with one that is not a secret.

    Raised rather than warned about, and only reached when a token is actually
    being minted. A short or absent key still produces tokens that verify against
    themselves, so without this check a deployment with a missing variable looks
    exactly like a working one right up until somebody guesses the key.
    """
    key = settings.auth_secret_key.strip()

    if not settings.auth_is_usable:
        raise RuntimeError(
            "AUTH_SECRET_KEY is unset or shorter than 32 characters. "
            "Generate one with: python -c \"import secrets; print(secrets.token_urlsafe(48))\""
        )

    return key


def hash_password(password: str) -> str:
    """A bcrypt hash of this password. The only form a password is ever stored in."""
    secret = password.encode("utf-8")[:BCRYPT_MAX_BYTES]

    return _context(settings.bcrypt_rounds).hash(secret)


def verify_password(password: str, password_hash: str | None) -> bool:
    """Whether this password is the one behind that hash.

    False for a missing hash rather than an error, because "this account has never
    had a password set" and "this password is wrong" have to be indistinguishable
    to the caller: both mean the sign-in failed.
    """
    if not password_hash:
        return False

    secret = password.encode("utf-8")[:BCRYPT_MAX_BYTES]

    try:
        return _context(settings.bcrypt_rounds).verify(secret, password_hash)
    except ValueError:
        # A hash that is not in a format bcrypt recognises is a corrupt row, not a
        # wrong password, and it must not read as a match.
        logger.error("stored password hash is not readable by bcrypt")
        return False


def needs_rehash(password_hash: str) -> bool:
    """Whether a stored hash was made at a lower cost than the current setting."""
    return _context(settings.bcrypt_rounds).needs_update(password_hash)


# Verification to spend when there is no stored hash to check against, one per cost
# factor. Generated lazily rather than at import because a hash made at one cost and
# verified while another is configured takes the wrong amount of time, and the whole
# point is that this call is indistinguishable from a real one. Building it at import
# would freeze it against whatever the cost happened to be when the process started.
_dummy_hashes: dict[int, str] = {}


def dummy_password_hash() -> str:
    """A hash of a random value nobody holds, to spend a verification's worth of work."""
    rounds = settings.bcrypt_rounds
    hash_value = _dummy_hashes.get(rounds)

    if hash_value is None:
        hash_value = _context(rounds).hash(secrets.token_urlsafe(32))
        _dummy_hashes[rounds] = hash_value

    return hash_value


def create_access_token(
    user_id: str, role: str, ttl_seconds: int | None = None
) -> tuple[str, datetime]:
    """A signed access token, and when it stops being valid.

    The role travels in the token so a request is authorised without a lookup, but
    `get_current_user` still reads the role off the user row. The claim is a hint
    about who this is; the row is what decides what they may do, so a demotion
    takes effect on the next request rather than when the token happens to expire.
    """
    expires_at = datetime.now(timezone.utc) + timedelta(
        seconds=ttl_seconds or settings.access_token_ttl_seconds
    )
    token = jwt.encode(
        {
            "sub": user_id,
            "role": role,
            "typ": ACCESS_TOKEN_TYPE,
            "jti": uuid4().hex,
            "iat": datetime.now(timezone.utc),
            "exp": expires_at,
            "aud": TOKEN_AUDIENCE,
            "iss": TOKEN_ISSUER,
        },
        auth_secret(),
        algorithm=ALGORITHM,
    )

    return token, expires_at


def create_refresh_token(
    user_id: str, session_id: str, family_id: str, ttl_seconds: int | None = None
) -> tuple[str, datetime]:
    """A signed refresh token naming one server-side session row.

    The `jti` is the row's id rather than a fresh random value, because looking the
    token up is how rotation and reuse detection work: a token whose row is already
    rotated out is a token being replayed, and that is only visible if the two
    agree.
    """
    expires_at = datetime.now(timezone.utc) + timedelta(
        seconds=ttl_seconds or settings.refresh_token_ttl_seconds
    )
    token = jwt.encode(
        {
            "sub": user_id,
            "typ": REFRESH_TOKEN_TYPE,
            "jti": session_id,
            "fam": family_id,
            "iat": datetime.now(timezone.utc),
            "exp": expires_at,
            "aud": TOKEN_AUDIENCE,
            "iss": TOKEN_ISSUER,
        },
        auth_secret(),
        algorithm=ALGORITHM,
    )

    return token, expires_at


# Every required claim. Without this, a token missing `exp` verifies as one that
# never expires, which is the failure mode that makes a signature check feel like
# security when it is only a formality.
_REQUIRED_CLAIMS = ["exp", "sub", "aud", "iss"]


def decode_token(token: str, expected_type: str) -> dict:
    """The claims of a valid token of this type.

    Raises `JWTError` for anything that is not one: a bad signature, an expired
    token, a wrong audience, a missing claim, or a token of the *other* type. The
    type check is what stops an access token being presented at `/api/auth/refresh`
    to mint a fresh pair, which would otherwise be a way to extend a session for as
    long as the attacker cared to try.
    """
    claims = jwt.decode(
        token,
        auth_secret(),
        algorithms=[ALGORITHM],
        audience=TOKEN_AUDIENCE,
        issuer=TOKEN_ISSUER,
        options={"require_exp": True, "require_sub": True, "verify_aud": True},
    )

    if claims.get("typ") != expected_type:
        raise JWTError(f"expected a {expected_type} token")

    return claims


def new_invite_token() -> str:
    """256 bits of entropy, URL-safe.

    `secrets` rather than `uuid4`: an invite token is the whole credential for
    creating an account, so its unpredictability is the security property. 32
    hex characters of `uuid4` would be guessable enough not to leave to chance
    given a v4 uuid's four version/variant bits.
    """
    return secrets.token_urlsafe(32)


def new_csrf_token() -> str:
    """A CSRF token.

    Not bound to a session and carries no authority of its own, so the entropy only
    has to be enough that an attacker cannot set the cookie themselves and read it
    back across origins. 32 bytes from `secrets` is well past that.
    """
    return secrets.token_urlsafe(32)


def new_family_id() -> str:
    """Groups every refresh token descended from one sign-in."""
    return uuid4().hex


# C0 and C1 control characters. Tab, newline and carriage return are separated
# out because they are whitespace a name may legitimately contain, and they are
# replaced with a space rather than deleted: "Ama\nKonadu" is one name written
# across two lines, and dropping the character would silently join it into
# "AmaKonadu".
_CONTROL_CHARACTERS = re.compile(r"[\x00-\x1f\x7f-\x9f]")
_LINE_BREAKS = re.compile(r"[\t\r\n\v\f]")


def sanitize_text(value: str) -> str:
    """Text safe to store and later render.

    Not HTML escaping. The auth layer stores structured values that Angular's
    interpolation escapes on the way out, so escaping here would double-encode a
    name like "Ben & Jerry" into something that renders as literal markup. What is
    removed is the part that is never legitimate: control characters, and
    zero-width and bidi-override characters, which are invisible in the UI but can
    reorder or hide what a name or an address actually says.

    Defence in depth, and deliberately the only place this happens: names arrive
    from an authenticated administrator, so the real fix is validation upstream.
    """
    without_invisibles = "".join(
        character
        for character in unicodedata.normalize("NFKC", value)
        if character.isprintable() or character.isspace()
    )

    return " ".join(_CONTROL_CHARACTERS.sub("", _LINE_BREAKS.sub(" ", without_invisibles)).split())


def normalize_email(email: str) -> str:
    """An address in the one form it is stored and compared in."""
    return email.strip().lower()


def has_company_domain(email: str) -> bool:
    """Whether this address belongs to the company.

    Compared on the part after the last "@", because that is the part the company
    controls. Checking the whole string would let `attacker@evil.test/?x=acme.example`
    through any test that only asks whether the domain appears somewhere in it.
    """
    _, _, domain = normalize_email(email).rpartition("@")

    return bool(domain) and domain == settings.email_domain