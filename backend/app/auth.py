"""The auth routes.

The shape of the thing: an administrator invites somebody, the invitation arrives
as a link, the recipient sets a password, and from then on sign-in is a cookie.
There is no route here that creates an account without an invitation behind it, and
that is a property of the code rather than a promise — `bootstrap-admin` below is
the single exception and it can only ever create the first administrator.

Nothing in this module returns a token. Tokens go out as `httpOnly` cookies and
the JSON body carries the user and nothing else, so a token cannot be picked up by
frontend JavaScript, printed by a `console.log`, or read out of a devtools network
tab.
"""

import logging
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from jose import JWTError
from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from app.config import settings
from app.database import (
    AccessRequest,
    Conversation,
    Invite,
    Message,
    RefreshSession,
    User,
    find_open_access_request,
    find_user_by_email,
    revoke_all_sessions,
    revoke_family,
)
from app.dependencies import (
    ACCESS_COOKIE,
    CSRF_COOKIE,
    SESSION_HINT_COOKIE,
    get_current_user,
    get_db,
    require_admin,
    require_csrf,
)
from app.rate_limit import LOGIN_RATE_LIMIT, limiter
from app.schemas_auth import (
    AccessRequestDecisionRequest,
    AccessRequestDecisionResponse,
    AccessRequestDto,
    AccessRequestListResponse,
    AccessRequestRequest,
    AccessRequestSubmittedResponse,
    AcceptInviteRequest,
    BootstrapAdminRequest,
    ChangeOwnPasswordRequest,
    CreateAccountRequest,
    CsrfResponse,
    InvitePreviewResponse,
    InviteRequest,
    InviteResponse,
    LoginRequest,
    PasswordResetRequest,
    StatusResponse,
    UserDto,
    UserListResponse,
    UserResponse,
    UserSummaryDto,
    UserUpdateRequest,
)
from app.security import (
    REFRESH_TOKEN_TYPE,
    create_access_token,
    dummy_password_hash,
    create_refresh_token,
    decode_token,
    hash_password,
    new_csrf_token,
    new_family_id,
    new_invite_token,
    needs_rehash,
    verify_password,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/auth", tags=["auth"])


# The two cookies that carry a session. Both are `httpOnly`: frontend JavaScript
# reads neither, which is what makes an XSS bug unable to steal a session. Neither
# is scoped to `/api/auth` either, because the access cookie has to be sent with
# every conversation request and the refresh one with every refresh.
REFRESH_COOKIE = "ika_refresh"

# Where the invitation link points. Not a setting: the app is a single-page
# frontend at this path, and a link built from a configurable origin would be one
# more way to send somebody an invitation link for somewhere else.
ACCEPT_INVITE_PATH = "/accept-invite"

# One message for every failed sign-in. Whether the address is unknown, the
# password is wrong, or the account is still a pending invitation, the answer is
# the same 401. Splitting them would turn this endpoint into a way to enumerate
# which company email addresses have accounts.
INVALID_CREDENTIALS = "That email and password do not match an account."

# Likewise for invitations: an unknown token, an expired one and a used one are
# indistinguishable, so a holder of a dead link learns nothing about which.
INVALID_INVITE = "This invitation is not valid."


def _user_dto(user: User) -> UserDto:
    return UserDto(id=user.id, name=user.name, email=user.email, role=user.role)


def _bearer_cookie_kwargs(max_age: int) -> dict:
    """Flags every session cookie carries.

    `httponly` keeps the value out of reach of JavaScript, which is the single most
    important line here. `secure` stops the browser sending it over plain http, and
    production forces it on regardless of the setting. `samesite` is `"none"` in
    production (cross-subdomain frontend/backend on `*.onrender.com` are cross-site,
    so `lax` withholds the cookies from every `fetch` and sign-in never sticks)
    and `"lax"` for local http, where `none` without `secure` would be rejected.
    """
    return {
        "httponly": True,
        "secure": settings.cookies_are_secure,
        "samesite": "none" if settings.cookies_are_secure else "lax",
        "path": "/",
        "max_age": max_age,
    }


def set_session_cookies(
    response: Response, user: User, db: Session, family_id: str | None = None
) -> None:
    """Issues an access token and a new refresh session, and sets both cookies.

    Called on sign-in, on accepting an invitation, and on every refresh. Writing
    this once is deliberate: a second copy of it would be a second place where the
    flags could differ, and the flags are the security property.

    `family_id` is what makes rotation mean anything. A rotation continues the
    existing family rather than starting a new one, so every token descended from
    one sign-in stays connected and a single revocation can still reach all of
    them. Minting a fresh family per rotation would make each reuse detection
    revoke only the token that was already dead, and leave the live one working.
    """
    access_token, _ = create_access_token(user.id, user.role)

    session_id = secrets.token_urlsafe(32)
    family_id = family_id or new_family_id()
    refresh_token, expires_at = create_refresh_token(user.id, session_id, family_id)

    db.add(
        RefreshSession(
            id=session_id,
            user_id=user.id,
            family_id=family_id,
            expires_at=expires_at,
        )
    )
    db.commit()

    response.set_cookie(ACCESS_COOKIE, access_token, **_bearer_cookie_kwargs(settings.access_token_ttl_seconds))
    response.set_cookie(REFRESH_COOKIE, refresh_token, **_bearer_cookie_kwargs(settings.refresh_token_ttl_seconds))

    # The readable flag, so the app can decide whether asking who the user is is
    # worth a round trip. Deliberately carries no token and is never read here.
    response.set_cookie(
        SESSION_HINT_COOKIE,
        "1",
        httponly=False,
        secure=settings.cookies_are_secure,
        samesite="none" if settings.cookies_are_secure else "lax",
        path="/",
        max_age=settings.refresh_token_ttl_seconds,
    )


def clear_session_cookies(response: Response) -> None:
    """Removes both cookies.

    The attributes have to match the ones they were set with or the browser treats
    it as a different cookie and leaves the original in place. `max_age=0` is what
    actually deletes one; the empty value is belt to that braces.
    """
    response.delete_cookie(
        ACCESS_COOKIE,
        path="/",
        secure=settings.cookies_are_secure,
        samesite="none" if settings.cookies_are_secure else "lax",
    )
    response.delete_cookie(
        REFRESH_COOKIE,
        path="/",
        secure=settings.cookies_are_secure,
        samesite="none" if settings.cookies_are_secure else "lax",
    )
    # Cleared with the rest, so signing out does not leave the app believing it is
    # still worth asking about a session.
    response.delete_cookie(
        SESSION_HINT_COOKIE,
        path="/",
        secure=settings.cookies_are_secure,
        samesite="none" if settings.cookies_are_secure else "lax",
    )


def set_csrf_cookie(response: Response, token: str | None = None) -> str:
    """Issues a CSRF token and sets it as a readable cookie.

    Deliberately not `httpOnly`. The frontend has to read this one and put it in a
    header, and that is the entire double-submit mechanism: a cookie the attacker
    cannot read is no use for forging a request, and a token the frontend cannot
    read is no use for making a legitimate one. It carries no authority on its own —
    it is only ever compared against a companion header.
    """
    issued = token or new_csrf_token()

    response.set_cookie(
        CSRF_COOKIE,
        issued,
        # Readable by script on purpose; see above.
        httponly=False,
        secure=settings.cookies_are_secure,
        samesite="none" if settings.cookies_are_secure else "lax",
        path="/",
        # A session, not a week: it is reissued on every sign-in and every refresh.
        max_age=settings.refresh_token_ttl_seconds,
    )

    return issued


@router.get("/csrf", response_model=CsrfResponse)
def issue_csrf(response: Response) -> CsrfResponse:
    """Hands out a CSRF token, and sets the cookie that must accompany it.

    Safe without one, since it changes nothing: it is the bootstrap for every
    state-changing call that follows.
    """
    return CsrfResponse(csrf_token=set_csrf_cookie(response))


@router.post("/login", response_model=UserResponse)
@limiter.limit(LOGIN_RATE_LIMIT)
def login(
    request: Request,
    response: Response,
    req: LoginRequest,
    db: Session = Depends(get_db),
    _csrf: None = Depends(require_csrf),
) -> UserResponse:
    """Signs somebody in.

    Exempt from CSRF because there is no session yet to have issued a token for.
    What protects it instead is the rate limit, the fact that a forged sign-in needs
    a password the attacker does not have, and `SameSite=Lax` withholding the
    cookies from a cross-site POST so the response cannot be read back.
    """
    user = find_user_by_email(db, req.email)

    # The hash is verified even when there is no such user, against a fixed dummy,
    # so that an address with no account takes the same time as one with a wrong
    # password. Without this, response time alone says which addresses exist.
    if user is None:
        verify_password(req.password, dummy_password_hash())
        logger.info("sign-in attempt for unknown address %s", req.email)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=INVALID_CREDENTIALS)

    if not user.is_active or not verify_password(req.password, user.password_hash):
        logger.info("failed sign-in for %s", user.email)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=INVALID_CREDENTIALS)

    # A hash made at a lower cost than the current setting is replaced on the way
    # past, which is the only moment a user has already proved they know the
    # plaintext.
    if user.password_hash and needs_rehash(user.password_hash):
        user.password_hash = hash_password(req.password)
        db.commit()

    set_session_cookies(response, user, db)
    # The CSRF cookie goes out with the session rather than needing a second request
    # for it. Sign-in, accepting an invitation and refreshing all mint a session, so
    # all three hand one over; leaving it out of one of them would mean the first
    # state-changing request after signing in had no token to send.
    set_csrf_cookie(response)
    logger.info("signed in %s (%s)", user.email, user.role)

    return UserResponse(user=_user_dto(user))


