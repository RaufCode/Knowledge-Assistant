"""The transcript, replayed turn by turn.

One defect, one conversation. "do you understand chinese?" is answered with an
invitation to ask a question; "that is chinese" is not recognised as a correction
about anything; "what else" after a not-found claims a topic was exhausted; "anything
about these departments?" gets two of ten departments from a document that lists all
ten; the answer about the number of departments cites four passages and used one; and
two gibberish messages in a row both get the first reply, because a stray real word
disqualified the first of them.

Every test here is a replay: a whole conversation, asked and answered in order, with
the reply, its kind and its sources checked at each turn. Asserting on one turn in
isolation is what let these through — "what else" behaves correctly and incorrectly
depending only on what came before it.

No model and no network. The retrieval is a real `HybridRetriever` over the real
corpus with a deterministic stand-in embedding, and only the generator is scripted,
so the passages, the keys and the ordering are the ones that ship.
"""

import unittest

from llama_index.core import VectorStoreIndex
from llama_index.core.embeddings import MockEmbedding
from llama_index.core.schema import TextNode

from app.config import settings
from app.rag.capabilities import (
    ASSISTANT_FAQ,
    FAQ_IDS,
    LANGUAGES,
    NOT_SURE_REPLY,
    UNREADABLE_OPENINGS,
    faq_entry,
)
from app.rag.engine import (
    NOTHING_TO_ADD_MSG,
    Assistant,
    PreviousAnswer,
    _displayed_sources,
    _split_used_keys,
)
from app.rag.guard import (
    CLASSIFIER_SYSTEM_PROMPT,
    Category,
    Classification,
    is_meta_question,
)


# =============================================================================
# The corpus these questions are asked against
# =============================================================================

DEPARTMENTS = (
    "Acme Technologies is organised into **ten (10) departments**:\n\n"
    "1. **Software Engineering** — Designs and builds client and internal "
    "applications (web, backend, mobile). The largest department.\n"
    "2. **Data & AI** — Delivers data engineering, analytics, machine learning, "
    "and AI features for clients.\n"
    "3. **Cloud & DevOps** — Owns infrastructure, CI/CD, deployment, reliability, "
    "and cloud cost management.\n"
    "4. **Quality Assurance (QA)** — Manual and automated testing; ensures product "
    "quality before release.\n"
    "5. **Product & Design** — Product management, UX research, and UI/visual "
    "design.\n"
    "6. **People & Culture (HR)** — Recruitment, onboarding, employee relations, "
    "learning & development, payroll coordination.\n"
    "7. **Finance & Accounting** — Budgeting, payroll processing, invoicing, "
    "financial reporting, and compliance.\n"
    "8. **Sales & Business Development** — Client acquisition, proposals, and "
    "account growth.\n"
    "9. **Marketing & Communications** — Brand, content, events, and "
    "internal/external communications.\n"
    "10. **IT Support & Security** — Internal IT support, device management, "
    "network, VPN, and information security."
)

COMPANY_SIZE = (
    "As of Q3 2026, Acme Technologies employs **480 people** across all "
    "departments and locations."
)

TECH_STACK = (
    "**Version control:** Git, hosted on GitHub\n"
    "**Project tracking:** Jira and Confluence\n"
    "**Communication:** Microsoft Teams and Slack"
)

IT_OWNER = (
    "**Effective date:** 1 January 2026\n"
    "**Owner:** Office of the CTO\n\n"
    "This guide explains how to set up the company VPN and where to get IT help."
)

CORPUS = (
    ("Company Overview", "Departments and their roles", DEPARTMENTS),
    ("Company Overview", "Company size", COMPANY_SIZE),
    ("Technical Departments & Tech Stack", "Cross-cutting tools", TECH_STACK),
    ("IT & VPN Setup Guide", "Before you start", IT_OWNER),
)


def corpus_nodes():
    return [
        TextNode(
            text=text,
            id_=f"{document}/{section}".lower().replace(" ", "-"),
            metadata={"policy_title": document, "section": section},
        )
        for document, section, text in CORPUS
    ]


