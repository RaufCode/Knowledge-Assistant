"""Request and response shapes for the auth layer.

The company email rule lives here rather than in the router, so it cannot drift
between the two routes that take an address. A validator is also the right place
for it: a non-company address is rejected as a 422 before any database lookup, any
bcrypt work, or any decision about whether the account exists.

Nothing in this module returns a password or a token. That is enforced by the
response models rather than by discipline at the call site, because the response
models are the only thing standing between a `User` row and a JSON body.
"""

from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, EmailStr, Field, field_validator

from app.config import settings
from app.security import has_company_domain, normalize_email, sanitize_text

Role = Literal["employee", "admin"]

# A trimmed, sanitised free-text field. The bound is applied after sanitisation, so
# it measures what will actually be stored rather than what arrived over the wire.
NameStr = Annotated[str, Field(min_length=1, max_length=120)]

# bcrypt reads at most 72 bytes; the policy floor is 6 characters and there are
# no character-class requirements.
MIN_PASSWORD_LENGTH = 6
MAX_PASSWORD_LENGTH = 128


def _clean_name(value: str) -> str:
    cleaned = sanitize_text(value)

    if not cleaned:
        raise ValueError("Enter a name")

    return cleaned


def _company_email(value: str) -> str:
    """Normalise, then require the company domain.

    `EmailStr` has already rejected anything that is not a well-formed address, so
    the only question left here is whose it is.
    """
    email = normalize_email(str(value))

    if not has_company_domain(email):
        raise ValueError(f"Use your company email address (@{settings.email_domain})")

    return email


def check_password_policy(value: str) -> str:
    """The password policy, enforced here rather than in the browser.

    Length only: anything from 6 to 128 characters is accepted, with no
    character-class requirements. Registration and `accept-invite` are the two
    routes that set a password, so these are the two places one can enter the
    database.
    """
    if len(value) < MIN_PASSWORD_LENGTH:
        raise ValueError(f"Use at least {MIN_PASSWORD_LENGTH} characters")

    if len(value) > MAX_PASSWORD_LENGTH:
        raise ValueError(f"Use at most {MAX_PASSWORD_LENGTH} characters")

    return value


# ------------------------------------------------------------------ responses --


class UserDto(BaseModel):
    """The signed-in person. Everything the frontend needs and nothing more."""

    id: str
    name: str
    email: str
    role: Role


class UserResponse(BaseModel):
    user: UserDto


class UserSummaryDto(BaseModel):
    """One account, as an administrator's list shows it."""

    id: str
    name: str
    email: str
    role: Role
    is_active: bool
    created_at: datetime


class UserListResponse(BaseModel):
    """One page of accounts, with its own page count so the pager cannot disagree."""

    users: list[UserSummaryDto]
    total: int
    page: int
    per_page: int
    pages: int


class UserUpdateRequest(BaseModel):
    """Corrections to an account. Every field optional and independent."""

    name: NameStr | None = None
    email: EmailStr | None = None
    role: Role | None = None
    is_active: bool | None = None


class PasswordResetRequest(BaseModel):
    """A new password, chosen by an administrator for somebody locked out."""

    password: str = Field(min_length=1, max_length=MAX_PASSWORD_LENGTH)

    @field_validator("password")
    @classmethod
    def check_policy(cls, value: str) -> str:
        return check_password_policy(value)


class CsrfResponse(BaseModel):
    """The double-submit token, echoed so the caller need not read the cookie.

    Only ever a CSRF token: it grants nothing and is worthless without the matching
    `httpOnly` session cookies.
    """

    csrf_token: str


class InviteResponse(BaseModel):
    """What an administrator needs in order to pass an invitation on.

    `invite_link` is returned rather than emailed because no mail service is
    configured yet. Returning it makes the flow usable and testable without
    pretending anything was sent: the administrator copies the link.
    """

    invite_link: str
    token: str
    expires_at: str
    user: UserDto


class InvitePreviewResponse(BaseModel):
    """Enough of the invitation for the accept screen to pre-fill itself.

    Carries the name and address the account will be created with. That is not a
    leak to worry about: the holder of this token is the person the invitation was
    addressed to, and the whole point of the screen is to show them what they are
    agreeing to create.
    """

    name: str
    email: str
    role: Role
    expires_at: str


class StatusResponse(BaseModel):
    status: str


# ------------------------------------------------------------------- requests --


