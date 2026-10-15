"""Continuing an answer: "anything else?", and the follow-ups that are not one.

The defect this is about: "anything else I should know?" was rewritten by the
classifier into a question about a document the model had invented, that question
matched nothing, and the reader was told the documents did not cover it. Three
different things were wrong and each has its own fix:

- An *expansion* names no subject, so rewriting it is the wrong move entirely. It
  is now continued from the passages the previous answer cited, minus the ones it
  already showed, and when those are used up it says so.
- A *topic-shifting* follow-up still takes the rewrite path, and if the rewrite
  retrieves nothing the question it continues is tried in its place, because a
  paraphrase is a worse handle on the corpus than the question the reader asked.
- The generator sometimes writes "Not found." instead of the token, and a reply
  whose entire content is that it found nothing is not an answer.

No model and no network: retrieval is a stub that records what it was asked, and
the model is scripted.
"""

import unittest

from app.rag.engine import (
    EXHAUSTED_MSG,
    Assistant,
    PreviousAnswer,
    _declined,
)
from app.rag.guard import Category, Classification, is_expansion
from app.rag.retrieval import chunk_key


def node(text: str, document: str = "Leave Policy", section: str = "Annual Leave"):
    """A retrieved chunk, as the retriever would produce one."""

    class _Node:
        node_id = text[:12]
        metadata = {"policy_title": document, "section": section}
        score = 0.9

        def get_content(self, metadata_mode=None):
            return text

    return _Node()


def candidate(text: str, document: str = "Leave Policy", section: str = "Annual Leave"):
    """A candidate wrapping a chunk, with the scores a real one would carry."""

    class _Candidate:
        node = node(text, document, section)
        fused = 0.02
        similarity = 0.9
        keyword = None

    return _Candidate()


def assistant_answering(replies) -> Assistant:
    """An assistant whose model answers `replies` in order, and nothing else."""
    assistant = Assistant.__new__(Assistant)
    assistant.asked: list[str] = []
    scripted = list(replies)

    def complete(user_prompt: str, system_prompt: str = "", max_tokens=None) -> str:
        assistant.asked.append(user_prompt)
        return scripted.pop(0) if scripted else ""

    def stream(user_prompt: str, system_prompt: str = "", max_tokens=None):
        yield complete(user_prompt, system_prompt, max_tokens)

    assistant._complete = complete
    assistant._stream = stream
    return assistant


def previous_answer(sources, cited=(), question="What is the leave policy?", kind="answer"):
    """A previous exchange, as the route would read it off the conversation."""
    return PreviousAnswer(
        kind=kind,
        question=question,
        answer="Full-time staff get 25 days a year.",
        sources=tuple(sources),
        cited=frozenset(cited),
    )


class ExpansionRecognitionTest(unittest.TestCase):
    def test_the_obvious_ones_are_recognised_without_a_model(self):
        for text in [
            "anything else?",
            "anything else i should know",
            "what else?",
            "tell me more",
            "go on",
            "more, please",
        ]:
            with self.subTest(text=text):
                self.assertTrue(is_expansion(text), text)

    def test_a_question_naming_a_subject_is_not_an_expansion(self):
        # The difference from a follow-up is the subject, not the politeness.
        for text in [
            "anything else should I know about contractors?",
            "what else does the leave policy say?",
            "tell me more about the grievance procedure",
            "more about parental leave",
        ]:
            with self.subTest(text=text):
                self.assertFalse(is_expansion(text), text)

    def test_an_expansion_with_nothing_to_continue_falls_back_to_a_follow_up(self):
        assistant = assistant_answering([])

        classification = assistant.classify("anything else?")

        self.assertIs(classification.category, Category.FOLLOW_UP)