class Transcript:
    """A conversation, asked in order, with what it said recorded.

    Holds the thread state the way the route holds it: the previous assistant turn,
    the passages this thread has shown, and the reply count. Everything is read from
    what was actually answered rather than assumed, which is the only way the second
    and third turns of a conversation can be checked against the first.
    """

    def __init__(self, replies):
        self.assistant = Assistant(
            VectorStoreIndex(corpus_nodes(), embed_model=MockEmbedding(embed_dim=8))
        )
        # A reply may be a callable, given the user prompt it is answering. Needed
        # wherever the generator has to name a real passage key: the stand-in
        # embedding scores every chunk identically, so which passage is first is not
        # something a test should hard-code and hope holds.
        self.replies = list(replies)
        self.asked: list[str] = []
        self.history: list[tuple[str, str]] = []
        self.kind = None
        self.shown: set[str] = set()
        self.documents: set[str] = set()
        self.sources: list[dict] = []
        self.replies_given = 0
        self.invitation_given = False
        self.unreadable_streak = 0
        self.unreadable_seen = 0
        # What this reader last typed, which is not the last thing in the history:
        # the assistant's reply to it is.
        self.last_user = ""
        # Mirrors `database.has_usable_topic`: a turn that answered *or searched for*
        # an in-scope question leaves a topic worth continuing, and one that found
        # nothing still counts — it is a gap, not the absence of a question.
        self.has_topic = False

        def complete(user_prompt: str, system_prompt: str = "", max_tokens=None) -> str:
            self.asked.append(user_prompt)

            # The classifier and the generator are separate model calls in the app,
            # so they are scripted separately here. Left to share one queue they eat
            # each other's replies and a turn that classified gets the next turn's
            # answer.
            if system_prompt is CLASSIFIER_SYSTEM_PROMPT:
                message = user_prompt.rsplit("Message:", 1)[-1].strip()
                return f"CATEGORY: COMPANY_QUESTION\nQUESTION: {message}"

            reply = self.replies.pop(0) if self.replies else ""

            return reply(user_prompt) if callable(reply) else reply

        def stream(user_prompt: str, system_prompt: str = "", max_tokens=None):
            yield complete(user_prompt, system_prompt, max_tokens)

        self.assistant._complete = complete
        self.assistant._stream = stream

    @property
    def previous(self) -> PreviousAnswer | None:
        return PreviousAnswer(
            kind=self.kind,
            question=self.history[-2][1] if len(self.history) > 1 else "",
            answer=self.history[-1][1] if self.history else "",
            sources=tuple(self.sources),
            cited=frozenset(self.shown),
            documents=frozenset(self.documents),
            has_topic=self.has_topic,
            assistant_replies=self.replies_given,
            invitation_given=self.invitation_given,
            unreadable_streak=self.unreadable_streak,
            unreadable_seen=self.unreadable_seen,
            previous_user=self.last_user,
        )

    def ask(self, message: str) -> dict:
        """Ask one question and carry the thread forward the way the route does."""
        # Read before this message is recorded: `previous_user` has to be what the
        # reader typed *before* this one, which is the whole point of the script
        # correction's claim.
        previous = self.previous
        self.last_user = message
        self.history.append(("user", message))
        done = list(self.assistant.ask_stream(message, self.history, None, previous))[-1]
        self.history.append(("assistant", done["answer"]))

        self.kind = done["kind"]
        self.replies_given += 1
        self.invitation_given = "Ask me about company policies" in done["answer"]

        if done["answer"].startswith(UNREADABLE_OPENINGS):
            self.unreadable_streak += 1
            self.unreadable_seen += 1
        elif self.kind != "conversational" or done["answer"] != NOTHING_TO_ADD_MSG:
            self.unreadable_streak = 0

        self.sources = list(done["sources"])
        self.shown |= {source["chunk_id"] for source in self.sources}
        self.documents |= {source["document"] for source in self.sources}

        if self.kind in ("answer", "not_found"):
            self.has_topic = True

        return done

    def key_of(self, section: str) -> str:
        """The chunk key of the passage with this section, read from the index.

        So a scripted generator can name a real passage rather than a position, which
        matters because the stand-in embedding gives every chunk the same score and
        the order among them is not something a test should depend on.
        """
        from app.rag.retrieval import chunk_key

        for node in self.assistant.retrieval._documents._by_document.values():
            for chunk in node:
                if chunk.metadata["section"] == section:
                    return chunk_key(chunk)

        raise AssertionError(f"no section {section!r} in the corpus")


# =============================================================================
# "do you understand chinese?" and everything after it
# =============================================================================


