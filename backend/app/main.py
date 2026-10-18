import json
import logging
import threading
from collections.abc import Iterator
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from uuid import uuid4

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from sqlalchemy.orm import Session
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware

from app.auth import router as auth_router
from app.config import settings
from app.database import (
    Conversation,
    Message,
    SessionLocal,
    User,
    assistant_replies,
    cited_chunk_ids,
    cited_documents,
    last_user_message,
    create_conversation,
    get_owned_conversation,
    has_usable_topic,
    init_db,
    last_exchange,
    list_owned_conversations,
    recent_turns,
    says_the_invitation,
    touch,
    unreadable_replies,
)
from app.dependencies import get_current_user, get_db, open_db, require_csrf
from app.rag.engine import (
    Assistant,
    LlmUnavailable,
    PreviousAnswer,
    title_for_first_message,
)
from app.rag.ingest import build_index
from app.rate_limit import limiter, rate_limit_exceeded_handler
from app.schemas_auth import check_password_policy
from app.security import hash_password
from app.schemas import (
    ConversationCreateRequest,
    ConversationCreateResponse,
    ConversationDetailResponse,
    ConversationListResponse,
    ConversationRenameRequest,
    ConversationSummary,
    MessageSendRequest,
)

logger = logging.getLogger(__name__)

state: dict = {}


def seed_development_admin() -> None:
    """Creates a throwaway administrator if one was asked for.

    A fresh checkout has no accounts at all, and without an administrator nothing
    can be invited, so there is a way to ask for one. It is refused in production
    and it logs what it did at warning level, because a seeded administrator is a
    known password that must not survive a deployment.
    """
    email = settings.auth_seed_admin_email.strip().lower()
    password = settings.auth_seed_admin_password

    if not email or not password:
        return

    if settings.is_production:
        logger.error(
            "refusing to seed an administrator: AUTH_SEED_ADMIN_PASSWORD is set on a "
            "production deployment. Remove it and create a real account instead."
        )
        return

    # The same policy the invitation flow enforces, applied here too. A configured
    # password that would be refused if a person typed it should not be the one that
    # quietly creates an administrator.
    try:
        check_password_policy(password)
    except ValueError as rejected:
        logger.error("refusing to seed an administrator: %s", rejected)
        return

    db = SessionLocal()
    try:
        if db.query(User).filter(User.email == email).first() is not None:
            return

        db.add(
            User(
                id=uuid4().hex,
                email=email,
                name=settings.auth_seed_admin_name or "Administrator",
                role="admin",
                password_hash=hash_password(password),
                is_active=True,
            )
        )
        db.commit()
        logger.warning("seeded a development administrator: %s", email)
    finally:
        db.close()


@asynccontextmanager
async def lifespan(app: FastAPI):
    if not settings.has_nvidia_api_key:
        # Reported, not raised: message routes answer 503 and /health reports
        # degraded, so a missing key is visible without a stack trace.
        logger.error("NVIDIA_API_KEY is unset; questions will fail to be answered")
    if not settings.has_nvidia_embedding_api_key:
        # Unlike the generation key this one is fatal: the policy documents are
        # embedded while the index is built, so startup fails without it.
        logger.error("NVIDIA_EMBEDDING_API_KEY is unset; the index cannot be built")
    if not settings.auth_is_usable:
        # Not fatal, so the health endpoint and the index still come up and the
        # problem is reported plainly. Sign-in cannot work until it is set.
        logger.error(
            "AUTH_SECRET_KEY is unset or shorter than 32 characters; sign-in cannot work"
        )
    init_db()
    seed_development_admin()
    index = build_index()  # rebuilt on every start; takes seconds
    state["assistant"] = Assistant(index)
    state["documents"] = sorted(
        {n.metadata["policy_title"] for n in index.docstore.docs.values()}
    )
    yield


app = FastAPI(title="Internal Knowledge Assistant API", lifespan=lifespan)