@router.post("/refresh", response_model=UserResponse)
def refresh(
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
    _csrf: None = Depends(require_csrf),
) -> UserResponse:
    """Exchanges a refresh token for a new pair, and retires the old one.

    Rotation is what makes a stolen refresh token detectable: the old token stops
    working the moment it is exchanged, so anybody still holding it is holding
    something dead, and the next attempt to use it says so. That second attempt is
    the signal — the legitimate client has the new token, so a presentation of the
    old one means there are two clients, one of which is not the user.

    A client that never dropped an old cookie looks identical from here, and there
    is no way to tell the two apart, so the family is revoked and both sides sign in
    again. That is the annoying answer, and it is the one that does not have to
    guess.
    """
    token = request.cookies.get(REFRESH_COOKIE)

    if not token:
        clear_session_cookies(response)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="No active session.")

    try:
        claims = decode_token(token, REFRESH_TOKEN_TYPE)
    except JWTError:
        # Expired, tampered with, or signed by a retired key. Nothing to revoke:
        # there is no session row we can trust enough to act on.
        clear_session_cookies(response)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="No active session.")

    session = db.get(RefreshSession, claims.get("jti", ""))
    user = db.get(User, claims.get("sub", ""))

    if session is None or user is None:
        # A signed token naming a session that is not in the database: the rows were
        # deleted, or the token was minted against a different database.
        clear_session_cookies(response)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="No active session.")

    if session.revoked_at is not None:
        revoke_family(db, session.family_id)
        clear_session_cookies(response)
        logger.warning(
            "refresh token reuse on revoked session %s; revoked family %s",
            session.id,
            session.family_id,
        )
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="No active session.")

    if session.rotated_at is not None:
        # The signature is valid and the row is live, but this token has already
        # been exchanged. Nothing about a single token says whether the holder is
        # the user or whoever took the cookie, so the whole family goes.
        revoked = revoke_family(db, session.family_id)
        clear_session_cookies(response)
        logger.warning(
            "refresh token reuse on rotated session %s; revoked %d sessions in family %s",
            session.id,
            revoked,
            session.family_id,
        )
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="No active session.")

    if not user.is_active:
        revoke_family(db, session.family_id)
        clear_session_cookies(response)
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="This account is not active.")

    # Rotate: the outgoing row is marked, never deleted, because "this token has
    # already been used" is the fact reuse detection is made of. The replacement
    # joins the same family so one revocation can still end the whole chain.
    session.rotated_at = datetime.now(timezone.utc)
    db.commit()

    # The same family, so a later reuse detection can still reach the token issued
    # here as well as the one that was retired.
    set_session_cookies(response, user, db, family_id=session.family_id)
    # A new access token on every refresh, and the CSRF cookie is reissued with it so
    # a long-lived tab does not end up holding a token from a session that no longer
    # exists.
    set_csrf_cookie(response)

    return UserResponse(user=_user_dto(user))


