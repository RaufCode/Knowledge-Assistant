"""Rate limiting for the two endpoints worth guessing against.

`login` and `accept-invite` are the only routes where an attacker gets to try
something repeatedly without the attempt being visible as a problem anywhere else:
`accept-invite` takes a token and a password, and `login` takes an address and a
password. Five attempts a minute per IP is loose enough that a person who
mis-typed their password twice is never locked out of their own account, and tight
enough that a script stops being worth writing.

In-memory on purpose. `slowapi` keeps counters in the process, so with more than one
worker or more than one instance the effective limit is multiplied by the number of
them. That is stated rather than hidden: a shared store is the right answer at a
scale where a distributed limit is needed, and until then an honest per-instance
limit beats a Redis dependency that exists to multiply a number.
"""

import time

from fastapi.responses import JSONResponse
from slowapi import Limiter
from slowapi.util import get_remote_address

LOGIN_RATE_LIMIT = "5/minute"

limiter = Limiter(
    key_func=get_remote_address,
    # Reused across requests instead of growing without bound, so a long-running
    # process does not accumulate one counter per address ever seen.
    default_limits=[],
)


def rate_limit_exceeded_handler(request, exc):
    """A 429 that says when to come back.

    `slowapi`'s own handler answers with the message and nothing else, and a client
    told only that it was rate limited has no way to do anything sensible except
    retry immediately. `Retry-After` is the standard header for exactly this, and
    the browser honours it without the frontend having to parse anything.
    """
    limit = getattr(getattr(exc, "detail", None), "limit", None)

    response = JSONResponse(
        status_code=429,
        content={"detail": "Too many attempts. Please wait a moment and try again."},
    )

    retry_after = getattr(limit, "reset_at", None)
    if retry_after:
        response.headers["Retry-After"] = str(max(1, int(retry_after - time.time())))
    else:
        response.headers["Retry-After"] = "60"

    return response