# The limiter is reached through `app.state`, which is where `slowapi` looks for
# it, and its handler is registered alongside CORS so an exceeded limit comes back
# as JSON with a `Retry-After` rather than as an unhandled error page.
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, rate_limit_exceeded_handler)

app.add_middleware(SlowAPIMiddleware)

# `*` and credentialed requests cannot both be literal: a browser refuses
# `Access-Control-Allow-Origin: *` on a response it is asked to accept cookies
# from, so sign-in would appear to succeed while storing nothing. Where the
# configured origins include `*`, the origin is reflected instead of wildcarded,
# which is the same permissiveness and does work with cookies.
_wildcard = "*" in settings.origins_list

if _wildcard:
    logger.warning(
        "ALLOWED_ORIGINS is '*': any origin may make credentialed requests. "
        "List the frontend origins explicitly outside development."
    )

app.add_middleware(
    CORSMiddleware,
    allow_origins=[] if _wildcard else settings.origins_list,
    allow_origin_regex=".*" if _wildcard else None,
    allow_methods=["*"],
    allow_headers=["*"],
    # Cookies are only sent on a cross-origin request when the response to the
    # preflight says so. Without this the browser drops every Set-Cookie from the
    # auth routes.
    allow_credentials=True,
)

app.include_router(auth_router)


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    """Log the real cause and return JSON, without the cause.

    Without this, any unhandled error reaches the browser as a bare text/plain 500
    carrying no explanation at all, which is what made the original upstream outage so
    hard to diagnose from the outside.

    The exception's type and message go to the log and deliberately **not** into the
    body. A 5xx body here used to read `OperationalError: could not connect...`, which
    tells an attacker how the backend stores its data and tells the person looking at
    the screen nothing they can act on — they cannot fix a dropped connection by
    reading it. The log is where a cause belongs; this body only has to say that
    something went wrong here.
    """
    logger.exception("unhandled error on %s %s", request.method, request.url.path)

    return JSONResponse(status_code=500, content={"detail": "Internal server error."})


def owned_conversation_or_404(
    db: Session, conversation_id: str, user_id: str
):
    """The conversation this account may touch, or a 404 that leaks nothing.

    Conversations carry no shared secret, so a missing id and an id belonging to
    somebody else answer the same way. The owner is taken from the session and never
    from the request, so one account cannot read or delete another's by guessing ids
    or by sending a `client_id` that happens to match.
    """
    conversation = get_owned_conversation(db, conversation_id, user_id)
    if conversation is None:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return conversation


@app.get("/health")
def health():
    index_ready = "assistant" in state
    llm_configured = settings.has_nvidia_api_key
    return {
        "status": "ok" if index_ready and llm_configured else "degraded",
        "index_ready": index_ready,
        "llm_configured": llm_configured,
        "embedding_configured": settings.has_nvidia_embedding_api_key,
        "llm_model": settings.llm_model,
    }


@app.get("/documents")
def documents():
    return state["documents"]


@app.post("/api/conversations", response_model=ConversationCreateResponse)
def create_conversation_endpoint(
    req: ConversationCreateRequest,
    user: User = Depends(get_current_user),
    _csrf: None = Depends(require_csrf),
    db: Session = Depends(get_db),
):
    """Opens a conversation for the signed-in account.

    The only place a conversation is created, and it only runs on an explicit
    "New conversation": a message posted to a conversation id appends to that
    conversation and never creates one.

    Owned by the account from the moment it exists. `client_id` is recorded beside
    the owner because the client sends it and the sidebar groups by it, but it grants
    nothing — an account's threads are found by its session, so they follow the
    person to another browser and cannot be reached by another account on this one.
    """
    conversation = create_conversation(db, req.client_id, user.id)
    logger.info("created conversation %s for user %s", conversation.id, user.id)
    return conversation