@router.post("/logout", response_model=StatusResponse)
def logout(
    response: Response,
    request: Request,
    db: Session = Depends(get_db),
    _csrf: None = Depends(require_csrf),
) -> StatusResponse:
    """Ends the session server-side, then clears the cookies.

    The revocation is the part that matters. Clearing a cookie asks the browser to
    forget it; the row is what makes a copy of that cookie useless to whoever holds
    it, which is the whole reason a cookie cannot be treated as a self-deleting
    thing.

    The whole family goes rather than the one token presented, because logging out
    on one device should not leave a session alive on another.
    """
    token = request.cookies.get(REFRESH_COOKIE)

    if token:
        try:
            claims = decode_token(token, REFRESH_TOKEN_TYPE)
        except JWTError:
            # An unusable token is not worth reporting: the browser is being told to
            # forget the cookies either way, and there is nothing to revoke.
            claims = {}

        session = db.get(RefreshSession, claims.get("jti", "")) if claims else None

        if session is not None:
            revoke_family(db, session.family_id)
            logger.info("signed out session %s", session.id)

    clear_session_cookies(response)

    return StatusResponse(status="signed_out")


@router.get("/me", response_model=UserDto)
def me(current_user: User = Depends(get_current_user)) -> UserDto:
    """The signed-in person.

    This is what a page load calls to find out whether the cookie is still good, so
    a reload lands back inside the session rather than back at the sign-in screen.
    """
    return _user_dto(current_user)