class ContinuationTest(unittest.TestCase):
    """The continuation itself: what it retrieves, and what it settles on."""

    def previous_with_sources(self, texts=(("Leave Policy", "Annual Leave", "25 days"),)):
        sources = [
            {"document": document, "section": section, "chunk_id": chunk_key(node(text)), "snippet": text, "score": 0.8}
            for document, section, text in texts
        ]
        return previous_answer(sources, cited=[source["chunk_id"] for source in sources])

    def test_it_retrieves_only_the_anchored_passages_and_not_the_shown_ones(self):
        asked: list[tuple] = []

        class Retrieval:
            def retrieve_continuation(self, query, anchors, already_shown):
                asked.append((query, set(anchors), set(already_shown)))
                return [candidate("Carryover is capped at five days.")]

        assistant = assistant_answering(["Carryover is capped at five days."])
        assistant.retrieval = Retrieval()

        previous = self.previous_with_sources()
        done = list(assistant.ask_stream("anything else?", previous=previous))[-1]

        self.assertEqual(done["kind"], "answer")
        # Anchored to the documents the last answer cited, and holding back every
        # chunk this thread has already shown.
        query, anchors, already_shown = asked[0]
        self.assertEqual(anchors, {("Leave Policy", "Annual Leave")})
        self.assertEqual(already_shown, {previous.sources[0]["chunk_id"]})
        self.assertEqual(query, "What is the leave policy?")
        # And the generator is told what was already covered, so it adds rather
        # than repeats.
        self.assertIn("Already covered", assistant.asked[-1])
        self.assertIn("25 days", assistant.asked[-1])

    def test_it_streams_like_any_other_answer(self):
        class Retrieval:
            def retrieve_continuation(self, query, anchors, already_shown):
                return [candidate("Carryover is capped at five days.")]

        assistant = assistant_answering(["Carryover is capped at five days."])
        assistant.retrieval = Retrieval()

        events = list(
            assistant.ask_stream("anything else?", previous=self.previous_with_sources())
        )

        self.assertEqual([event["type"] for event in events][:2], ["status", "delta"])
        self.assertEqual(events[-1]["type"], "done")
        self.assertEqual(events[-1]["kind"], "answer")

    def test_used_up_sources_say_so_and_never_not_found(self):
        class Retrieval:
            def retrieve_continuation(self, query, anchors, already_shown):
                return []

        assistant = assistant_answering([])
        assistant.retrieval = Retrieval()

        done = list(
            assistant.ask_stream("anything else?", previous=self.previous_with_sources())
        )[-1]

        # The corpus has no gap here. Those documents were read; the topic is done.
        self.assertEqual(done["kind"], "no_more_info")
        self.assertEqual(done["answer"], EXHAUSTED_MSG)
        self.assertEqual(done["sources"], [])
        self.assertIsNone(done["confidence"])
        self.assertNotEqual(done["kind"], "not_found")

    def test_a_generator_that_finds_nothing_new_is_the_same_answer(self):
        class Retrieval:
            def retrieve_continuation(self, query, anchors, already_shown):
                return [candidate("Carryover is capped at five days.")]

        assistant = assistant_answering(["NOT_FOUND"])
        assistant.retrieval = Retrieval()

        done = list(
            assistant.ask_stream("anything else?", previous=self.previous_with_sources())
        )[-1]

        # The passages were there and the generator said they added nothing. That is
        # exhaustion, not a gap in the corpus, and the two are drawn differently.
        self.assertEqual(done["kind"], "no_more_info")

    def test_asking_again_after_exhaustion_says_the_same_thing(self):
        class Retrieval:
            def retrieve(self, query):
                raise AssertionError("the documents behind this topic are already read")

            def retrieve_continuation(self, query, anchors, already_shown):
                raise AssertionError("and there is nothing left in them")

        assistant = assistant_answering([])
        assistant.retrieval = Retrieval()

        previous = previous_answer(
            [{"document": "Leave Policy", "section": "Annual Leave"}],
            kind="no_more_info",
        )
        for message in ("anything else?", "tell me more"):
            with self.subTest(message=message):
                done = list(assistant.ask_stream(message, previous=previous))[-1]

                # Searching the same passages again would either restate the last
                # answer or come back as a false gap in the corpus.
                self.assertEqual(done["kind"], "no_more_info")

    def test_no_previous_answer_says_so_rather_than_searching(self):
        class Retrieval:
            def retrieve(self, query):
                raise AssertionError("an expansion must not run an ordinary search")

            def retrieve_continuation(self, query, anchors, already_shown):
                raise AssertionError("nothing to anchor to")

        assistant = assistant_answering([])
        assistant.retrieval = Retrieval()

        # Forced past the classifier, which would have downgraded this: the
        # behaviour that matters is what happens when an expansion does reach the
        # path with nothing behind it.
        done = list(
            assistant.ask_stream(
                "anything else?",
                classification=Classification(Category.EXPANSION, "anything else?"),
            )
        )[-1]

        self.assertEqual(done["kind"], "no_more_info")