@app.get("/api/conversations", response_model=ConversationListResponse)
def list_conversations(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """This account's conversations, most recently active first.

    The whole sidebar: one entry per conversation, not per message, so starting a new
    conversation adds one row and asking follow-ups never does.

    Takes no `client_id`: the account is the whole scope, so this cannot be widened
    by anything the caller sends. A `?client_id` an older client still appends is
    ignored rather than rejected, so both ship shapes keep working.
    """
    return {"conversations": list_owned_conversations(db, user.id)}


@app.get("/api/conversations/{conversation_id}", response_model=ConversationDetailResponse)
def get_conversation(
    conversation_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """One conversation's full thread, oldest message first."""
    conversation = owned_conversation_or_404(db, conversation_id, user.id)
    return {
        "id": conversation.id,
        "title": conversation.title,
        "messages": conversation.messages,
    }


@app.patch("/api/conversations/{conversation_id}", response_model=ConversationSummary)
def rename_conversation(
    conversation_id: str,
    req: ConversationRenameRequest,
    user: User = Depends(get_current_user),
    _csrf: None = Depends(require_csrf),
    db: Session = Depends(get_db),
):
    """Renames a conversation. The generated title is only a default."""

    conversation = owned_conversation_or_404(db, conversation_id, user.id)
    conversation.title = req.title.strip()
    touch(db, conversation)
    return conversation


@app.delete("/api/conversations/{conversation_id}")
def delete_conversation(
    conversation_id: str,
    user: User = Depends(get_current_user),
    _csrf: None = Depends(require_csrf),
    db: Session = Depends(get_db),
):
    """Removes a conversation and every message in it."""
    conversation = owned_conversation_or_404(db, conversation_id, user.id)
    db.delete(conversation)
    db.commit()
    return {"status": "deleted"}


def _previous_answer(db: Session, conversation_id: str) -> PreviousAnswer | None:
    """What this message follows, as far as answering it needs to know.

    Everything the classifier, the conversation pool and the retrieval all need, and
    all of it read from the messages stored under *this* conversation's id: whether
    the last turn was a refusal, which passages it cited, which passages this thread
    has already shown, which documents it has cited, whether it holds a topic worth
    continuing at all, how many replies it has had, whether it has already said what
    this assistant is for, and how many unreadable replies are at the end of it.
    Nothing here is module state, nothing is keyed by client, and a reload changes
    none of it — so a reader who refreshes and then asks "anything else?" gets the
    same continuation, and a reader who opens a second conversation gets none of the
    first one's.

    None only for a conversation with nothing in it yet, which is what makes a
    context-dependent first message ("anything else?") something to say so about
    rather than something to answer. A conversation holding only greetings has a
    record — it just has no topic — and its replies still count towards the pool
    that answers the next greeting.
    """
    reply_count = assistant_replies(db, conversation_id)
    typed = last_user_message(db, conversation_id)

    if reply_count == 0:
        return None

    topic = has_usable_topic(db, conversation_id)
    invited = says_the_invitation(db, conversation_id)
    unreadable_streak, unreadable_seen = unreadable_replies(db, conversation_id)

    if not topic:
        # Nothing to continue, but something said. The counters still come from the
        # conversation rather than from memory, which is what keeps the greeting
        # pool and the unreadable count right across a reload.
        return PreviousAnswer(
            assistant_replies=reply_count,
            invitation_given=invited,
            unreadable_streak=unreadable_streak,
            unreadable_seen=unreadable_seen,
            previous_user=typed,
        )

    question, answer = last_exchange(db, conversation_id)

    if answer is None:
        # An answer exists somewhere in the thread but the last turn is not one —
        # a greeting after the answer, say. The topic is still there to continue,
        # so it is reported, and there is no single answer to anchor it to.
        return PreviousAnswer(
            has_topic=True,
            cited=cited_chunk_ids(db, conversation_id),
            documents=cited_documents(db, conversation_id),
            assistant_replies=reply_count,
            invitation_given=invited,
            unreadable_streak=unreadable_streak,
            unreadable_seen=unreadable_seen,
            previous_user=typed,
        )

    return PreviousAnswer(
        kind=answer.kind,
        question=question.content if question else "",
        answer=answer.content,
        sources=tuple(answer.sources or ()),
        cited=cited_chunk_ids(db, conversation_id),
        documents=cited_documents(db, conversation_id),
        has_topic=True,
        assistant_replies=reply_count,
        invitation_given=invited,
        unreadable_streak=unreadable_streak,
        unreadable_seen=unreadable_seen,
        previous_user=typed,
    )


@app.post("/api/conversations/{conversation_id}/messages")
def send_message(
    conversation_id: str,
    req: MessageSendRequest,
    user: User = Depends(get_current_user),
    _csrf: None = Depends(require_csrf),
    db: Session = Depends(get_db),
):
    """Asks inside an existing conversation, as a stream.

    The conversation must already exist and belong to the calling account; a
    message never creates one, so a stale id surfaces as a plain 404 rather than
    silently starting a new conversation. The user message is recorded before
    the stream opens and the assistant's answer when it finishes, so a stream
    abandoned halfway records the question but no half-answer.

    The events are a `status` saying the answer is being written, one `delta`
    per piece of answer text, then a `done` carrying the finished answer, the
    `kind` of reply it is and its citations. After the first exchange that
    names the conversation, the stream also ends with a `title` event.

    The recent turns are read and handed to the assistant, which is what lets
    "what about contractors?" be answered as a continuation of the question before
    it. They are read before the new question is recorded, so the window holds the
    conversation as it stood rather than including the message being answered.

    So is the last exchange itself, read from this conversation's messages and no
    other: an answer carries which passages it cited, and "anything else?" is
    answered from the same documents with those passages removed rather than from a
    fresh search for a phrase that names nothing. A conversation with no answers in
    it has nothing to continue, and says so rather than borrowing one from
    elsewhere.
    """
    conversation = owned_conversation_or_404(db, conversation_id, user.id)

    history = recent_turns(db, conversation.id)
    previous = _previous_answer(db, conversation.id)

    db.add(
        Message(
            id=uuid4().hex,
            conversation_id=conversation.id,
            role="user",
            content=req.content,
            sources=None,
        )
    )
    db.commit()

    def events() -> Iterator[str]:
        try:
            # Classified here rather than inside `ask_stream`, so that one
            # decision decides what is said *and* what the conversation is called.
            # Passed back in rather than asked for a second time.
            classification = state["assistant"].classify(
                req.content, history, previous
            )

            # A conversation is named once, by its first message, whatever that
            # message turned out to be. The trigger is the conversation having no
            # name, not the message being worth naming: a thread that opens with a
            # greeting and is asked a real question an hour later is a greeting
            # thread, and renaming it when the question arrives makes the sidebar
            # say something about a conversation that is not the one being read.
            title_job = None
            fixed_title = None

            if conversation.title is None:
                fixed_title = state["assistant"].title_for(req.content, classification)

                if fixed_title is None:
                    title_job = TitleJob(conversation.id, classification.query).start()

            for event in state["assistant"].ask_stream(
                req.content, history, classification, previous
            ):
                if event["type"] == "done":
                    db.add(
                        Message(
                            id=uuid4().hex,
                            conversation_id=conversation.id,
                            role="assistant",
                            content=event["answer"],
                            sources=event["sources"] or None,
                            # Which kind of reply this was, recorded so a reloaded
                            # conversation renders this turn the same way it did as
                            # it streamed. Every kind of reply cites nothing, so
                            # without it a conversational turn and a gap in the
                            # corpus are the same message.
                            kind=event.get("kind"),
                            # And the wording an older client expects.
                            status=event.get("status"),
                            # And so the confidence it showed while streaming is
                            # still there to show, rather than the card rendering
                            # without one on every other visit.
                            confidence=event.get("confidence"),
                        )
                    )
                    touch(db, conversation)
                    yield sse(event)

                    # The name is the last thing the stream says, and it is always
                    # sent: a rule-based one is already known, and a generated one
                    # has had its own wait beside the answer rather than in front of
                    # it. A name that arrives late is still better than none, and a
                    # name that never arrives leaves the row labelled "New
                    # conversation" rather than failing the answer that did.
                    title = fixed_title

                    if title is None and title_job is not None:
                        title = title_job.title(wait_seconds=TITLE_WAIT_SECONDS)

                    announced = settle_title(conversation, title, db) if title else None

                    if announced:
                        yield sse({"type": "title", "title": announced})
                else:
                    yield sse(event)
        except LlmUnavailable as exc:
            # The status line is already sent by the time the model fails, so the
            # failure has to travel as an event rather than as a 503.
            logger.error("streamed question not answered: %s", exc.reason)
            yield sse({
                "type": "error",
                "detail": "The assistant is temporarily unavailable. Please try again.",
            })

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            # Stops nginx and Render's proxy from holding the answer back until it
            # is complete, which would make the stream arrive all at once.
            "X-Accel-Buffering": "no",
        },
    )