@router.post("/me/password", response_model=StatusResponse)
def change_own_password(
    req: ChangeOwnPasswordRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
    _csrf: None = Depends(require_csrf),
) -> StatusResponse:
    """Changes the signed-in person's own password. Any role.

    The current password is checked first, so a session left open on a shared
    machine cannot be used to lock its owner out. Every session is revoked with
    it, exactly as an administrator reset does: the frontend signs out afterwards
    and the new password is what signs back in.
    """
    if not verify_password(req.current_password, current_user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Your current password is not correct.",
        )

    current_user.password_hash = hash_password(req.new_password)
    current_user.updated_at = datetime.now(timezone.utc)

    revoke_all_sessions(db, current_user.id)
    db.commit()

    logger.info("user changed their own password for %s", current_user.email)

    return StatusResponse(status="password-changed")


def provision_pending_user(
    db: Session, name: str, email: str, role: str, invited_by: str
) -> tuple[User, str]:
    """Creates the pending account behind an invitation, and its invitation.

    The single place an account is provisioned, because two things do it: an
    administrator inviting somebody directly, and an administrator approving a
    request. Two copies of this would be two places for the rules below to drift
    apart.

    What it guarantees:

    - The account row is written *before* the invitation goes out, so the address is
      reserved by the act of provisioning. That is why a second invitation for an
      active account is a 409 rather than a second account somebody is surprised by
      later.
    - Any earlier unopened invitation for the same account is dropped, so only the
      newest link works. Two live links would mean two passwords could be set, and
      which one the person ended up with would come down to which link they opened.
    - The token comes back to the caller and goes nowhere else. It reaches an
      administrator's response body, never the person who asked for the account.
    """
    existing = find_user_by_email(db, email)

    if existing is None:
        user = User(
            id=secrets.token_urlsafe(16),
            email=email,
            name=name,
            role=role,
            password_hash=None,
            is_active=False,
        )
        db.add(user)
        db.flush()
    else:
        # Re-inviting somebody who never accepted: reuse the row and correct it, so
        # their id does not change underneath an invitation already in their inbox.
        user = existing
        user.name = name
        user.role = role

    db.query(Invite).filter(Invite.user_id == user.id, Invite.used_at.is_(None)).delete(
        synchronize_session=False
    )

    token = new_invite_token()
    expires_at = datetime.now(timezone.utc) + timedelta(seconds=settings.invite_ttl_seconds)

    db.add(
        Invite(
            token=token,
            user_id=user.id,
            invited_by=invited_by,
            expires_at=expires_at,
        )
    )
    db.commit()

    return user, token, expires_at


def invite_link_for(token: str) -> str:
    """The link an administrator passes on to the person being invited."""
    return f"{settings.frontend_base_url.rstrip('/')}{ACCEPT_INVITE_PATH}?token={token}"


@router.post("/invite", response_model=InviteResponse, status_code=status.HTTP_201_CREATED)
def create_invite(
    req: InviteRequest,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
    _csrf: None = Depends(require_csrf),
) -> InviteResponse:
    """Provisions a pending account and mints its invitation. Administrators only.

    The link is returned rather than emailed: no mail service is configured. An
    administrator copies it and sends it themselves, which is a real workflow rather
    than a stub pretending to be one.
    """
    existing = find_user_by_email(db, req.email)

    if existing is not None and existing.is_active:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="That address already has an active account.",
        )

    user, token, expires_at = provision_pending_user(db, req.name, req.email, req.role, admin.id)
    link = invite_link_for(token)

    logger.info("invited %s as %s; invite link: %s", user.email, user.role, link)

    return InviteResponse(
        invite_link=link,
        token=token,
        expires_at=expires_at.isoformat(),
        user=_user_dto(user),
    )


