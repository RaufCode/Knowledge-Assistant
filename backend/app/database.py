import logging
from datetime import datetime, timezone
from uuid import uuid4

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    String,
    Text,
    create_engine,
    inspect,
    select,
    text,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship, sessionmaker

from app.config import settings

logger = logging.getLogger(__name__)

_args = {"check_same_thread": False} if settings.database_url.startswith("sqlite") else {}
engine = create_engine(settings.database_url, connect_args=_args, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False)


class Base(DeclarativeBase):
    pass


class Conversation(Base):
    __tablename__ = "conversations"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    # The browser this conversation was started from. Kept for continuity — it is
    # what the client sends and what the sidebar groups by — but NOT what decides
    # who may read it. See `user_id`.
    client_id: Mapped[str] = mapped_column(String(64), index=True)
    # The account that owns it, and the only thing that decides that.
    #
    # Ownership used to be `client_id` alone, which is a value the browser supplies
    # and the server never checks against anything. That is a bearer token with no
    # expiry: two people sharing a browser profile, a copied localStorage value or a
    # single sign-on that hands the same id to two accounts all see each other's
    # threads, and one of them can delete them. The account is known to the server
    # from the session cookie, so it is the account the conversation belongs to.
    #
    # Nullable only so that rows written before this column existed still open; they
    # are not readable by anybody, because a conversation with no known owner cannot
    # be shown to a caller without guessing. There is nothing to migrate them onto.
    user_id: Mapped[str | None] = mapped_column(String(64), nullable=True, default=None, index=True)
    title: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )

    messages: Mapped[list["Message"]] = relationship(
        back_populates="conversation",
        cascade="all, delete-orphan",
        order_by="Message.created_at",
    )


class Message(Base):
    __tablename__ = "messages"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    conversation_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("conversations.id", ondelete="CASCADE"), index=True
    )
    role: Mapped[str] = mapped_column(String(16))
    content: Mapped[str] = mapped_column(Text)
    sources: Mapped[list | None] = mapped_column(JSON, nullable=True, default=None)
    # How the assistant answered, on an assistant message and null on a question.
    #
    # Stored rather than re-derived, because four different replies carry no sources
    # at all: a grounded answer, a greeting, a confidentiality notice and a genuine
    # gap in the corpus. Sources alone cannot tell those apart, so a thread reopened
    # from the database would render a greeting as a failed document search — the
    # same answer shown two different ways depending on when it was read.
    status: Mapped[str | None] = mapped_column(String(16), nullable=True, default=None)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )

    conversation: Mapped["Conversation"] = relationship(back_populates="messages")


class User(Base):
    """An account, which exists in two states.

    A row is written when an administrator invites somebody and it has no password
    yet: that is the pending state, and it cannot sign in. Accepting the invitation
    hashes a password into it and activates it. Keeping both states in one row
    rather than in a separate invitations table means the address an invite was
    sent to is already reserved when the invite goes out, so two administrators
    cannot both invite the same person and have both links work.
    """

    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(120))
    role: Mapped[str] = mapped_column(String(16), default="employee")
    # Null while the account is pending. The type allows it deliberately: a
    # pending row with a password would be an active account that happens to be
    # disabled, which is a different thing with different recovery rules.
    password_hash: Mapped[str | None] = mapped_column(String(255), nullable=True, default=None)
    is_active: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )


class Invite(Base):
    """A single-use, expiring claim on one pending account.

    The token is the row's primary key rather than a hash of one, because it is
    generated here, stored nowhere else, and never re-derived. What it does not do
    is extend the account: accepting it changes the user row and marks this token
    used in the same transaction, so a link that is opened twice does the work
    once.
    """

    __tablename__ = "invites"

    token: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    # Kept as a plain id rather than a relationship: the row that invited somebody
    # is not deleted when they leave, and an invitation outliving the inviter is
    # ordinary enough that it should not raise.
    invited_by: Mapped[str | None] = mapped_column(
        String(64), ForeignKey("users.id", ondelete="SET NULL"), nullable=True, default=None
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    used_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, default=None
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )


class RefreshSession(Base):
    """The server-side record of one issued refresh token.

    The JWT is the proof, but a proof nobody can withdraw is not a session. This
    row is what makes logout, rotation and theft detection possible: the token's
    `jti` is this id, so presenting a token is presenting a row, and the row
    remembers whether it has already been exchanged.
    """

    __tablename__ = "refresh_sessions"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    # Every token descended from one login shares a family, which is the unit that
    # gets revoked. Reuse detection cannot tell a stolen token from a stale one, so
    # it revokes the whole family rather than guessing.
    family_id: Mapped[str] = mapped_column(String(64), index=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    rotated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, default=None
    )
    revoked_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, default=None
    )


class AccessRequest(Base):
    """Somebody asking for an account, waiting on an administrator to say yes.

    Self-service for the person and control for the administrator, which is the
    whole point of it. The alternative shapes both had a cost: an open registration
    form lets anyone who can type a colleague's company address claim that address,
    because a domain check only proves they typed it, and a request form with no
    approval step is the same thing with more typing.

    A row here is a *request*. It is not authority over anything: it carries the role
    the person asked for so an administrator can see and change it, and the role
    that is actually granted is the one on the approval, which only an administrator
    sends. Asking for `admin` is not a smaller step towards `admin`.
    """

    __tablename__ = "access_requests"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    email: Mapped[str] = mapped_column(String(255), index=True)
    # What the person asked for. Advisory only, and shown to the administrator as
    # the thing to check rather than the thing to grant.
    requested_role: Mapped[str | None] = mapped_column(
        String(16), nullable=True, default=None
    )
    # `pending` until an administrator decides. Kept as a plain string rather than
    # an enum so the column can grow a state without a migration.
    status: Mapped[str] = mapped_column(String(16), default="pending", index=True)
    requested_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    decided_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, default=None
    )
    # Which administrator decided it. Set null if they later leave: the decision
    # stands even when the person who made it does not.
    decided_by: Mapped[str | None] = mapped_column(
        String(64), ForeignKey("users.id", ondelete="SET NULL"), nullable=True, default=None
    )
    # The invitation approving it produced, so the request and the link that came out
    # of it can be traced together. Null until approved.
    invite_token: Mapped[str | None] = mapped_column(
        String(64), nullable=True, default=None
    )


# Refresh tokens are looked up by user when a family is revoked, and by family
# when one is, so the family column is indexed in the model above; this composite
# index covers the "which sessions does this user still have live" sweep that
# revoking every session at once needs.
Index("ix_refresh_sessions_user_live", RefreshSession.user_id, RefreshSession.revoked_at)


def create_conversation(db: SessionLocal, client_id: str, user_id: str) -> Conversation:
    conversation = Conversation(id=uuid4().hex, client_id=client_id, user_id=user_id)
    db.add(conversation)
    db.commit()
    db.refresh(conversation)
    return conversation


def get_owned_conversation(
    db: SessionLocal, conversation_id: str, user_id: str
) -> Conversation | None:
    """The conversation, but only if the signed-in account owns it.

    Scoped on the account and nothing else. `client_id` used to decide this, which
    meant the caller's own browser id was the boundary: a value the caller supplies,
    never verified, and identical for every account using that browser.

    A conversation carries no shared secret, so a miss is answered exactly like an id
    that never existed, rather than confirming that it does.
    """
    conversation = db.get(Conversation, conversation_id)
    if conversation is None or conversation.user_id != user_id:
        return None
    return conversation


def list_owned_conversations(db: SessionLocal, user_id: str) -> list[Conversation]:
    """Every conversation this account owns, most recently active first.

    The account's own threads and nothing else, so signing in on a second machine
    brings the conversation list with it rather than leaving it on whichever browser
    happened to ask the question.
    """
    return list(
        db.scalars(
            select(Conversation)
            .where(Conversation.user_id == user_id)
            .order_by(Conversation.updated_at.desc())
        ).all()
    )


def touch(db: SessionLocal, conversation: Conversation) -> None:
    conversation.updated_at = datetime.now(timezone.utc)
    db.commit()


