from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, computed_field

from app.rag.confidence import confidence_from_sources


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


class MessageEditRequest(BaseModel):
    """A correction to a question already asked.

    `client_id` is accepted and ignored, like the one on `MessageSendRequest`. It
    used to be what decided who owned a conversation; it no longer decides anything,
    and the session does. It stays on the wire so the existing request shape does
    not have to change at every call site.
    """

    client_id: str = Field(min_length=8, max_length=64)
    content: str = Field(min_length=3, max_length=500)


class ConversationRenameRequest(BaseModel):
    client_id: str = Field(min_length=8, max_length=64)
    title: str = Field(min_length=1, max_length=120)


class Source(BaseModel):
    document: str
    section: str
    snippet: str
    score: float


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

    @computed_field  # type: ignore[prop-decorator]
    @property
    def confidence(self) -> int | None:
        """A 1-10 confidence, worked out from the citations on this message.

        Computed rather than stored so it cannot drift from the sources it describes.
        It is also what makes a reloaded thread show the same figure as the one just
        watched being answered: both come from the same scores through the same
        function, and nothing extra is written to the row.
        """
        return confidence_from_sources(self.sources or [])


ConversationDetailResponse.model_rebuild()