# How long a stream waits for the conversation's name before giving up on telling
# the client about it. The answer has already been delivered by this point, and
# the name is written to the database either way, so waiting too long would only
# hold the connection open for a cosmetic event.
TITLE_WAIT_SECONDS = 10


def settle_title(conversation: Conversation, title: str, db: Session) -> str | None:
    """Puts a name on a conversation, and returns the name to announce.

    Re-read first, because the answer is generated while somebody else may be
    naming: the thread that wrote this title may already have stored it, and a name
    typed into the sidebar between this turn starting and this line running is the
    reader's own name for their own conversation and is not this code's to replace.

    Three outcomes, and the difference matters:

    - unnamed, so the name is written here and announced;
    - already this name, because the naming thread got there first — announced, since
      it is the conversation's name and the sidebar has not been told;
    - some other name, which is somebody's own and is neither written over nor
      announced.
    """
    db.refresh(conversation)

    if conversation.title is None:
        conversation.title = title
        conversation.updated_at = datetime.now(timezone.utc)
        db.commit()

        return title

    return title if conversation.title == title else None


class TitleJob:
    """Names a conversation that has something to be named after, on its own thread.

    Naming the conversation cannot be part of the request's own work: it is a
    second model call, and running it inline would either delay the answer the
    reader is watching or, if it were left until after the last event, be thrown
    away by a client that hangs up first. On a thread it costs the answer
    nothing, and the name is stored whether or not anyone is still listening.

    The store is best-effort and the job is a convenience: the name this produces
    is the same one the caller would have used had the call come back in time, and a
    conversation that cannot be named is left untitled rather than failing an answer
    that has already been delivered.
    """

    def __init__(self, conversation_id: str, first_question: str) -> None:
        self._conversation_id = conversation_id
        self._first_question = first_question
        self._title: str | None = None
        self._finished = threading.Event()
        self._thread = threading.Thread(target=self._run, name="title", daemon=True)

    def start(self) -> "TitleJob":
        self._thread.start()
        return self

    def title(self, wait_seconds: float = 0) -> str | None:
        """The generated title, waiting up to `wait_seconds` for it."""
        if not self._finished.wait(timeout=wait_seconds):
            return None
        return self._title

    def _run(self) -> None:
        try:
            title = state["assistant"].generate_title(self._first_question)
            if title:
                self._title = title
                self._store(title)
        except Exception:
            # The answer is already delivered and recorded; a conversation that
            # cannot be named is left untitled rather than failing anything.
            logger.exception("could not name conversation %s", self._conversation_id)
        finally:
            self._finished.set()

    def _store(self, title: str) -> None:
        # Its own session: the request's is closed once the response is sent, and
        # this thread outlives it.
        db = open_db()
        try:
            conversation = db.get(Conversation, self._conversation_id)
            if conversation is None:
                return
            # Someone renaming the conversation while the title was being written
            # wins: their name is the one they chose.
            if conversation.title is None:
                conversation.title = title
                conversation.updated_at = datetime.now(timezone.utc)
                db.commit()
        except Exception:
            logger.exception("could not store the title for %s", self._conversation_id)
        finally:
            db.close()


def sse(event: dict) -> str:
    """One server-sent event. A JSON payload, so no framing is needed in it."""
    return f"data: {json.dumps(event)}\n\n"