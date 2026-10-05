"""The request-scoped dependencies every route is built on.

`get_current_user` is the single place that decides who a request is from. It reads
one cookie and nothing else: no `Authorization` header, no token in the query
string. Accepting a token from more than one place would mean the "where could a
token leak from" question has two answers instead of one, and query strings in
particular end up in access logs and `Referer` headers.

`require_admin` is a second dependency rather than an `if` in each admin route, so
that "which routes are admin-only" is answered by reading the route signatures
instead of by grepping for a role comparison.
"""

import hmac
import logging
from collections.abc import Iterator
from urllib.parse import urlsplit

from fastapi import Depends, HTTPException, Request, status
from jose import JWTError
from sqlalchemy.orm import Session

from app.config import settings
from app.database import SessionLocal, User, get_user
from app.security import ACCESS_TOKEN_TYPE, decode_token

logger = logging.getLogger(__name__)

ACCESS_COOKIE = "ika_access"
CSRF_COOKIE = "ika_csrf"

# A readable flag saying "this browser probably has a session", carrying nothing of
# value. Set alongside the session cookies and cleared with them.
#
# It exists so the frontend can tell, without a network round trip, whether it is
# worth asking who somebody is. Without it, every signed-out visit to the sign-in
# screen had to call `GET /api/auth/me` to be told it was not signed in — a request
# for user details by somebody who has not signed in, which is both pointless and a
# bad look in the console.
#
# It grants nothing. There is no token in it and the backend never reads it; every
# authorization decision is still made from the `httpOnly` session cookies. A reader
# that forges it, or that deletes it, changes only whether the app bothers to ask.
SESSION_HINT_COOKIE = "ika_session"

# Requests that change state and therefore need the CSRF header, minus the ones
# that cannot carry it.
#
# The four exemptions are all reached at a point where no session exists yet: you
# cannot present a CSRF token before you have cookies to have issued it alongside.
# They are covered instead by the rate limit on the ones that take a password and
# by the fact that a forged sign-in still needs a password the attacker does not
# have. (`SameSite` does not protect these in production: the session cookies are
# `SameSite=None` so the browser attaches them cross-site, which is why the
# double-submit token + origin check exists on everything else.)
CSRF_EXEMPT_PATHS = frozenset(
    {
        "/api/auth/login",
        "/api/auth/accept-invite",
        "/api/auth/refresh",
        "/api/auth/logout",
        "/api/auth/csrf",
        "/api/auth/bootstrap-admin",
    }
)

SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS", "TRACE"})