@router.post("/accounts", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
def create_account(
    req: CreateAccountRequest,
    db: Session = Depends(get_db),
    _admin: User = Depends(require_admin),
    _csrf: None = Depends(require_csrf),
) -> UserResponse:
    """Creates an account outright, with a password the administrator chooses.

    Administrators only, and the role is decided here and nowhere else, exactly as it
    is when an invitation is issued.

    This is a second way in beside the invitation flow, not a replacement for it, and
    the difference is who knows the password. An invitation is a single-use link the
    person sets their own password against, so the administrator never learns it and
    the credentials never exist anywhere but in that person's hands. Here the
    administrator writes the password and hands it over, which is the only thing that
    works when there is no mail service to deliver a link with — and it is a weaker
    arrangement, because from that moment the administrator could sign in as them.

    The rows it creates are ordinary active users, so the two flows are
    indistinguishable afterwards: signing in, being an administrator, being listed as
    a requester are all decided the same way whichever door the account came through.

    Rejected for an address that already has an active account, which is a 409 rather
    than a silent correction of somebody's existing login. A pending account — one
    invited and never accepted — is activated here instead, because the person has
    been told about the account and is waiting to use it.
    """
    existing = find_user_by_email(db, req.email)

    if existing is not None and existing.is_active:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="That address already has an active account.",
        )

    if existing is None:
        user = User(
            id=secrets.token_urlsafe(16),
            email=req.email,
            name=req.name,
            role=req.role,
            password_hash=None,
            is_active=False,
        )
        db.add(user)
        db.flush()
    else:
        # An invitation was issued and never accepted. The row is reused so the id the
        # outstanding invitation points at stays valid, and the invitation is dropped
        # because there is no longer any link to follow.
        user = existing
        user.name = req.name
        user.role = req.role

    db.query(Invite).filter(Invite.user_id == user.id, Invite.used_at.is_(None)).delete(
        synchronize_session=False
    )

    user.password_hash = hash_password(req.password)
    user.is_active = True
    user.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(user)

    logger.info("created an account for %s as %s", user.email, user.role)

    return UserResponse(user=_user_dto(user))


@router.post(
    "/request-access",
    response_model=AccessRequestSubmittedResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
@limiter.limit(LOGIN_RATE_LIMIT)
def request_access(
    request: Request,
    req: AccessRequestRequest,
    db: Session = Depends(get_db),
    _csrf: None = Depends(require_csrf),
) -> AccessRequestSubmittedResponse:
    """Somebody registering for an account, for an administrator to decide on.

    This is the middle road between the two shapes that were both wrong. An open
    registration form lets anyone who can type a colleague's company address claim
    that address, because a domain check only proves they typed it. Having no form at
    all means only somebody who already knows an administrator can get in.

    So the form is public and the account is not. This creates a request, not a user:
    no `users` row exists until an administrator approves one, so nothing here can be
    logged into, and nothing here can set a role — the field is not on the model, so
    a client that sends one has it ignored rather than honoured.

    The password is chosen now and stored as a hash on the request. Approval moves
    that hash onto the new account and activates it, so the person signs in with
    the password they already picked rather than through a second invitation link.

    No role on the request model is the whole security property. An administrator is
    granted by an administrator.
    """
    existing_user = find_user_by_email(db, req.email)

    if existing_user is not None and existing_user.is_active:
        # Said plainly, because telling somebody with an account to go and sign in is
        # more use than pretending not to know who they are.
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="There is already an account for that address. Sign in instead.",
        )

    if find_open_access_request(db, req.email) is not None:
        # Idempotent rather than a duplicate row: asking twice should not put two
        # lines in an administrator's queue for one person.
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="You have already asked for access. An administrator will review it.",
        )

    db.add(
        AccessRequest(
            id=secrets.token_urlsafe(16),
            name=req.name,
            email=req.email,
            status="pending",
            password_hash=hash_password(req.password),
        )
    )
    db.commit()

    logger.info("access requested by %s", req.email)

    return AccessRequestSubmittedResponse()


def _access_request_dto(request_row: AccessRequest) -> AccessRequestDto:
    return AccessRequestDto(
        id=request_row.id,
        name=request_row.name,
        email=request_row.email,
        status=request_row.status,
        requested_at=request_row.requested_at,
        decided_at=request_row.decided_at,
    )


@router.get("/requests", response_model=AccessRequestListResponse)
def list_access_requests(
    db: Session = Depends(get_db),
    _admin: User = Depends(require_admin),
    _csrf: None = Depends(require_csrf),
) -> AccessRequestListResponse:
    """Everybody who has asked for an account, whoever is still waiting.

    Pending first, newest first within each group, because the queue is the reason
    the screen exists; decided ones sit underneath as a record.
    """
    rows = db.scalars(
        select(AccessRequest).order_by(
            # Pending ahead of decided, rather than purely by date: an administrator
            # opens this to act, and the decided ones are history.
            case((AccessRequest.status == "pending", 0), else_=1),
            AccessRequest.requested_at.desc(),
        )
    ).all()

    return AccessRequestListResponse(requests=[_access_request_dto(row) for row in rows])


def _pending_request_or_409(db: Session, request_id: str) -> AccessRequest:
    """The request, if it is still open to a decision.

    A decision on an already-decided request is a 409 rather than a silent no-op,
    because the alternative is an administrator approving something that happened last
    week and being told nothing was wrong.
    """
    row = db.get(AccessRequest, request_id)

    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="That access request no longer exists.",
        )

    if row.status != "pending":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"That request has already been {row.status}.",
        )

    return row