class MetaQuestionTest(unittest.TestCase):
    """A question about the assistant is answered, not deflected.

    The reply it used to get was "I'm happy to help with any questions you have. Just
    let me know what you need", produced by the conversational path on a question the
    capabilities description said nothing about.
    """

    def test_do_you_understand_chinese_is_answered_directly(self):
        conversation = Transcript([])
        done = conversation.ask("do you understand chinese?")

        self.assertEqual(done["kind"], "conversational")
        self.assertEqual(done["sources"], [])
        self.assertEqual(done["answer"], LANGUAGES.answer)
        self.assertNotIn("let me know what you need", done["answer"].lower())

    def test_a_direct_question_never_reaches_the_generated_reply(self):
        # The conversational generator is barred from stating facts about the
        # assistant, so anything it produced for these was a dodge by construction.
        conversation = Transcript(["I'm happy to help with any questions you have."])

        for message in (
            "do you understand chinese?",
            "who are you?",
            "can you remember our chats?",
            "how accurate are you?",
            "is this private?",
            "what can't you do?",
            "are my messages saved?",
        ):
            with self.subTest(message=message):
                done = conversation.ask(message)
                self.assertEqual(done["kind"], "conversational")
                self.assertNotEqual(
                    done["answer"],
                    "I'm happy to help with any questions you have.",
                    "the generated reply must never be the answer to a direct question",
                )

    def test_a_question_the_documents_answer_is_not_treated_as_one_about_us(self):
        # The other failure of the same rule set: "who do I contact about leave?" is
        # addressed to nobody in particular and the directory answers it. Catching it
        # as a question about the assistant would trade a real answer for a paragraph
        # about who to ask.
        self.assertFalse(is_meta_question("who do I contact about leave?"))
        self.assertFalse(is_meta_question("who should I contact for a payslip?"))
        self.assertFalse(
            is_meta_question("what does the security policy say about data privacy?")
        )

    def test_the_dodge_replies_themselves_are_not_used_for_a_question(self):
        from app.rag.capabilities import PLEASANTRY_REPLIES

        conversation = Transcript([])

        for message in ("do you speak french?", "do you remember me?"):
            with self.subTest(message=message):
                answer = conversation.ask(message)["answer"]
                self.assertNotIn(answer, PLEASANTRY_REPLIES)

    def test_a_question_the_rules_miss_is_answered_from_the_table_anyway(self):
        # "are you an ai" matches no trigger and is not claimed by any entry, so the
        # model picks. Whatever it names, the words are the table's.
        conversation = Transcript(["That is an identity question.\nENTRY: identity"])
        done = conversation.ask("are you an ai")

        self.assertEqual(done["answer"], faq_entry("identity").answer)

    def test_a_question_no_entry_answers_says_so_and_offers_a_route(self):
        conversation = Transcript(["I have no idea what that is.\nENTRY: none"])
        done = conversation.ask("are you an ai")

        self.assertEqual(done["answer"], NOT_SURE_REPLY)
        self.assertIn("company policies", done["answer"])

    def test_an_id_the_model_invents_is_not_an_answer(self):
        conversation = Transcript(["ENTRY: telepathy"])
        done = conversation.ask("are you an ai")

        # No entry called telepathy, so there is nothing to read out. Saying so is the
        # only route that does not put an invented fact in the reply.
        self.assertEqual(done["answer"], NOT_SURE_REPLY)

    def test_an_unreachable_model_still_leaves_the_known_answers_intact(self):
        conversation = Assistant.__new__(Assistant)
        conversation._vocabulary = frozenset()

        def unreachable(*args, **kwargs):
            from app.rag.engine import LlmUnavailable

            raise LlmUnavailable("no key")

        conversation._complete = unreachable
        conversation._stream = unreachable

        # Rules reach their entries with no model call at all.
        self.assertEqual(
            conversation.meta_reply("do you understand chinese?"), LANGUAGES.answer
        )
        # And a question nothing reaches is answered honestly rather than by an
        # outage.
        self.assertEqual(conversation.meta_reply("are you an ai"), NOT_SURE_REPLY)

    def test_a_greeting_is_still_a_greeting(self):
        # The FAQ runs before the pleasantry pool, so the risk is the reverse one: a
        # greeting answered with a paragraph about capabilities.
        conversation = Transcript([])
        done = conversation.ask("hello")

        self.assertEqual(done["kind"], "conversational")
        self.assertNotIn("Internal Knowledge Assistant", done["answer"])
        self.assertNotIn("confidence", done["answer"])


