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
    select,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship, sessionmaker

from app.config import settings

_args = {"check_same_thread": False} if settings.database_url.startswith("sqlite") else {}
engine = create_engine(settings.database_url, connect_args=_args, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False)


class Base(DeclarativeBase):
    pass


class Conversation(Base):
    __tablename__ = "conversations"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    client_id: Mapped[str] = mapped_column(String(64), index=True)
    # The account that owns it, and the only thing that decides that.
    #
    # Ownership used to be `client_id` alone, which is a value the browser
    # supplies and the server never checks against anything. Two accounts on one
    # browser therefore opened each other's threads. The account is known to the
    # server from the session, so it is what a conversation belongs to;
    # `client_id` is still recorded beside it because the client sends it and
    # the sidebar groups by it, but it grants nothing.
    #
    # Nullable only so rows written before this column existed still open; they
    # are readable by nobody, because a conversation with no known owner cannot
    # be shown to a caller without guessing. There is nothing to migrate them
    # onto. Added to live tables by `_ensure_missing_columns` on startup.
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

    A row here is a *request*, not a half-made account. No user row exists until an
    administrator approves one, so a request cannot be logged into and cannot be
    escalated by asking for a role nobody granted.
    """

    __tablename__ = "access_requests"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    email: Mapped[str] = mapped_column(String(255), index=True)
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
    # bcrypt hash of the password chosen at registration. Set for every request
    # made since the register form grew password fields; null for older rows,
    # which fall back to the invitation flow on approval. Never the plaintext:
    # a queue an administrator reads must not contain a password anybody could.
    password_hash: Mapped[str | None] = mapped_column(
        String(255), nullable=True, default=None
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
    """The conversation, but only if it belongs to the calling account.

    Conversations carry no shared secret, so ownership is the whole boundary:
    an account that knows an id it does not own is answered exactly like one
    that guessed an id that never existed, instead of being told it exists.
    """
    conversation = db.get(Conversation, conversation_id)
    if conversation is None or conversation.user_id != user_id:
        return None
    return conversation


def list_owned_conversations(db: SessionLocal, user_id: str) -> list[Conversation]:
    """This account's conversations with something in them, most recently active first.

    Only conversations holding at least one message are listed: a row exists from
    the moment it is created, so an abandoned one would otherwise sit in the
    sidebar forever as a thread nobody asked for.
    """
    return list(
        db.scalars(
            select(Conversation)
            .where(Conversation.user_id == user_id, Conversation.messages.any())
            .order_by(Conversation.updated_at.desc())
        ).all()
    )


def touch(db: SessionLocal, conversation: Conversation) -> None:
    conversation.updated_at = datetime.now(timezone.utc)
    db.commit()


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
    Base.metadata.create_all(engine)
    _ensure_missing_columns()
    _ensure_missing_indexes()


def _ensure_missing_columns() -> None:
    """Adds columns that `create_all` cannot.

    `create_all` only creates tables that do not exist yet; it never alters a
    table that is already there. The deployed database was created before the
    auth tables (and the `name` column on `users`) existed, so a deploy that
    only calls `create_all` leaves a stale `users` table behind and every
    sign-in fails with `UndefinedColumn: column users.name does not exist`.

    This walks every mapped table, compares the model's columns against the
    ones the database actually has, and adds whatever is missing with a plain
    `ADD COLUMN`. Columns are added nullable (no `NOT NULL` constraint) even
    when the model declares them required, because adding a `NOT NULL` column
    without a default to a non-empty table fails on PostgreSQL — and a stale
    row with a `NULL` there is a data problem, not a reason to refuse startup.
    Idempotent: a column that already exists is skipped. The `try/except`
    around the `ALTER` covers the race where two workers start at once and
    both see the column as missing — the loser treats "already exists" as
    success rather than crashing startup.
    """
    import logging

    from sqlalchemy import inspect, text
    from sqlalchemy.exc import DBAPIError, OperationalError, ProgrammingError

    logger = logging.getLogger(__name__)
    inspector = inspect(engine)
    existing_tables = set(inspector.get_table_names())

    for table in Base.metadata.tables.values():
        if table.name not in existing_tables:
            continue  # `create_all` just created it with the full shape.
        existing_columns = {
            column["name"] for column in inspector.get_columns(table.name)
        }
        for column in table.columns:
            if column.name in existing_columns:
                continue
            column_type = column.type.compile(dialect=engine.dialect)
            try:
                with engine.begin() as connection:
                    connection.execute(
                        text(
                            f'ALTER TABLE "{table.name}" '
                            f'ADD COLUMN "{column.name}" {column_type}'
                        )
                    )
            except (OperationalError, ProgrammingError, DBAPIError) as exc:
                # Re-read: if the column is there now, another worker won the
                # race — that is success. Anything else is re-raised.
                refreshed = {
                    c["name"]
                    for c in inspect(engine).get_columns(table.name)
                }
                if column.name in refreshed:
                    continue
                raise RuntimeError(
                    f"could not add missing column "
                    f"{table.name}.{column.name}: {exc}"
                ) from exc
            logger.warning(
                "migrated table %s: added missing column %s",
                table.name,
                column.name,
            )


def _ensure_missing_indexes() -> None:
    """Creates indexes that `create_all` skipped on pre-existing tables.

    Like columns, an index on a table that already existed is never created by
    `create_all` — the table is left exactly as it was. A missing index cannot
    cause a 500 (the query still runs, just slower), but a missing index on a
    hot lookup (`users.email`, `refresh_sessions.family_id`,
    `conversations.client_id`, …) turns every sign-in into a full table scan,
    so they are created here. `IF NOT EXISTS` makes this idempotent and safe
    under concurrent startup on both PostgreSQL and SQLite.
    """
    import logging

    from sqlalchemy import text

    logger = logging.getLogger(__name__)
    for table in Base.metadata.tables.values():
        for index in table.indexes:
            # `index.name` is always set: SQLAlchemy generates one
            # (`ix_<table>_<column>`) for every `index=True` column.
            column_list = ", ".join(f'"{c.name}"' for c in index.columns)
            statement = (
                f'CREATE INDEX IF NOT EXISTS "{index.name}" '
                f'ON "{table.name}" ({column_list})'
            )
            with engine.begin() as connection:
                connection.execute(text(statement))
                logger.debug("ensured index %s", index.name)