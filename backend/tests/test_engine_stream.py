"""Tests for how the answer stream is produced, retry policy included.

No network and no key: `Assistant._client` is replaced with a stub that hands back
canned chunks, so these run in a second and assert the parts that are hard to
see by hand, above all what happens when a stream breaks mid-answer.
"""

import unittest
from typing import Any, Iterator, List, Optional

import httpx
from openai import APIConnectionError, APIStatusError

from app.config import settings
from app.rag.engine import (
    TITLE_MAX_TOKENS,
    Assistant,
    LlmUnavailable,
    truncate_title,
)


def status_error(status: int) -> APIStatusError:
    """A status error as the SDK raises it for an upstream HTTP response."""
    request = httpx.Request("POST", "https://integrate.api.nvidia.com/v1/chat/completions")

    return APIStatusError(
        f"upstream returned {status}",
        response=httpx.Response(status_code=status, request=request),
        body=None,
    )


def chunk(text: Optional[str]) -> Any:
    """One streamed completion chunk carrying `text`."""

    class _Delta:
        def __init__(self, content: Optional[str]) -> None:
            self.content = content

    class _Choice:
        def __init__(self, content: Optional[str]) -> None:
            self.delta = _Delta(content)

    class _Chunk:
        def __init__(self, content: Optional[str]) -> None:
            self.choices = [_Choice(content)]

    return _Chunk(text)


class StubCompletions:
    """Serves a scripted list of streams, one per call."""

    def __init__(self, streams: List[List[Any]]) -> None:
        self.streams = streams
        self.calls = 0

    def create(self, **_: Any) -> Iterator[Any]:
        script = self.streams[min(self.calls, len(self.streams) - 1)]
        self.calls += 1
        return self._iterate(script)

    @staticmethod
    def _iterate(script: List[Any]) -> Iterator[Any]:
        for item in script:
            if isinstance(item, Exception):
                raise item
            yield item


class StubClient:
    def __init__(self, streams: List[List[Any]]) -> None:
        self.chat = type("Chat", (), {})()
        self.chat.completions = StubCompletions(streams)


class StubTextCompletions:
    """Answers a non-streamed call (title generation) with a canned reply."""

    def __init__(self, content: str) -> None:
        self.content = content
        self.last_kwargs: Optional[dict] = None

    def create(self, **kwargs: Any) -> Any:
        self.last_kwargs = kwargs

        class _Message:
            content = self.content

        class _Choice:
            message = _Message()

        class _Completion:
            choices = [_Choice()]

        return _Completion()


class StubTextClient:
    def __init__(self, content: str) -> None:
        self.chat = type("Chat", (), {})()
        self.chat.completions = StubTextCompletions(content)


def assistant_with(streams: List[List[Any]]) -> Assistant:
    """An assistant whose model returns the given streams, in order."""
    assistant = Assistant.__new__(Assistant)
    assistant._client = StubClient(streams)
    return assistant


class StreamContentTest(unittest.TestCase):
    def test_yields_only_answer_text_and_skips_reasoning(self) -> None:
        # The configured model thinks out loud before answering, and that thinking
        # is not the answer.
        assistant = assistant_with([[chunk(None), chunk("Twenty "), chunk("days."), chunk(None)]])

        self.assertEqual(list(assistant._stream("q")), ["Twenty ", "days."])

    def test_reports_failure_when_every_attempt_is_empty(self) -> None:
        # A reasoning model that spends its whole allowance thinking returns no
        # answer at all, which must not be passed off as an empty answer.
        assistant = assistant_with([[chunk(None)]])

        with self.assertRaises(LlmUnavailable):
            list(assistant._stream("q"))


class StreamRetryTest(unittest.TestCase):
    def _connection_error(self) -> APIConnectionError:
        return APIConnectionError(request=None)

    def test_retries_a_stream_that_never_produced_text(self) -> None:
        # Nothing reached the browser, so starting over costs the reader nothing.
        assistant = assistant_with([[self._connection_error()], [chunk("Twenty days.")]])

        self.assertEqual(list(assistant._stream("q")), ["Twenty days."])
        self.assertEqual(assistant._client.chat.completions.calls, 2)

    def test_does_not_replay_an_answer_that_was_already_being_shown(self) -> None:
        # The first attempt got as far as being on screen. Retrying would write
        # the whole answer again underneath it, leaving the reader looking at the
        # same sentence twice with no way to tell the halves apart.
        assistant = assistant_with(
            [[chunk("Full-time staff "), self._connection_error()], [chunk("accrue 25 days.")]]
        )

        with self.assertRaises(LlmUnavailable):
            list(assistant._stream("q"))

        self.assertEqual(assistant._client.chat.completions.calls, 1)

    def test_does_not_replay_after_a_status_error_mid_stream(self) -> None:
        assistant = assistant_with(
            [[chunk("Full-time staff "), status_error(503)], [chunk("accrue 25 days.")]]
        )

        with self.assertRaises(LlmUnavailable):
            list(assistant._stream("q"))

        self.assertEqual(assistant._client.chat.completions.calls, 1)

    def test_gives_up_immediately_on_a_rejected_request(self) -> None:
        # A 4xx is a rejected key or an unreachable model, and waiting changes
        # nothing about it.
        assistant = assistant_with([[status_error(401)]])

        with self.assertRaises(LlmUnavailable):
            list(assistant._stream("q"))

        self.assertEqual(assistant._client.chat.completions.calls, 1)


class TitleGenerationTest(unittest.TestCase):
    def test_truncation_fallback_bounds_and_cleans_the_title(self) -> None:
        self.assertEqual(truncate_title("What is the leave policy?"), "What is the leave policy?")
        self.assertEqual(truncate_title("What is the leave policy for part-time employees hired since 2020 and what does it say about carryover into the next year?"), "What is the leave policy for part-time employees")

    def test_unavailable_model_falls_back_to_the_message(self) -> None:
        # `_client is None` is exactly what a missing NVIDIA key produces, and
        # the title must still be something, not crash the stream.
        assistant = Assistant.__new__(Assistant)
        assistant._client = None

        title = assistant.generate_title("How much leave do I get if I have been here for five years?")

        self.assertEqual(title, "How much leave do I get if I have been here for")
        self.assertLessEqual(len(title), 50)

    def test_model_title_is_cleaned_of_quotes(self) -> None:
        assistant = Assistant.__new__(Assistant)
        assistant._client = StubTextClient('"Leave policy."')

        self.assertEqual(assistant.generate_title("How much leave?"), "Leave policy")

    def test_title_call_uses_its_own_output_budget(self) -> None:
        assistant = Assistant.__new__(Assistant)
        assistant._client = StubTextClient("Leave")

        assistant.generate_title("How much leave?")

        # Big enough for the reasoning model's thinking and still far below an
        # answer's: a budget of a few dozen was spent on thinking and left the call
        # with no title at all.
        self.assertEqual(
            assistant._client.chat.completions.last_kwargs["max_tokens"],
            TITLE_MAX_TOKENS,
        )
        self.assertLess(TITLE_MAX_TOKENS, settings.llm_max_tokens)


if __name__ == "__main__":
    unittest.main()
