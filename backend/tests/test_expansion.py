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

from llama_index.core import VectorStoreIndex
from llama_index.core.embeddings import MockEmbedding
from llama_index.core.schema import TextNode

from app.rag.engine import (
    EXHAUSTED_MSG,
    Assistant,
    PreviousAnswer,
    _declined,
    _source,
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
        documents=frozenset(str(source["document"]) for source in sources),
        has_topic=True,
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

    def test_an_expansion_with_nothing_to_continue_is_not_classified_at_all(self):
        asked: list[str] = []
        assistant = assistant_answering([])
        assistant.asked = asked

        classification = assistant.classify("anything else?")

        # There is no question here to put to a classifier, and no earlier turn to
        # continue: the conversation is simply empty.
        self.assertIs(classification.category, Category.CONVERSATIONAL)
        self.assertEqual(asked, [])


class ContinuationTest(unittest.TestCase):
    """The continuation itself: what it retrieves, and what it settles on."""

    def previous_with_sources(self, texts=(("Leave Policy", "Annual Leave", "25 days"),)):
        sources = [
            {"document": document, "section": section, "chunk_id": chunk_key(node(text)), "snippet": text, "score": 0.8}
            for document, section, text in texts
        ]
        return previous_answer(sources, cited=[source["chunk_id"] for source in sources])

    def test_it_retrieves_only_the_cited_documents_and_not_the_shown_chunks(self):
        asked: list[tuple] = []

        class Retrieval:
            def retrieve_continuation(self, query, documents, already_shown):
                asked.append((query, set(documents), set(already_shown)))
                return [candidate("Carryover is capped at five days.")]

        assistant = assistant_answering(["Carryover is capped at five days."])
        assistant.retrieval = Retrieval()

        previous = self.previous_with_sources()
        done = list(assistant.ask_stream("anything else?", previous=previous))[-1]

        self.assertEqual(done["kind"], "answer")
        # Anchored to the documents this thread cited, and holding back every chunk
        # it has already shown.
        query, documents, already_shown = asked[0]
        self.assertEqual(documents, {"Leave Policy"})
        self.assertEqual(already_shown, {previous.sources[0]["chunk_id"]})
        self.assertEqual(query, "What is the leave policy?")
        # And the generator is told what was already covered, so it adds rather
        # than repeats.
        self.assertIn("Already covered", assistant.asked[-1])
        self.assertIn("25 days", assistant.asked[-1])

    def test_it_streams_like_any_other_answer(self):
        class Retrieval:
            def retrieve_continuation(self, query, documents, already_shown):
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
            def retrieve_continuation(self, query, documents, already_shown):
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
            def retrieve_continuation(self, query, documents, already_shown):
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

            def retrieve_continuation(self, query, documents, already_shown):
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

            def retrieve_continuation(self, query, documents, already_shown):
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


class ReadingTheDocumentTest(unittest.TestCase):
    """The expansion path end to end: how many "anything else?" a document takes.

    Driven through a real index with real retrieval, because what is being counted
    is a count. A stub returning whatever the test tells it to would assert the
    test rather than the code, and the number that matters — expansions plus the
    first answer, against the sections the document has — is exactly the one a
    stub cannot produce.

    The embedding is the library's mock, which scores every passage alike: which
    section comes back first is not the subject here, but how many are delivered
    before the document is used up is.
    """

    QUESTION = "What are the expectations for employees?"
    SECTIONS = 7

    def setUp(self) -> None:
        nodes = [
            TextNode(
                text=f"Section {number}: employees are expected to behave professionally.",
                id_=f"expectations/{number}",
                metadata={
                    "policy_title": "Employee Expectations",
                    "section": f"Section {number}",
                },
            )
            for number in range(1, self.SECTIONS + 1)
        ]

        # Built the way it is built in the app, so the wiring under test is the
        # wiring that ships; only the model is scripted, because a real one needs
        # a key.
        assistant = Assistant(VectorStoreIndex(nodes, embed_model=MockEmbedding(embed_dim=8)))
        self.asked: list[str] = []

        def complete(user_prompt: str, system_prompt: str = "", max_tokens=None) -> str:
            self.asked.append(user_prompt)
            return "There is more to say."

        def stream(user_prompt: str, system_prompt: str = "", max_tokens=None):
            yield complete(user_prompt, system_prompt, max_tokens)

        assistant._complete = complete
        assistant._stream = stream
        self.assistant = assistant

        # What the first answer quoted: one section, as an ordinary answer does.
        first = assistant.retrieval.retrieve(self.QUESTION)[:1]
        self.sources = [_source(candidate) for candidate in first]
        self.shown = {each["chunk_id"] for each in self.sources}
        self.kind = "answer"

    def expand(self) -> dict:
        # The kind is carried forward the way the route carries it: the previous
        # assistant message records what it was, and that is what lets a second
        # "anything else?" be answered from the first one's verdict rather than by
        # searching a document that has already been read out.
        previous = previous_answer(self.sources, cited=self.shown, kind=self.kind)
        done = list(self.assistant.ask_stream("anything else?", previous=previous))[-1]
        self.kind = done["kind"]

        return done

    def record(self, sources) -> set[str]:
        """What an expansion showed the reader, added to what the thread has shown.

        Built the way the route builds it: every citation in the conversation is
        what a later turn holds back, and it is the only place that state lives.
        """
        keys = {each["chunk_id"] for each in sources}
        # Never a passage twice: the reader has read it, and re-quoting it is not
        # "more".
        self.assertEqual(keys & self.shown, set())
        self.shown |= keys
        self.sources += sources

        return keys

    def test_it_takes_two_expansions_to_read_a_seven_section_document(self):
        answers = 1

        while True:
            done = self.expand()

            if done["kind"] == "no_more_info":
                break

            self.assertEqual(done["kind"], "answer")
            self.record(done["sources"])
            answers += 1

        # One section by the first answer and three by each of two expansions; the
        # third finds the document read out. Every section was delivered once, which
        # is what makes "that covers everything on this topic" true rather than
        # merely early.
        self.assertEqual(answers, 3)
        self.assertEqual(len(self.shown), self.SECTIONS)

    def test_the_generator_is_given_the_unread_sections_and_nothing_else(self):
        done = self.expand()
        context = self.asked[-1].split("Context")[-1]

        for each in done["sources"]:
            self.assertIn(each["section"], context)

        # The section the first answer already quoted is not in the context of the
        # second turn, and what it did say is in the prompt as covered — which is
        # what stops the continuation restating it.
        self.assertNotIn(self.sources[0]["section"], context)
        self.assertIn("Already covered", self.asked[-1])

    def test_asking_again_after_the_document_is_used_up_says_the_same_thing(self):
        for _ in range(3):
            done = self.expand()
            if done["kind"] == "answer":
                self.record(done["sources"])

        asked_before = len(self.asked)

        self.assertEqual(self.expand()["kind"], "no_more_info")
        # Nothing was generated for it: the passages were already read out, so
        # there was nothing to hand the model.
        self.assertEqual(len(self.asked), asked_before)


if __name__ == "__main__":
    unittest.main()