class LoginRequest(BaseModel):
    email: EmailStr
    # No minimum: a 1-character submission is a wrong password and should be
    # answered as one, not as a validation error that confirms this field exists.
    # The policy floor applies when a password is *set*, not when one is checked.
    password: str = Field(min_length=1, max_length=MAX_PASSWORD_LENGTH)

    @field_validator("email")
    @classmethod
    def check_company_domain(cls, value: str) -> str:
        return _company_email(value)


class AcceptInviteRequest(BaseModel):
    token: str = Field(min_length=16, max_length=64)
    password: str = Field(min_length=1, max_length=MAX_PASSWORD_LENGTH)

    @field_validator("password")
    @classmethod
    def check_policy(cls, value: str) -> str:
        # The minimum length is applied here rather than by `min_length=1` so that
        # the message is the policy and not a bare field-length complaint.
        return check_password_policy(value)


class InviteRequest(BaseModel):
    name: NameStr
    email: EmailStr
    role: Role = "employee"

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        return _clean_name(value)

    @field_validator("email")
    @classmethod
    def check_company_domain(cls, value: str) -> str:
        return _company_email(value)


class BootstrapAdminRequest(InviteRequest):
    """The request that can create the very first administrator.

    `bootstrap_key` is a separate secret from the JWT signing key on purpose: an
    operator who needed to be handed one of these should not thereby be handed the
    ability to mint tokens for anybody.
    """

    password: str = Field(min_length=1, max_length=MAX_PASSWORD_LENGTH)
    bootstrap_key: str = Field(min_length=1, max_length=200)

    @field_validator("password")
    @classmethod
    def check_policy(cls, value: str) -> str:
        return check_password_policy(value)

class CreateAccountRequest(BaseModel):
    """An administrator creating an account outright, with its password.

    The password is set here rather than by the person it belongs to, which is the
    one thing this request gives away that the invitation flow does not: whoever
    fills it in knows the password. It is a deliberate trade, made for a deployment
    with no mail service — there is otherwise no way to deliver a link, so the
    alternatives are handing over credentials or handing over nothing.

    The policy is the same one an invited person sets their own password against, so
    an administrator cannot mint an account that could not have been created any other
    way.
    """

    name: NameStr
    email: EmailStr
    role: Role = "employee"
    password: str = Field(min_length=1, max_length=MAX_PASSWORD_LENGTH)

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        return _clean_name(value)

    @field_validator("email")
    @classmethod
    def check_company_domain(cls, value: str) -> str:
        return _company_email(value)

    @field_validator("password")
    @classmethod
    def check_policy(cls, value: str) -> str:
        return check_password_policy(value)


class AccessRequestRequest(BaseModel):
    """Somebody registering for an account.

    No `role`, and that is deliberate rather than an oversight. A requester naming
    their own role is asking for the one thing an administrator exists to decide, so
    the field is not on the model at all — a client sending one is ignored, not
    honoured. The role is chosen by whoever approves it.

    The password is chosen here, stored as a hash on the request, and moved onto
    the account when an administrator approves it. Nothing can sign in with it
    until then: no `users` row exists before approval.
    """

    name: NameStr
    email: EmailStr
    password: str = Field(min_length=1, max_length=MAX_PASSWORD_LENGTH)

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        return _clean_name(value)

    @field_validator("email")
    @classmethod
    def check_company_domain(cls, value: str) -> str:
        return _company_email(value)

    @field_validator("password")
    @classmethod
    def check_policy(cls, value: str) -> str:
        return check_password_policy(value)


class AccessRequestDto(BaseModel):
    """One request, as an administrator sees it."""

    id: str
    name: str
    email: str
    status: Literal["pending", "approved", "declined"]
    requested_at: datetime
    decided_at: datetime | None = None


class AccessRequestListResponse(BaseModel):
    requests: list[AccessRequestDto]


class AccessRequestSubmittedResponse(BaseModel):
    """The answer to a request, which says nothing about anybody else's.

    Deliberately the same shape whether or not the address already had an account,
    a pending invitation or an open request. This endpoint is unauthenticated, so a
    response that varied would be a way to ask it who works here.
    """

    status: Literal["received"] = "received"


class AccessRequestDecisionResponse(BaseModel):
    """An approval, carrying the invitation link that approval produced.

    The link comes back here for the same reason it comes back from `/api/auth/invite`:
    there is no mail service configured, so the administrator copies it and sends it.
    """

    request: AccessRequestDto
    invite_link: str
    token: str
    expires_at: str


class AccessRequestDecisionRequest(BaseModel):
    """What to decide, and for an approval, what they will be."""

    # Only an approval sets a role, and only an administrator ever sends this, so
    # there is no path here from a requester's own request to a granted admin role.
    role: Role = "employee"
