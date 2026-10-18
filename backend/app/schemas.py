from datetime import datetime
from pydantic import BaseModel, ConfigDict, Field


class ConversationCreateRequest(BaseModel):
    client_id: str = Field(min_length=8, max_length=64)


class ConversationCreateResponse(BaseModel):
    id: str
    title: str | None = None
    created_at: datetime


class ConversationSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    title: str | None
    updated_at: datetime


class ConversationListResponse(BaseModel):
    conversations: list[ConversationSummary]


class ConversationDetailResponse(BaseModel):
    id: str
    title: str | None
    messages: list["MessageDto"] = []


class MessageSendRequest(BaseModel):
    client_id: str = Field(min_length=8, max_length=64)
    content: str = Field(min_length=3, max_length=500)


class ConversationRenameRequest(BaseModel):
    client_id: str = Field(min_length=8, max_length=64)
    title: str = Field(min_length=1, max_length=120)


class Source(BaseModel):
    document: str
    section: str
    snippet: str
    # Stable id for the passage itself. Not drawn: it is how "anything else?" knows
    # which passages this thread has already shown, which it can only know from the
    # stored citations.
    chunk_id: str | None = None
    score: float
    # That the answer was drawn from this passage rather than merely retrieved
    # alongside it. Always true on a stored row — only used passages are persisted —
    # and absent on a row written before the distinction existed, which reads as
    # used because those passages were displayed.
    used: bool = True


class MessageDto(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    role: str
    content: str
    sources: list[Source] | None = None
    created_at: datetime
    # How the assistant answered, or null on a question and on any message stored
    # before this field existed. Null is read downstream as "worked it out from the
    # citations", which is what those older rows can still support.
    status: str | None = None
    # What kind of reply this is — `answer`, `not_found`, `out_of_scope`,
    # `conversational` or `restricted` — and what the client draws from. Kept
    # beside `status` rather than replacing it, so a row stored before `kind`
    # existed still renders through the vocabulary it has.
    kind: str | None = None
    # How closely the retrieved passages matched the question, 1-10, or null on a
    # turn that was not built from any. Null for the same reason `status` is
    # nullable: an older row has no figure, and reporting one would be inventing it.
    confidence: int | None = None


ConversationDetailResponse.model_rebuild()