class TheFaqTableTest(unittest.TestCase):
    """The table itself: closed, and honest where it does not know."""

    def test_every_entry_has_an_id_a_subject_triggers_and_an_answer(self):
        for entry in ASSISTANT_FAQ:
            with self.subTest(entry=entry.id):
                self.assertTrue(entry.id)
                self.assertTrue(entry.subject)
                self.assertTrue(entry.triggers)
                self.assertTrue(entry.answer)

    def test_the_ids_are_unique_and_look_up_only_what_exists(self):
        self.assertEqual(len(FAQ_IDS), len(set(FAQ_IDS)))

        for entry_id in FAQ_IDS:
            self.assertIsNotNone(faq_entry(entry_id), entry_id)

        self.assertIsNone(faq_entry("telepathy"))

    def test_the_unknowns_are_marked_in_the_file_and_answered_as_unknown(self):
        # A fact nobody has established has to say so. These two entries exist
        # precisely because the questions get asked and a confident invention about
        # retention or privacy would be the worst possible answer to them. The marker
        # is for whoever edits the file; the reader is told the honest thing in
        # words, because "is TODO" is not an answer to anybody.
        for entry_id in ("memory", "privacy"):
            with self.subTest(entry=entry_id):
                entry = faq_entry(entry_id)

                self.assertTrue(
                    entry.todo.startswith("TODO:"),
                    f"{entry_id} is an unknown and must be marked in the file",
                )
                self.assertNotIn("TODO", entry.answer)
                # Said in words rather than as a marker: a reader is told what the
                # assistant does not know, in the assistant's own voice.
                self.assertTrue(
                    any(
                        phrase in entry.answer.lower()
                        for phrase in ("don't know", "can't", "haven't been told")
                    ),
                    entry.answer,
                )

    def test_an_entry_with_no_unknown_carries_no_marker(self):
        for entry in ASSISTANT_FAQ:
            if entry.id in ("memory", "privacy"):
                continue

            with self.subTest(entry=entry.id):
                self.assertEqual(entry.todo, "")

    def test_nothing_claims_a_language_the_model_was_not_measured_in(self):
        # Measured: the model follows a Chinese or French question and answers it in
        # English when the context is given to it. Not measured: holding a
        # conversation in either. So no fluency is claimed.
        answer = LANGUAGES.answer.lower()

        self.assertIn("english", answer)
        self.assertNotIn("fluent", answer)
        self.assertNotIn("speaks chinese", answer)

    def test_the_hr_contact_comes_from_the_configuration(self):
        for entry_id in ("contact", "personal_records", "privacy"):
            with self.subTest(entry=entry_id):
                self.assertIn(settings.hr_email, faq_entry(entry_id).answer)

        self.assertIn(settings.hr_contact, NOTHING_TO_ADD_MSG)


# =============================================================================
# "that is chinese", and a sentence written in Chinese
# =============================================================================


class ScriptTest(unittest.TestCase):
    """A message that did not survive transmission, and one that did."""

    def test_claiming_a_language_about_latin_letters_corrects_and_answers(self):
        conversation = Transcript([])
        conversation.ask("do you understand chinese?")
        done = conversation.ask("that is chinese")

        self.assertEqual(done["kind"], "conversational")
        self.assertTrue(
            done["answer"].startswith("That came through as random letters rather than Chinese,"),
            done["answer"],
        )
        self.assertIn(LANGUAGES.answer, done["answer"])

    def test_the_correction_is_not_made_when_the_language_arrived_intact(self):
        # Nothing failed to arrive. Saying it came through as random letters would be
        # inventing a fault to be helpful.
        conversation = Transcript([])
        conversation.ask("公司的请假政策是什么？")
        done = conversation.ask("that is chinese")

        self.assertFalse(
            done["answer"].startswith("That came through as random letters"), done["answer"]
        )

    def test_a_chinese_sentence_is_answered_in_english_not_declined(self):
        conversation = Transcript([])
        done = conversation.ask("公司的请假政策是什么？")

        self.assertEqual(done["kind"], "conversational")
        self.assertEqual(done["sources"], [])
        self.assertIn("Han script", done["answer"])
        self.assertIn(LANGUAGES.answer, done["answer"])

    def test_a_french_sentence_is_not_mistaken_for_another_script(self):
        # Not a requirement of the script helper, which reads the *script*: French is
        # Latin script and cannot be told from English by it. Recorded as a limit
        # rather than papered over — what covers this reader is the languages entry,
        # which tells them to ask in English, and there is no way to get there from
        # the characters alone without a language identifier this does not have.
        conversation = Transcript(["Annual leave is 25 days.\nUSED: x"])
        done = conversation.ask("Quelle est la politique de congés de l'entreprise ?")

        self.assertNotIn("script", done["answer"])
        self.assertNotIn(LANGUAGES.answer, done["answer"])

    def test_an_arabic_and_a_cyrillic_message_are_named_by_their_script(self):
        for message, script in (
            ("مرحبا كيف احصل على إجازة", "Arabic"),
            ("Привет как взять отпуск", "Cyrillic"),
        ):
            with self.subTest(script=script):
                done = Transcript([]).ask(message)
                self.assertIn(f"{script} script", done["answer"])

    def test_a_message_that_did_not_arrive_at_all_retrieves_nothing_and_is_told_so(self):
        # The defect this replaces, measured: a Chinese question retrieved nothing
        # and the generator reported that the leave policy was not documented.
        conversation = Transcript(["NOT_FOUND"])
        done = conversation.ask("公司的请假政策是什么？")

        self.assertNotEqual(done["kind"], "not_found")
        self.assertIn("Han script", done["answer"])