@router.post("/requests/{request_id}/approve", response_model=AccessRequestDecisionResponse)
def approve_access_request(
    request_id: str,
    req: AccessRequestDecisionRequest,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
    _csrf: None = Depends(require_csrf),
) -> AccessRequestDecisionResponse:
    """Approves a request, which creates the account ready to sign in.

    The role comes from this request, not from the person who asked. That is the one
    thing an approval decides that the requester was never allowed to state.

    The password was chosen at registration and stored as a hash on the request, so
    approval moves it onto the account and activates it: the person signs in with
    what they already picked, and no invitation link is needed. Requests made before
    the register form grew password fields carry no hash and fall back to the
    invitation flow, so old rows in the queue still resolve.
    """
    row = _pending_request_or_409(db, request_id)

    existing_user = find_user_by_email(db, row.email)

    if existing_user is not None and existing_user.is_active:
        # Somebody approved the invitation directly while this request sat in the
        # queue. The account exists, so the request is answered rather than turned
        # into a second one.
        row.status = "approved"
        row.decided_at = datetime.now(timezone.utc)
        row.decided_by = admin.id
        db.commit()

        return AccessRequestDecisionResponse(
            request=_access_request_dto(row),
            invite_link="",
            token="",
            expires_at="",
        )

    if row.password_hash:
        user = existing_user
        if user is None:
            user = User(
                id=secrets.token_urlsafe(16),
                email=row.email,
                name=row.name,
                role=req.role,
                password_hash=row.password_hash,
                is_active=True,
            )
            db.add(user)
        else:
            # Invited directly and never accepted: reuse the row so the id an
            # outstanding invitation points at stays valid, drop that invitation
            # since there is no longer any link to follow, and activate with the
            # password they chose themselves.
            user.name = row.name
            user.role = req.role
            user.password_hash = row.password_hash
            user.is_active = True
            user.updated_at = datetime.now(timezone.utc)
            db.query(Invite).filter(
                Invite.user_id == user.id, Invite.used_at.is_(None)
            ).delete(synchronize_session=False)

        row.status = "approved"
        row.decided_at = datetime.now(timezone.utc)
        row.decided_by = admin.id
        row.invite_token = None
        db.commit()
        db.refresh(user)

        logger.info("approved %s as %s; account active with chosen password", user.email, user.role)

        return AccessRequestDecisionResponse(
            request=_access_request_dto(row),
            invite_link="",
            token="",
            expires_at="",
        )

    user, token, expires_at = provision_pending_user(
        db, row.name, row.email, req.role, admin.id
    )
    link = invite_link_for(token)

    row.status = "approved"
    row.decided_at = datetime.now(timezone.utc)
    row.decided_by = admin.id
    row.invite_token = token
    db.commit()

    logger.info("approved %s as %s; invite link: %s", user.email, user.role, link)

    return AccessRequestDecisionResponse(
        request=_access_request_dto(row),
        invite_link=link,
        token=token,
        expires_at=expires_at.isoformat(),
    )


@router.post(
    "/requests/{request_id}/decline",
    response_model=AccessRequestDecisionResponse,
)
def decline_access_request(
    request_id: str,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
    _csrf: None = Depends(require_csrf),
) -> AccessRequestDecisionResponse:
    """Turns a request down, which provisions nothing.

    Declining is a real answer and is recorded as one: the request leaves the queue
    and the person can ask again, because a declined request does not block a later
    one.
    """
    row = _pending_request_or_409(db, request_id)
    row.status = "declined"
    row.decided_at = datetime.now(timezone.utc)
    row.decided_by = admin.id
    db.commit()

    logger.info("declined the access request from %s", row.email)

    return AccessRequestDecisionResponse(
        request=_access_request_dto(row),
        invite_link="",
        token="",
        expires_at="",
    )


@router.get("/invite/{token}", response_model=InvitePreviewResponse)
def preview_invite(token: str, db: Session = Depends(get_db)) -> InvitePreviewResponse:
    """What this invitation is for, so the accept screen can pre-fill itself.

    Unauthenticated, because the person following an emailed link has no session
    yet. That is why it only echoes back what the invitation itself already carries
    in the URL.
    """
    invite = _usable_invite_or_404(db, token)
    user = db.get(User, invite.user_id)

    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=INVALID_INVITE)

    return InvitePreviewResponse(
        name=user.name,
        email=user.email,
        role=user.role,
        expires_at=invite.expires_at.isoformat(),
    )