def get_db() -> Iterator[Session]:
    """One session per request, closed when the response is done."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def open_db() -> Session:
    """A session of its own, for work that outlives the request that started it."""
    return SessionLocal()


def _unauthorized(detail: str = "Not authenticated") -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=detail,
        headers={"WWW-Authenticate": "Cookie"},
    )


def get_current_user(request: Request, db: Session = Depends(get_db)) -> User:
    """The user this request is made by, or a 401.

    The row is loaded on every request rather than trusted from the token. A token
    is a statement made up to fifteen minutes ago, and a role that has since been
    taken away has to stop working immediately: with only the claim, a demotion
    would not take effect until the access token expired on its own.
    """
    token = request.cookies.get(ACCESS_COOKIE)

    if not token:
        raise _unauthorized("Sign in to continue")

    try:
        claims = decode_token(token, ACCESS_TOKEN_TYPE)
    except JWTError:
        # Expired, tampered with, or signed by a key this server no longer holds.
        # All three mean the same thing to the caller, and saying which would tell
        # an attacker whether a forged token was otherwise well-formed.
        raise _unauthorized("Your session has ended. Please sign in again.")

    user = get_user(db, claims.get("sub", ""))

    if user is None:
        raise _unauthorized("Your session has ended. Please sign in again.")

    if not user.is_active:
        # Reachable when an account is deactivated after a token was already issued.
        raise _unauthorized("This account is not active.")

    return user


def require_admin(current_user: User = Depends(get_current_user)) -> User:
    """The current user, if they are an administrator. A 403 otherwise.

    403 rather than 401 because the caller is authenticated and telling them to
    sign in again would be wrong: signing in again would not help.
    """
    if current_user.role != "admin":
        logger.warning(
            "denied admin-only request to user %s (%s)", current_user.id, current_user.email
        )
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This action requires an administrator account.",
        )

    return current_user


def _origin_is_allowed(request: Request) -> bool:
    """Whether this request came from an origin we serve.

    Checked on state-changing requests only, as a second layer under the CSRF
    token. A browser always sends `Origin` on those, so an absent or unexpected
    one is either a non-browser client or a request nobody meant to make.
    """
    origin = request.headers.get("origin")

    if not origin:
        # Tolerated so a `curl`-shaped request is not rejected for a header a
        # command line does not send. Such a client is not a browser, so it cannot
        # be ridden by a victim's ambient cookies in the first place.
        return True

    # This service's own origin is always allowed, and it is not a convenience.
    #
    # The frontend can serve its own `/api` reverse proxy and present each request
    # to us as same-origin, which is what keeps the session cookies first-party. So
    # a request arriving with our own origin is one the app's own server made on
    # behalf of a page it rendered, and requiring it to also appear in a
    # hand-maintained list meant every deployment had to spell out an address it
    # already is — the deployed hostname locally, a LAN address for a phone, and a
    # different one each time a hosting provider generated a new service name. Any
    # one of them being wrong produced a 403 on the first write, which looks
    # nothing like a missing setting.
    #
    # Compared by host rather than by full origin, deliberately. Hosting providers
    # terminate TLS in front of the container and forward over plain http, so the
    # scheme this process sees is not the scheme the browser used, and comparing
    # the whole origin rejected every proxied write on exactly the deployments the
    # proxy exists to fix. The scheme is not what this check is for: the `Secure`
    # cookie flag and HSTS are what keep a session off plain http, and the host is
    # what identifies "this is us".
    #
    # Nothing is loosened by it. A page on another site still cannot get here with
    # a usable CSRF token, and the check below still applies to every origin that
    # is not this one.
    if _origin_host_is_ours(origin, request):
        return True

    trusted = settings.csrf_origins_list

    if not trusted:
        # No allow-list configured, which is a wildcard deployment. The CSRF token
        # is doing the work here; there is nothing to compare against.
        return True

    return origin.rstrip("/") in trusted


def _origin_host_is_ours(origin: str, request: Request) -> bool:
    """Whether `origin` names the host this request was sent to."""
    try:
        origin_host = urlsplit(origin).netloc.lower()
    except ValueError:
        return False

    return bool(origin_host) and origin_host == request.headers.get("host", "").lower()



def require_csrf(request: Request) -> None:
    """Rejects a state-changing request that cannot prove it is not forged.

    The double-submit check: the header the frontend read out of the cookie it was
    issued must be the cookie that arrived. A cross-origin attacker can cause the
    cookie to be sent but cannot read it to copy into a header, which is the whole
    mechanism. `compare_digest` rather than `==` so the comparison does not leak
    how much of a guessed token was right.

    A dependency rather than middleware so this list of exemptions stays in one
    place beside the rest of the auth decisions, instead of being a path-matching
    table that middleware would have to duplicate.
    """
    if request.method in SAFE_METHODS:
        return

    if request.url.path in CSRF_EXEMPT_PATHS:
        return

    if not _origin_is_allowed(request):
        logger.warning("rejected cross-origin request to %s", request.url.path)
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            # Naming the origin is what makes this diagnosable. It used to be a bare
            # "not from an allowed origin", which looks identical to a CSRF token
            # problem and sends people looking at the interceptor instead — while
            # the actual cause is one forgotten entry in a deployment setting.
            detail=(
                f"This request came from {request.headers.get('origin')!r}, which is not an "
                "allowed origin. Add it to CSRF_TRUSTED_ORIGINS (or ALLOWED_ORIGINS), "
                "spelled exactly as the browser sends it: scheme, host, no trailing slash."
            ),
        )

    cookie_token = request.cookies.get(CSRF_COOKIE, "")
    header_token = request.headers.get("x-csrf-token", "")

    if not cookie_token or not header_token or not hmac.compare_digest(cookie_token, header_token):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This request is missing a valid CSRF token.",
        )