# =============================================================================
# "what else" after a turn that found nothing
# =============================================================================


class ExpansionAfterAGapTest(unittest.TestCase):
    """"Anything else?" after a not_found, which is not the same as after an answer."""

    def test_it_says_there_is_nothing_to_add_and_runs_no_search(self):
        conversation = Transcript([])

        # Turn one finds nothing: the retrieval is empty, which is what a gap in the
        # corpus looks like.
        conversation.assistant.retrieval = type(
            "Empty",
            (),
            {
                "retrieve": staticmethod(lambda query: []),
                "retrieve_continuation": staticmethod(
                    lambda *args, **kwargs: (_ for _ in ()).throw(
                        AssertionError("an expansion after a gap must not search")
                    )
                ),
            },
        )()

        gap = conversation.ask("who is the head of the IT department?")
        self.assertEqual(gap["kind"], "not_found")

        done = conversation.ask("what else")

        self.assertEqual(done["kind"], "conversational")
        self.assertEqual(done["answer"], NOTHING_TO_ADD_MSG)
        self.assertEqual(done["sources"], [])
        self.assertIsNone(done["confidence"])

    def test_it_does_not_claim_the_topic_was_exhausted(self):
        # "That covers everything the documents say on this topic" is a claim about
        # documents that were never found and never read.
        conversation = Transcript([])
        conversation.assistant.retrieval = type(
            "Empty",
            (),
            {
                "retrieve": staticmethod(lambda query: []),
                "retrieve_continuation": staticmethod(lambda *args, **kwargs: []),
            },
        )()

        conversation.ask("what is the parental leave policy in Bhutan?")
        answer = conversation.ask("anything else")["answer"]

        self.assertNotIn("covers everything", answer.lower())
        self.assertIn("didn't find anything", answer)

    def test_an_acknowledgement_after_a_gap_is_still_an_acknowledgement(self):
        conversation = Transcript([])
        conversation.assistant.retrieval = type(
            "Empty",
            (),
            {"retrieve": staticmethod(lambda query: [])},
        )()

        conversation.ask("what is the parental leave policy in Bhutan?")
        done = conversation.ask("ok thanks")

        # "I didn't find anything on that" is an answer to a question, and nobody
        # asked one.
        self.assertNotEqual(done["answer"], NOTHING_TO_ADD_MSG)

    def test_no_more_info_is_still_reachable_after_a_real_answer(self):
        conversation = Transcript(["Acme has ten departments."])
        done = conversation.ask("how many departments do we have?")
        self.assertEqual(done["kind"], "answer")
        self.assertTrue(conversation.documents)

        conversation.assistant.retrieval.retrieve_continuation = (
            lambda *args, **kwargs: []
        )
        exhausted = conversation.ask("anything else")
        self.assertEqual(exhausted["kind"], "no_more_info")

        # And asking again says the same thing rather than searching.
        conversation.asked.clear()
        again = conversation.ask("what else")
        self.assertEqual(again["kind"], "no_more_info")
        self.assertEqual(conversation.asked, [])


# =============================================================================
# "how many departments" -> "anything about these departments"
# =============================================================================