@router.post("/accept-invite", response_model=UserResponse)
@limiter.limit(LOGIN_RATE_LIMIT)
def accept_invite(
    request: Request,
    response: Response,
    req: AcceptInviteRequest,
    db: Session = Depends(get_db),
    _csrf: None = Depends(require_csrf),
) -> UserResponse:
    """Turns an invitation into a working account, and signs the person in.

    The password is hashed, the invitation is marked used and the account is
    activated in one commit, so there is no window where an account exists with a
    password but the invitation still works.
    """
    invite = _usable_invite_or_404(db, req.token)
    user = db.get(User, invite.user_id)

    if user is None or user.is_active:
        # An invitation that survived but whose account did not. Reported as the
        # same invalid invitation rather than as a server fault.
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=INVALID_INVITE)

    user.password_hash = hash_password(req.password)
    user.is_active = True
    user.updated_at = datetime.now(timezone.utc)
    invite.used_at = datetime.now(timezone.utc)
    db.commit()

    set_session_cookies(response, user, db)
    set_csrf_cookie(response)
    logger.info("activated %s (%s) from an invitation", user.email, user.role)

    return UserResponse(user=_user_dto(user))


@router.post("/bootstrap-admin", response_model=UserResponse, status_code=status.HTTP_201_CREATED)
@limiter.limit(LOGIN_RATE_LIMIT)
def bootstrap_admin(
    request: Request,
    response: Response,
    req: BootstrapAdminRequest,
    db: Session = Depends(get_db),
    _csrf: None = Depends(require_csrf),
) -> UserResponse:
    """Creates the first administrator, and only the first.

    An invite-only system cannot bootstrap itself: the first administrator cannot
    be invited by anybody, because inviting requires being one. This is the way out,
    and it is deliberately narrow:

    - It does nothing at all once any administrator exists, so it cannot be used to
      add accounts later even by somebody who still has the key.
    - It cannot create a non-admin, so it cannot become a back door to a user
      account.
    - It needs `AUTH_BOOTSTRAP_KEY`, which is a different secret from the JWT
      signing key, so being handed one does not mean being handed token minting.
    - It is rate limited like a sign-in.

    `python -m app.bootstrap_admin` does the same job with no HTTP surface at all,
    and is the better answer wherever the shell is available. This exists because
    the shell is not always available.
    """
    if settings.is_production and not settings.auth_bootstrap_key.strip():
        logger.error("bootstrap refused: AUTH_BOOTSTRAP_KEY is not set")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Bootstrapping is disabled on this deployment.",
        )

    admins = db.scalar(select(func.count(User.id)).where(User.role == "admin")) or 0

    if admins:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="An administrator already exists. Use the invitation flow.",
        )

    # Compared rather than checked for presence, and the failure is indistinguishable
    # from any other rejection so the endpoint cannot be probed for validity.
    if not secrets.compare_digest(req.bootstrap_key, settings.auth_bootstrap_key.strip()):
        logger.warning("rejected bootstrap attempt with a wrong key")
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Bootstrap is not available.")

    user = User(
        id=secrets.token_urlsafe(16),
        email=req.email,
        name=req.name,
        role="admin",
        password_hash=hash_password(req.password),
        is_active=True,
    )
    db.add(user)
    db.commit()

    set_session_cookies(response, user, db)
    set_csrf_cookie(response)
    logger.info("bootstrapped the first administrator: %s", user.email)

    return UserResponse(user=_user_dto(user))


# --------------------------------------------------------------------------- #
# Managing the accounts that exist.                                             #
# --------------------------------------------------------------------------- #

# How many rows one page of the accounts list carries. Fixed rather than sent by the
# client so the page size is a decision made once, and so a caller cannot ask for
# every account in the system in one response.
USERS_PAGE_SIZE = 10