class TopicShiftingFollowUpTest(unittest.TestCase):
    """A follow-up with a subject of its own keeps the rewrite, with a net."""

    def test_the_rewrite_is_retrieved_first(self):
        asked: list[str] = []

        class Retrieval:
            def retrieve(self, query):
                asked.append(query)
                return [candidate("Contractors are held to the same standard.")]

        assistant = assistant_answering(["Contractors are held to the same standard."])
        assistant.retrieval = Retrieval()

        classification = Classification(
            Category.FOLLOW_UP, "What does the Code of Conduct say about contractors?"
        )
        list(
            assistant.ask_stream(
                "what about contractors?",
                classification=classification,
                previous=previous_answer([{"document": "Code of Conduct", "section": "Behaviour"}]),
            )
        )

        self.assertEqual(asked, ["What does the Code of Conduct say about contractors?"])

    def test_a_rewrite_that_finds_nothing_falls_back_to_the_question_it_continues(self):
        asked: list[str] = []

        class Retrieval:
            def retrieve(self, query):
                asked.append(query)
                if query == "What else does the expectations document cover?":
                    return []
                return [candidate("Communicate respectfully.")]

        assistant = assistant_answering(["Communicate respectfully."])
        assistant.retrieval = Retrieval()

        classification = Classification(
            Category.FOLLOW_UP, "What else does the expectations document cover?"
        )
        previous = previous_answer(
            [{"document": "Code of Conduct", "section": "Behaviour"}],
            question="What are the expectations for employees?",
        )
        done = list(
            assistant.ask_stream("anything else should I know?", classification=classification, previous=previous)
        )[-1]

        # The paraphrase found nothing; the question that started the thread finds
        # the same topic, and that is not a gap in the corpus.
        self.assertEqual(
            asked,
            [
                "What else does the expectations document cover?",
                "What are the expectations for employees?",
            ],
        )
        self.assertEqual(done["kind"], "answer")

    def test_neither_finding_anything_is_still_a_gap_in_the_corpus(self):
        class Retrieval:
            def retrieve(self, query):
                return []

        assistant = assistant_answering([])
        assistant.retrieval = Retrieval()

        classification = Classification(Category.FOLLOW_UP, "What about elephants?")
        done = list(
            assistant.ask_stream("what about elephants?", classification=classification)
        )[-1]

        self.assertEqual(done["kind"], "not_found")


class DeclinedReplyTest(unittest.TestCase):
    """A reply that says it found nothing is not an answer."""

    def test_the_spellings_that_mean_the_sentinel(self):
        for text in ["NOT_FOUND", "NOT_FOUND.", "Not found.", "not found", "Nothing found."]:
            with self.subTest(text=text):
                self.assertEqual(_declined(text), "not_found")

    def test_a_real_answer_using_the_words_is_still_an_answer(self):
        for text in [
            "The policy says you cannot be dismissed without a process.",
            "Not found: there is no bonus for interns.",
            "Personal leave is recorded by HR.",
            "",
        ]:
            with self.subTest(text=text):
                self.assertIsNone(_declined(text))

    def test_a_hedged_found_nothing_reply_settles_as_not_found(self):
        class Retrieval:
            def retrieve(self, query):
                return [candidate("Full-time staff get 25 days.")]

        assistant = assistant_answering(
            [
                "CATEGORY: COMPANY_QUESTION\nQUESTION: What is the dental policy?",
                "Not found.",
            ]
        )
        assistant.retrieval = Retrieval()

        done = list(assistant.ask_stream("What is the dental policy?"))[-1]

        # It was shipped as an answer before, whose whole content was that it found
        # nothing, with four sources attached to it.
        self.assertEqual(done["kind"], "not_found")
        self.assertEqual(done["sources"], [])


class ChunkKeyTest(unittest.TestCase):
    """The id an expansion uses to recognise a passage it has already shown."""

    def test_it_is_stable_for_the_same_passage(self):
        self.assertEqual(chunk_key(node("25 days of leave")), chunk_key(node("25 days of leave")))

    def test_it_differs_by_document_section_and_text(self):
        base = chunk_key(node("25 days", "Leave Policy", "Annual Leave"))

        self.assertNotEqual(base, chunk_key(node("25 days", "Leave Policy", "Carryover")))
        self.assertNotEqual(base, chunk_key(node("25 days", "HR Directory", "Annual Leave")))
        self.assertNotEqual(base, chunk_key(node("26 days", "Leave Policy", "Annual Leave")))


if __name__ == "__main__":
    unittest.main()