class DepartmentsTranscriptTest(unittest.TestCase):
    """The full retrieval half of the transcript, against the real corpus.

    The first answer is asked for a number and is written from the passage that has
    the number. The second asks about "these departments" and must be able to read
    the passage the first one only counted from.
    """

    def setUp(self) -> None:
        # Both replies name the Departments passage by its real key, because that is
        # the passage the answer is drawn from. The first uses it only to say "ten";
        # the second reads the whole list out of it, which is what an exclusion on
        # used-chunks-only has to allow.
        boot = Transcript([])
        departments_key = boot.key_of("Departments and their roles")
        size_key = boot.key_of("Company size")

        def counting(_prompt):
            return f"Acme Technologies has ten (10) departments.\nUSED: {departments_key}"

        def listing(_prompt):
            return "\n".join(
                f"{number}. {name} — {role}"
                for number, (name, role) in enumerate(
                    [
                        ("Software Engineering", "builds client and internal applications"),
                        ("Data & AI", "data engineering, analytics and ML"),
                        ("Cloud & DevOps", "infrastructure, CI/CD and reliability"),
                        ("Quality Assurance (QA)", "manual and automated testing"),
                        ("Product & Design", "product management, UX and design"),
                        ("People & Culture (HR)", "recruitment, onboarding and L&D"),
                        ("Finance & Accounting", "budgeting, payroll and reporting"),
                        ("Sales & Business Development", "client acquisition and growth"),
                        ("Marketing & Communications", "brand, content and events"),
                        ("IT Support & Security", "internal IT, devices, VPN and security"),
                    ],
                    start=1,
                )
            ) + f"\nUSED: {departments_key}"

        self.departments_key = departments_key
        self.size_key = size_key
        self.conversation = Transcript([counting, listing])

    def test_the_count_is_answered_from_the_departments_passage_only(self):
        done = self.conversation.ask("how many departments do we have")

        self.assertEqual(done["kind"], "answer")
        self.assertEqual([source["section"] for source in done["sources"]],
                         ["Departments and their roles"])
        self.assertEqual(len(done["sources"]), 1)

    def test_the_count_answer_does_not_cite_company_size_or_cross_cutting_tools(self):
        # The defect: four passages cited for an answer whose whole content was the
        # number ten, two of which had nothing to do with departments.
        done = self.conversation.ask("how many departments do we have")

        documents = [source["document"] for source in done["sources"]]
        sections = [source["section"] for source in done["sources"]]

        self.assertNotIn("Company size", sections)
        self.assertNotIn("Cross-cutting tools", sections)
        self.assertEqual(documents, ["Company Overview"])

    def test_anything_about_these_departments_answers_about_all_ten(self):
        self.conversation.ask("how many departments do we have")
        done = self.conversation.ask("anything about these departments")

        self.assertEqual(done["kind"], "answer")
        # Every one of the ten is in the answer, which is the whole defect: two of
        # ten was what the corpus could produce when the passage was held back.
        for number in range(1, 11):
            self.assertIn(f"{number}.", done["answer"])
        self.assertIn("IT Support & Security", done["answer"])

    def test_its_source_is_the_departments_passage_the_first_answer_counted_from(self):
        self.conversation.ask("how many departments do we have")
        done = self.conversation.ask("anything about these departments")

        documents = {source["document"] for source in done["sources"]}
        self.assertIn("Company Overview", documents)
        self.assertIn(
            "Departments and their roles",
            [source["section"] for source in done["sources"]],
        )

    def test_an_elaboration_re_reads_a_passage_the_last_answer_already_used(self):
        # The difference between the two subtypes, stated as a fact about the pool:
        # "anything else" holds back what has been shown, "tell me about those" does
        # not — and the passage holding the ten departments is the one that was
        # already shown.
        self.conversation.ask("how many departments do we have")
        shown = set(self.conversation.shown)
        self.assertTrue(shown)

        conversation = Transcript([f"All ten, with their roles.\nUSED: {self.departments_key}"])
        conversation.shown = set(shown)
        conversation.documents = {"Company Overview"}
        conversation.kind = "answer"
        conversation.has_topic = True

        asked: list[tuple[str, ...]] = []
        original = conversation.assistant.retrieval.retrieve_continuation

        def spy(query, documents, already_shown, *args, **kwargs):
            asked.append(tuple(already_shown))
            return original(query, documents, already_shown, *args, **kwargs)

        conversation.assistant.retrieval.retrieve_continuation = spy
        done = conversation.ask("tell me about them")

        self.assertEqual(done["kind"], "answer")
        self.assertEqual(asked[0], (), "nothing is held back from an elaboration")

    def test_anything_else_after_the_elaboration_adds_something_else(self):
        self.conversation.ask("how many departments do we have")
        self.conversation.ask("anything about these departments")

        conversation = Transcript([f"Company size covers headcount.\nUSED: {self.size_key}"])
        conversation.shown = set(self.conversation.shown)
        conversation.documents = set(self.conversation.documents)
        conversation.kind = "answer"
        conversation.has_topic = True

        done = conversation.ask("anything else")

        if done["kind"] == "no_more_info":
            # The honest end: nothing left in those documents, and nothing said twice.
            self.assertEqual(done["sources"], [])
            return

        self.assertEqual(done["kind"], "answer")
        shown_now = {source["chunk_id"] for source in done["sources"]}
        self.assertEqual(shown_now & self.conversation.shown, set())

    def test_the_two_subtypes_are_told_apart_before_the_classifier_is_asked(self):
        conversation = self.conversation
        conversation.ask("how many departments do we have")

        for message, elaboration in (
            ("anything about these departments", True),
            ("tell me about them", True),
            ("explain that", True),
            ("details on the departments", True),
            ("anything else", False),
            ("what else", False),
            ("go on", False),
            ("what else does that say", False),
        ):
            with self.subTest(message=message):
                classification = conversation.assistant.classify(
                    message, conversation.history, conversation.previous
                )
                self.assertEqual(classification.category, Category.EXPANSION)
                self.assertEqual(classification.elaboration, elaboration)