@router.get("/users", response_model=UserListResponse)
def list_users(
    page: int = Query(default=1, ge=1),
    _admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> UserListResponse:
    """Every account, a page at a time, newest first. Administrators only."""
    total = db.scalar(select(func.count(User.id))) or 0
    pages = max(1, -(-total // USERS_PAGE_SIZE))
    current = min(page, pages)

    rows = db.scalars(
        select(User)
        .order_by(User.created_at.desc(), User.id)
        .offset((current - 1) * USERS_PAGE_SIZE)
        .limit(USERS_PAGE_SIZE)
    ).all()

    return UserListResponse(
        users=[
            UserSummaryDto(
                id=row.id,
                name=row.name,
                email=row.email,
                role=row.role,
                is_active=row.is_active,
                created_at=row.created_at,
            )
            for row in rows
        ],
        total=total,
        page=current,
        per_page=USERS_PAGE_SIZE,
        pages=pages,
    )


def _user_or_404(db: Session, user_id: str) -> User:
    user = db.get(User, user_id)

    if user is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="That account no longer exists."
        )

    return user


def _refuse_self(target: User, admin: User, action: str) -> None:
    """Refuses an administrator acting on their own account.

    Deleting, demoting or deactivating yourself ends with nobody able to
    administer the system, and the bootstrap route is refused once any
    administrator exists — so in practice the deployment is finished. Refused
    with a 409 rather than quietly ignored.
    """
    if target.id != admin.id:
        return

    raise HTTPException(
        status_code=status.HTTP_409_CONFLICT,
        detail=f"You cannot {action} your own account. Ask another administrator to do it.",
    )


@router.patch("/users/{user_id}", response_model=UserSummaryDto)
def update_user(
    user_id: str,
    req: UserUpdateRequest,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
    _csrf: None = Depends(require_csrf),
) -> UserSummaryDto:
    """Corrects an account: name, address, role, or whether it is on.

    Every field is optional and independent. An address change is refused if it
    is already somebody else's, and acting on your own account the fatal ways is
    refused by the same guard as deleting it.
    """
    user = _user_or_404(db, user_id)

    if req.email is not None and req.email != user.email:
        clash = find_user_by_email(db, req.email)

        if clash is not None and clash.id != user.id:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Another account already uses that address.",
            )

    if req.role is not None and req.role != "admin":
        _refuse_self(user, admin, "demote")

    if req.is_active is False:
        _refuse_self(user, admin, "deactivate")

    if req.name is not None:
        user.name = req.name
    if req.email is not None:
        user.email = req.email
    if req.role is not None:
        user.role = req.role
    if req.is_active is not None:
        user.is_active = req.is_active

    user.updated_at = datetime.now(timezone.utc)
    db.commit()

    logger.info("administrator updated %s by %s", user.email, admin.email)

    return UserSummaryDto(
        id=user.id,
        name=user.name,
        email=user.email,
        role=user.role,
        is_active=user.is_active,
        created_at=user.created_at,
    )


@router.delete("/users/{user_id}", response_model=StatusResponse)
def delete_user(
    user_id: str,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
    _csrf: None = Depends(require_csrf),
) -> StatusResponse:
    """Removes an account, and everything belonging to it.

    Their conversations go with them rather than being orphaned, and their
    sessions and invitations with those. From that moment they cannot sign in.
    """
    user = _user_or_404(db, user_id)
    _refuse_self(user, admin, "delete")

    for conversation in db.scalars(
        select(Conversation).where(Conversation.user_id == user.id)
    ).all():
        db.query(Message).filter(Message.conversation_id == conversation.id).delete(
            synchronize_session=False
        )
        db.delete(conversation)

    db.query(RefreshSession).filter(RefreshSession.user_id == user.id).delete()
    db.query(Invite).filter(Invite.user_id == user.id).delete()
    db.query(AccessRequest).filter(AccessRequest.email == user.email).delete()

    email = user.email
    db.delete(user)
    db.commit()

    logger.info("administrator deleted the account %s", email)

    return StatusResponse(status="deleted")


@router.post("/users/{user_id}/password", response_model=StatusResponse)
def reset_user_password(
    user_id: str,
    req: PasswordResetRequest,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
    _csrf: None = Depends(require_csrf),
) -> StatusResponse:
    """Sets a new password for somebody locked out of their account.

    Every live session is revoked with it: a password reset that leaves old
    sessions running resets nothing. The administrator hands the new password
    over themselves — there is no mail service to deliver a link with.
    """
    user = _user_or_404(db, user_id)

    user.password_hash = hash_password(req.password)
    user.is_active = True
    user.updated_at = datetime.now(timezone.utc)

    revoke_all_sessions(db, user.id)
    db.commit()

    logger.info("administrator reset the password for %s", user.email)

    return StatusResponse(status="password-reset")


def _usable_invite_or_404(db: Session, token: str) -> Invite:
    """The invitation this token names, if it is still good. A 404 otherwise.

    All three ways of being unusable — unknown, expired, already used — answer
    identically, so a dead link reveals nothing about the accounts that exist.
    """
    invite = db.get(Invite, token)

    if invite is None or invite.used_at is not None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=INVALID_INVITE)

    expires_at = invite.expires_at

    # SQLite hands back naive datetimes even for a timezone-aware column, so the
    # comparison is normalised. Comparing a naive value to an aware one raises, and
    # the invitation would then depend on which database happens to be deployed.
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)

    if expires_at <= datetime.now(timezone.utc):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=INVALID_INVITE)

    return invite