def revoke_all_sessions(db: SessionLocal, user_id: str) -> int:
    """Ends every live session for an account, and says how many it ended.

    Used when a password is reset and when an account is deleted. In both cases a
    session that survived would defeat the point: a reset that leaves the old
    sessions running resets nothing, because whoever prompted it — or whoever copied
    the cookie — is still signed in.

    Revoked rather than deleted, so the rows remain as a record that a session once
    existed and was ended deliberately.
    """
    now = datetime.now(timezone.utc)
    live = db.scalars(
        select(RefreshSession).where(
            RefreshSession.user_id == user_id, RefreshSession.revoked_at.is_(None)
        )
    ).all()

    for session in live:
        session.revoked_at = now

    db.commit()

    return len(live)


def get_user(db: SessionLocal, user_id: str) -> User | None:
    """The user with this id, or None.

    Ids come out of a signed token, so an unknown one means the token was signed by
    a key this server no longer holds, and the caller is not signed in.
    """
    return db.get(User, user_id)


def find_user_by_email(db: SessionLocal, email: str) -> User | None:
    """The user with this address, or None.

    Lowercased first, because that is how addresses are stored: the domain is
    case-insensitive by definition and the local part is treated the same way, so
    two spellings of one address must not become two accounts.
    """
    return db.scalar(select(User).where(User.email == email.strip().lower()))


def find_open_access_request(db: SessionLocal, email: str) -> AccessRequest | None:
    """The unanswered request for this address, or None.

    "Open" rather than "latest", because a declined request must not block somebody
    asking again once whatever was wrong with it is fixed.
    """
    return db.scalar(
        select(AccessRequest)
        .where(
            AccessRequest.email == email.strip().lower(),
            AccessRequest.status == "pending",
        )
        .order_by(AccessRequest.requested_at.desc())
        .limit(1)
    )


def revoke_family(db: SessionLocal, family_id: str) -> int:
    """Revokes every live session in one login's family, and says how many.

    Called when a refresh token is presented a second time. The two explanations
    are a stolen cookie and a client that never dropped an old one, and nothing on
    the server can tell them apart, so the only safe answer is to end the whole
    family and make both sides sign in again.
    """
    now = datetime.now(timezone.utc)
    live = db.scalars(
        select(RefreshSession).where(
            RefreshSession.family_id == family_id,
            RefreshSession.revoked_at.is_(None),
        )
    ).all()

    for session in live:
        session.revoked_at = now

    db.commit()

    return len(live)


def init_db() -> None:
    """Create anything missing, then bring existing tables up to the models.

    Two steps because they do different jobs. `create_all` makes tables that do not
    exist; it will not touch one that already does, so a column added to a model
    afterwards is simply absent from a database created before it. The second step
    closes that gap by adding the columns the models now declare and the table does
    not have.
    """
    Base.metadata.create_all(engine)
    add_missing_columns()


def add_missing_columns() -> None:
    """Add any column the models declare that an existing table is missing.

    Additive only, and only for nullable columns, which is the safe half of what a
    schema change can be: nothing is dropped, renamed or retyped, so there is no
    data to lose and no row to rewrite. A column that would need a backfill or a
    non-null constraint is left alone and logged, because inventing a default for
    somebody's data is a decision this function must not make on its own.

    Worth being plain about the limit: this is not a migration framework. It brings
    a database up to date with *added* columns and will say so loudly when it cannot.
    Renames and type changes still need a human, because there is no safe mechanical
    answer to "is this the old `hashed_password` or a new empty one".
    """
    inspector = inspect(engine)
    existing_tables = set(inspector.get_table_names())

    for table in Base.metadata.sorted_tables:
        if table.name not in existing_tables:
            continue

        present = {column["name"] for column in inspector.get_columns(table.name)}

        for column in table.columns:
            if column.name in present:
                continue

            if not column.nullable:
                logger.warning(
                    "not adding %s.%s: it is NOT NULL and needs a backfilled default",
                    table.name,
                    column.name,
                )
                continue

            ddl = column.type.compile(dialect=engine.dialect)

            with engine.begin() as connection:
                connection.execute(
                    text(f'ALTER TABLE {table.name} ADD COLUMN "{column.name}" {ddl}')
                )

            logger.info("added missing column %s.%s", table.name, column.name)