# =============================================================================
# Citations
# =============================================================================


class CitationTest(unittest.TestCase):
    """Only the passages the answer used, numbered in the order they are shown."""

    def sources(self):
        return [
            {"document": "Company Overview", "section": "Departments", "chunk_id": "a1", "score": 0.6},
            {"document": "Technical Departments", "section": "Tools", "chunk_id": "b2", "score": 0.9},
            {"document": "Company Overview", "section": "Company size", "chunk_id": "c3", "score": 0.8},
            {"document": "IT & VPN Setup Guide", "section": "Before you start", "chunk_id": "d4", "score": 0.7},
        ]

    def test_only_the_reported_keys_are_displayed(self):
        shown = _displayed_sources(self.sources(), frozenset({"a1"}))

        self.assertEqual([source["chunk_id"] for source in shown], ["a1"])

    def test_an_unknown_key_is_discarded_rather_than_persisted(self):
        # A key that was never offered would be a citation naming a passage the
        # reader cannot be shown, and would then be held back from "anything else?".
        shown = _displayed_sources(self.sources(), frozenset({"a1", "nope", "b2"}))

        self.assertEqual({source["chunk_id"] for source in shown}, {"a1", "b2"})

    def test_nothing_validating_falls_back_to_the_best_two(self):
        shown = _displayed_sources(self.sources(), frozenset())

        self.assertEqual([source["chunk_id"] for source in shown], ["b2", "c3"])
        self.assertEqual(len(shown), 2)

    def test_passages_of_one_document_are_shown_together_and_in_order(self):
        # Grouped by document on the card, so interleaved passages are displayed
        # 1, 3, 2: the third belongs under the first document's heading.
        shown = _displayed_sources(self.sources(), frozenset({"a1", "b2", "c3", "d4"}))

        self.assertEqual(
            [source["document"] for source in shown],
            [
                "Company Overview",
                "Company Overview",
                "Technical Departments",
                "IT & VPN Setup Guide",
            ],
        )
        self.assertEqual(
            [source["section"] for source in shown],
            ["Departments", "Company size", "Tools", "Before you start"],
        )

    def test_each_displayed_passage_is_marked_as_used(self):
        for source in _displayed_sources(self.sources(), frozenset({"a1"})):
            self.assertTrue(source["used"])

    def test_the_usage_line_is_read_out_of_the_answer(self):
        text, used = _split_used_keys(
            "There are ten.\nUSED: a1, b2", self.sources()
        )

        self.assertEqual(text, "There are ten.")
        self.assertEqual(used, frozenset({"a1", "b2"}))

    def test_the_usage_line_never_reaches_the_reader(self):
        text, _ = _split_used_keys("There are ten.\nUSED: 1", self.sources())

        self.assertNotIn("USED", text)
        self.assertNotIn("a1", text)

    def test_a_passage_number_resolves_to_the_same_key(self):
        # The model is shown the passages numbered; a number is a convenience for
        # copying and is resolved to the key it names, so both routes agree.
        _, by_number = _split_used_keys("Ten.\nUSED: 1, 2", self.sources())
        _, by_key = _split_used_keys("Ten.\nUSED: a1, b2", self.sources())

        self.assertEqual(by_number, by_key)

    def test_punctuation_around_a_key_does_not_discard_it(self):
        _, used = _split_used_keys("Ten.\nUSED: a1, b2, c3.", self.sources())

        self.assertEqual(used, frozenset({"a1", "b2", "c3"}))

    def test_an_answer_with_no_usage_line_still_shows_evidence(self):
        text, used = _split_used_keys("There are ten.", self.sources())

        self.assertEqual(text, "There are ten.")
        self.assertEqual(used, frozenset())
        self.assertEqual(len(_displayed_sources(self.sources(), used)), 2)

    def test_the_grounding_count_is_the_documents_that_are_shown(self):
        # "Grounded in N documents" is counted from the displayed passages, so an
        # answer that used one passage of one document does not claim four.
        shown = _displayed_sources(self.sources(), frozenset({"a1"}))

        self.assertEqual(len({source["document"] for source in shown}), 1)


