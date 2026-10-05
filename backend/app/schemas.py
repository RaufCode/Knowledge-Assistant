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
    score: float


class MessageDto(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    role: str
    content: str
    sources: list[Source] | None = None
    created_at: datetime


ConversationDetailResponse.model_rebuild()