# =============================================================================
# "heyjffdk hdj this", then "hjsls jhjs lksk jdfkld;"
# =============================================================================


class MixedGibberishTest(unittest.TestCase):
    """A stray real word used to disqualify the whole message."""

    def test_a_message_that_is_mostly_not_words_is_unreadable(self):
        conversation = Transcript([])
        first = conversation.ask("heyjffdk hdj this")

        self.assertEqual(first["kind"], "conversational")
        self.assertTrue(first["answer"].startswith(UNREADABLE_OPENINGS[0]))

    def test_the_second_one_offers_examples_rather_than_the_shrug_again(self):
        conversation = Transcript([])
        conversation.ask("heyjffdk hdj this")
        second = conversation.ask("hjsls jhjs lksk jdfkld;")

        self.assertEqual(second["kind"], "conversational")
        self.assertTrue(second["answer"].startswith(UNREADABLE_SECOND_START), second["answer"])
        # The examples rotate with how many there have been, so the second in a row
        # shows the second and third rather than repeating the first pair.
        self.assertIn("How do I set up the VPN?", second["answer"])
        self.assertIn("How do I report a phishing email?", second["answer"])

    def test_the_third_stops_trying(self):
        conversation = Transcript([])
        conversation.ask("heyjffdk hdj this")
        conversation.ask("hjsls jhjs lksk jdfkld;")
        third = conversation.ask("qwe rty uio pgh")

        self.assertTrue(third["answer"].startswith(UNREADABLE_THIRD_START), third["answer"])

    def test_a_real_question_with_a_stray_unknown_word_is_still_answered(self):
        conversation = Transcript(["Annual leave is 25 days.\nUSED: 1"])
        done = conversation.ask("how many sick days do I get?")

        self.assertEqual(done["kind"], "answer")
        self.assertNotIn(UNREADABLE_OPENINGS[0], done["answer"])

    def test_the_streak_is_read_from_the_messages_not_kept_in_memory(self):
        # Two conversations, two assistants: the count belongs to the thread.
        from app.rag.capabilities import unreadable_reply

        self.assertNotEqual(unreadable_reply(1, 0), unreadable_reply(2, 1))
        self.assertTrue(unreadable_reply(2, 1).startswith(UNREADABLE_SECOND_START))


UNREADABLE_SECOND_START = "Still not catching it"
UNREADABLE_THIRD_START = "No rush"


# =============================================================================
# CHECK, THEN DECIDE: "who is the head of the IT department?"
# =============================================================================


class DepartmentHeadTest(unittest.TestCase):
    """Whether `not_found` is the right answer, and what it must stay.

    Decided by reading the corpus rather than by tuning: if a document named the head
    of a department, this would be a retrieval defect and the right chunk's vector
    and keyword scores would be worth reporting. It names none — the corpus contains
    no individual at all — so `not_found` is the truth and the only thing to do is to
    say so.
    """

    IT_QUESTION = "who is the head of the IT department?"

    def test_no_document_in_the_corpus_names_a_person(self):
        from app.rag.ingest import load_documents

        documents = load_documents(settings.data_dir)
        self.assertTrue(documents, "the corpus should not be empty")

        # Every document names an owning *team* or an office, and never an
        # individual: that is the whole finding.
        for document in documents:
            with self.subTest(document=document.metadata.get("policy_title", "")):
                self.assertNotRegex(
                    document.get_content(), r"\b(?:headed by|leads the|report to)\b"
                )

    def test_it_is_an_expected_gap_rather_than_a_miss(self):
        conversation = Transcript(["NOT_FOUND"])
        conversation.assistant.retrieval = type(
            "Empty",
            (),
            {
                "retrieve": staticmethod(lambda query: []),
                "retrieve_continuation": staticmethod(lambda *args, **kwargs: []),
            },
        )()

        done = conversation.ask(self.IT_QUESTION)

        self.assertEqual(done["kind"], "not_found")
        self.assertEqual(done["sources"], [])
        self.assertIn(settings.hr_email, done["answer"])

    def test_the_golden_set_carries_it_as_an_expected_not_found(self):
        from tests.test_hybrid_retrieval import EXPECTED_GAPS

        self.assertIn(self.IT_QUESTION, EXPECTED_GAPS)
        # And every one of them names a document that exists, so the expectation is
        # "the corpus does not hold this" rather than "the corpus is broken".
        for question, why in EXPECTED_GAPS.items():
            with self.subTest(question=question):
                self.assertTrue(why.strip())


if __name__ == "__main__":
    unittest.main()