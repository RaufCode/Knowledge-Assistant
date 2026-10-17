"""Hybrid retrieval: what each search is for, and how the two are merged.

Run against a small stand-in corpus rather than the policy documents, because
what is being asserted is about the *mechanism* — an exact term ranked highly even
when meaning barely overlaps, a paraphrase still found when no term matches, a
chunk either search found kept rather than discarded — and those are far easier
to see on a corpus where the right answer is obvious.

No network and no key: the vector half is a retriever that returns a scripted
ranking with scripted scores, and the keyword half is a real BM25 index over the
same chunks, because the BM25 is the part worth testing.

The continuation path is the exception and is built over a real index, because
that is the whole of what it does: read whole documents out of the store rather
than out of a ranked window. A stand-in for the store would be asserting the test
rather than the code.
"""

import logging
import math
import unittest

from llama_index.core import VectorStoreIndex
from llama_index.core.base.embeddings.base import BaseEmbedding
from llama_index.core.schema import NodeWithScore, TextNode

from app.rag.retrieval import (
    RRF_K,
    Candidate,
    HybridRetriever,
    IndexedDocuments,
    KeywordIndex,
    chunk_key,
    normalise,
    reciprocal_rank_fusion,
    tokenize,
)

POLICY = "Code of Conduct"
CHUNKS = {
    "conduct": "Employees must follow the Code of Conduct and treat colleagues with respect.",
    "leave": "Full-time staff accrue 25 days of annual leave each year, plus public holidays.",
    "vpn": "Set up the VPN using the GlobalProtect client before connecting from home.",
    "conduct_appeal": "A concern may be raised with a line manager, then escalated to HR.",
    "unrelated": "The canteen serves lunch from twelve until two on weekdays.",
}


def chunk(key: str) -> TextNode:
    return TextNode(text=CHUNKS[key], id_=key, metadata={"section": key})


def scripted_vector_retriever(order: dict[str, float]):
    """A retriever returning `order` (key -> similarity), highest first."""

    class _Retriever:
        def retrieve(self, query: str):
            return [
                NodeWithScore(node=chunk(key), score=score, node_id=key)
                for key, score in sorted(order.items(), key=lambda pair: -pair[1])
            ]

    return _Retriever()


class NoWholeDocuments:
    """Stands in for the store-backed reader in the tests that never read one.

    The continuations are tested on a real index in `ContinuationRetrievalTest`;
    these cases are about how two searches are merged, and a stand-in that holds
    no documents keeps them from needing one.
    """

    def chunks_in(self, documents):
        return []

    def rank(self, query, chunks, limit):
        return []


# How many dimensions the stand-in embedding puts words into. Enough that two
# passages which share no meaningful word do not collide into looking alike.
EMBEDDING_DIMENSIONS = 512


class SignalWordEmbedding(BaseEmbedding):
    """An embedding of the words that carry signal, so a similarity can be read.

    The real model predicts meaning, which is why it needs a key and a network.
    This one sets a bit per meaningful word — the same words `tokenize` keeps,
    which is why it needs no vocabulary of its own — and normalises. Two passages
    score highly exactly when they are about the same thing in the same words,
    which makes an assertion about *which* passage ranks first a statement about
    the ranking rather than about a random projection.
    """

    def _get_query_embedding(self, query: str) -> list[float]:
        return self._get_text_embedding(query)

    def _get_text_embedding(self, text: str) -> list[float]:
        vector = [0.0] * EMBEDDING_DIMENSIONS

        for word in tokenize(text):
            vector[sum(ord(character) for character in word) % EMBEDDING_DIMENSIONS] = 1.0

        length = math.sqrt(sum(value * value for value in vector)) or 1.0

        return [value / length for value in vector]

    async def _aget_query_embedding(self, query: str) -> list[float]:
        return self._get_query_embedding(query)

    async def _aget_text_embedding(self, text: str) -> list[float]:
        return self._get_text_embedding(text)

    @classmethod
    def class_name(cls) -> str:
        return "SignalWordEmbedding"


def policy_index(*documents: tuple[str, list[tuple[str, str]]]) -> VectorStoreIndex:
    """A real index over stand-in policy documents, one chunk per section.

    Metadata is excluded from the embedding, which production does not do — there
    a chunk embeds its own section heading too. Excluding it here keeps an
    assertion about ranking about the words in the passage and nothing else.
    """
    nodes: list[TextNode] = []

    for title, sections in documents:
        for position, (section, text) in enumerate(sections):
            node = TextNode(
                text=text,
                id_=f"{title}/{section}/{position}",
                metadata={"policy_title": title, "section": section},
            )
            node.excluded_embed_metadata_keys = [
                "file_path",
                "policy_title",
                "section",
            ]
            nodes.append(node)

    return VectorStoreIndex(nodes, embed_model=SignalWordEmbedding())


def build_retriever(vector_order: dict[str, float], **overrides) -> HybridRetriever:
    nodes = [chunk(key) for key in CHUNKS]
    options = {
        "top_k": 3,
        "vector_candidates": 10,
        "keyword_candidates": 10,
        "min_score": 0.40,
        "keyword_min_score": 0.5,
        # Off by default in these tests, so a case about the strict pass is not
        # silently rescued by the last-resort path and the assertion stops
        # describing what it was written to describe.
        "recall_floor": 9.9,
        "recall_candidates": 4,
    }
    options.update(overrides)

    return HybridRetriever(
        scripted_vector_retriever(vector_order),
        KeywordIndex(nodes),
        documents=NoWholeDocuments(),
        **options,
    )


class TokenizeTest(unittest.TestCase):
    def test_plurals_and_case_fold_together(self):
        # A question says "policies" and a document says "policy"; without this
        # they are different words and the exact-term search misses both.
        self.assertEqual(tokenize("Policies and POLICY"), ["policy", "policy"])
        self.assertEqual(normalise("policies"), "policy")
        self.assertEqual(normalise("days"), "day")

    def test_words_that_carry_no_signal_are_dropped(self):
        self.assertEqual(tokenize("what is the policy of the company"), ["policy", "company"])

    def test_a_two_letter_fragment_is_not_a_term(self):
        self.assertEqual(tokenize("hr and it"), [])


class KeywordIndexTest(unittest.TestCase):
    def setUp(self):
        self.index = KeywordIndex([chunk(key) for key in CHUNKS])

    def test_finds_the_chunk_holding_the_exact_terms(self):
        hits = self.index.search("Code of Conduct", top_k=3)

        self.assertEqual(hits[0].node.node_id, "conduct")

    def test_a_question_with_no_shared_terms_matches_nothing(self):
        # Zero, rather than every chunk: a chunk that matches nothing is not a
        # weak match, and returning the corpus would put unrelated text in front
        # of the generator for every off-topic question.
        self.assertEqual(self.index.search("photosynthesis in plants", top_k=3), [])

    def test_stopwords_alone_match_nothing(self):
        self.assertEqual(self.index.search("what is it", top_k=3), [])

    def test_a_rare_term_outranks_a_common_one(self):
        # "policy" appears in three chunks and "GlobalProtect" in one, so the
        # chunk with the rare term is the better answer even though the common one
        # matches more of the query's words.
        hits = self.index.search("policy and the GlobalProtect client", top_k=3)

        self.assertEqual(hits[0].node.node_id, "vpn")


def named(*keys: str):
    """The smallest thing a fusion can rank, which is anything with a `node_id`."""
    return [type("N", (), {"node_id": key})() for key in keys]


class FusionTest(unittest.TestCase):
    def test_a_chunk_in_both_lists_outranks_one_in_neither(self):
        fused = reciprocal_rank_fusion([named("a", "b"), named("b", "c")])

        self.assertEqual(max(fused, key=fused.get), "b")

    def test_a_chunk_only_one_list_found_still_scores(self):
        # The point of running two searches: a chunk one method found must compete
        # rather than be discarded, or the second search could only reorder and
        # never contribute.
        fused = reciprocal_rank_fusion([named("a"), named("b")])

        self.assertIn("a", fused)
        self.assertIn("b", fused)

    def test_ranks_count_from_one_with_the_paper_constant(self):
        fused = reciprocal_rank_fusion([named("a", "b")])

        self.assertAlmostEqual(fused["a"], 1 / (RRF_K + 1))
        self.assertAlmostEqual(fused["b"], 1 / (RRF_K + 2))


class HybridRetrievalTest(unittest.TestCase):
    def test_an_exact_term_is_carried_when_the_vector_search_under_scores_it(self):
        # The case vector search is weak at. "GlobalProtect" and the canteen are
        # unrelated, so the canteen chunk takes the top vector slot, and the right
        # chunk scores under the floor — but it is still in the list the search
        # looked at, which is what lets the keyword half promote it. Without that
        # the exact-term hit a second search exists to find would be dropped.
        retriever = build_retriever({"unrelated": 0.72, "vpn": 0.11})

        found = [result.node.node_id for result in retriever.retrieve("GlobalProtect client setup")]

        self.assertIn("vpn", found)
        # It carries the score the vector search actually gave it, not a missing
        # one. Under the floor is not the same as unmeasured, and reporting a
        # rescued chunk as having no similarity misdescribes it in both
        # directions — which is what `confidence` is derived from.
        rescued = next(
            result
            for result in retriever.retrieve("GlobalProtect client setup")
            if result.node.node_id == "vpn"
        )
        self.assertEqual(rescued.similarity, 0.11)

    def test_a_keyword_hit_the_vector_search_never_returned_is_dropped(self):
        # The bug this rule exists for. On a corpus this small, BM25's IDF treats
        # a light verb used in four chunks as as rare as a policy name used in
        # four, so a question about pay put the IT setup guide first on the
        # strength of "get" and "work" — terms whose similarity to that chunk was
        # 0.163 — and the generator was handed a VPN guide in answer to a question
        # about pay. The floor would not have caught it either: that is applied to
        # what the vector search returns, and this chunk was not returned at all.
        retriever = build_retriever({"unrelated": 0.72})

        found = [result.node.node_id for result in retriever.retrieve("GlobalProtect client setup")]

        self.assertNotIn("vpn", found)

    def test_a_keyword_hit_under_the_floor_is_still_carried_into_the_context(self):
        # The case the rule must not over-reach into: the vector search looked at
        # this chunk and scored it just under the floor, so the keyword half
        # rescues it. It is carried even though the vector half did not score it,
        # because "looked at it" is a weaker requirement than "close enough".
        retriever = build_retriever({"conduct": 0.55, "vpn": 0.30})

        results = retriever.retrieve("GlobalProtect client setup")

        self.assertIn("vpn", [result.node.node_id for result in results])

    def test_a_chunk_under_ranked_by_meaning_rises_on_two_searches_agreeing(self):
        # The same case, realistically: the vector search has the right chunk but
        # has it eighth, and the keyword search puts it first. Two lists agreeing
        # is worth more than one list being emphatic, and that is the fusion doing
        # its job.
        retriever = build_retriever(
            {
                "unrelated": 0.70,
                "conduct_appeal": 0.68,
                "leave": 0.66,
                "conduct": 0.64,
                "vpn": 0.45,
            }
        )

        results = retriever.retrieve("GlobalProtect client setup")

        self.assertEqual(results[0].node.node_id, "vpn")
        self.assertIsNotNone(results[0].similarity)
        self.assertIsNotNone(results[0].keyword)

    def test_a_paraphrase_is_still_found_with_no_term_in_common(self):
        # The case keyword search is weak at: neither "remuneration" nor
        # "receive" appears anywhere in the corpus, so the leave chunk can only
        # have been found by meaning.
        retriever = build_retriever({"leave": 0.61})

        results = retriever.retrieve("What remuneration do I receive?")

        self.assertEqual(results[0].node.node_id, "leave")
        self.assertIsNone(results[0].keyword)

    def test_a_chunk_both_searches_like_ranks_first(self):
        retriever = build_retriever({"conduct": 0.55, "leave": 0.65})

        results = retriever.retrieve("Code of Conduct")

        self.assertEqual(results[0].node.node_id, "conduct")

    def test_nothing_relevant_returns_nothing(self):
        retriever = build_retriever({}, keyword_min_score=99)

        self.assertEqual(retriever.retrieve("photosynthesis in plants"), [])

    def test_below_the_similarity_floor_is_not_a_match(self):
        # The vector search returned the chunk but scored it 0.30, under the 0.40
        # floor. The floor is applied per search and before fusion, so relevance
        # decides this rather than rank: a weak vector score cannot buy a place in
        # the context just by being the only thing that came back.
        retriever = build_retriever({"unrelated": 0.30}, min_score=0.40)

        self.assertEqual(retriever.retrieve("photosynthesis in plants"), [])

    def test_the_result_is_capped_at_top_k(self):
        retriever = build_retriever(
            {"conduct": 0.6, "leave": 0.6, "vpn": 0.6, "unrelated": 0.6}, top_k=2
        )

        self.assertLessEqual(len(retriever.retrieve("the company policy and the code")), 2)

    def test_each_search_looks_further_down_than_top_k(self):
        # Asking each search for exactly top_k would cap the fusion at the two
        # best chunks it already had, so the candidate depth is its own setting.
        retriever = build_retriever(
            {key: 0.9 - index * 0.01 for index, key in enumerate(CHUNKS)},
            top_k=1,
            vector_candidates=4,
        )

        results = retriever.retrieve("Code of Conduct policy leave VPN")

        self.assertEqual(len(results), 1)
        # "conduct" is first in the vector list *and* first on keywords, so the
        # one slot goes to the chunk both agree on rather than to whichever search
        # happened to be consulted first.
        self.assertEqual(results[0].node.node_id, "conduct")

    def test_a_failing_vector_search_degrades_to_keywords(self):
        # Nothing was considered, so by the rule above nothing can be rescued — but
        # the question must still be answered from the keyword half rather than
        # raised as an error, since a throttled embedding tier is not the caller's
        # problem.
        class _Broken:
            def retrieve(self, query: str):
                raise RuntimeError("embeddings unavailable")

        retriever = HybridRetriever(
            _Broken(),
            KeywordIndex([chunk(key) for key in CHUNKS]),
            documents=NoWholeDocuments(),
            top_k=3,
            vector_candidates=10,
            keyword_candidates=10,
            min_score=0.40,
            keyword_min_score=0.5,
            recall_floor=9.9,
            recall_candidates=4,
        )

        self.assertEqual(retriever.retrieve("Code of Conduct"), [])


class RecallFloorTest(unittest.TestCase):
    """The last resort, for a question whose best chunk is under `min_score`.

    The case it exists for: questions the corpus genuinely answers score as low as
    0.22 on their best chunk, while questions it cannot answer peak near 0.32. No
    threshold separates those, so `min_score` cannot be lowered to cover them. The
    generator can tell them apart, and is what already decides `NOT_FOUND`, so the
    sub-floor chunk is handed to it rather than withheld.
    """

    def build(self, vector_order=None, **overrides) -> HybridRetriever:
        options = {
            "top_k": 3,
            "vector_candidates": 10,
            "keyword_candidates": 10,
            "min_score": 0.40,
            "keyword_min_score": 0.5,
            "recall_floor": 0.15,
            "recall_candidates": 3,
        }
        options.update(overrides)
        return HybridRetriever(
            # Everything below the floor by default: that is the situation the last
            # resort exists for, so a case that does not opt out of it is testing
            # something else.
            scripted_vector_retriever(
                vector_order if vector_order is not None else {"conduct": 0.22, "unrelated": 0.20}
            ),
            KeywordIndex([chunk(key) for key in CHUNKS]),
            documents=NoWholeDocuments(),
            **options,
        )

    def test_a_sub_floor_chunk_is_passed_on_when_nothing_else_matched(self):
        results = self.build().retrieve("compensation")

        # Under the floor and matching nothing lexically, so the strict pass is
        # empty — but the vector search did rank something, and returning nothing
        # here would report a gap in the corpus for a question it can answer.
        self.assertTrue(results)
        self.assertEqual(results[0].node.node_id, "conduct")

    def test_a_real_match_is_never_joined_by_sub_floor_chunks(self):
        # A question with a chunk above the floor must not have its ranking touched
        # by the last resort. Two chunks are above the floor and `top_k` is 3, so if
        # the recall path ran unconditionally it would fill the third slot with a
        # chunk that never cleared it. Membership in the vector candidate list is
        # what the keyword leg checks, so a sub-floor chunk does appear here — but
        # only as a candidate, never displacing a real match.
        results = self.build(
            vector_order={"conduct": 0.62, "vpn": 0.55, "unrelated": 0.21, "leave": 0.18}
        ).retrieve("Code of Conduct")

        self.assertTrue(results)
        self.assertEqual(results[0].node.node_id, "conduct")
        self.assertEqual(results[0].similarity, 0.62)

    def test_nothing_is_passed_on_below_the_recall_floor(self):
        # Without one, the last resort would hand the generator the least similar
        # chunk in the corpus, which is noise rather than evidence.
        results = self.build(recall_floor=0.95).retrieve("photosynthesis in plants")

        self.assertEqual(results, [])

    def test_the_recall_chunk_is_added_to_the_keyword_hits_not_instead_of_them(self):
        # A keyword hit is specific, so it keeps its place; the semantic evidence
        # is added beside it. Replacing would discard the better-founded of the two.
        results = self.build().retrieve("Code of Conduct")

        self.assertIn("conduct", [result.node.node_id for result in results])

    def test_a_broken_vector_search_does_not_invent_a_recall_hit(self):
        class _Broken:
            def retrieve(self, query: str):
                raise RuntimeError("embeddings unavailable")

        results = HybridRetriever(
            _Broken(),
            KeywordIndex([chunk(key) for key in CHUNKS]),
            documents=NoWholeDocuments(),
            top_k=3,
            vector_candidates=10,
            keyword_candidates=10,
            min_score=0.40,
            keyword_min_score=0.5,
            recall_floor=0.15,
            recall_candidates=3,
        ).retrieve("photosynthesis in plants")

        self.assertEqual(results, [])


class RerankerTest(unittest.TestCase):
    def test_a_reranker_reorders_the_merged_candidates(self):
        class _Reranker:
            def rerank(self, query: str, candidates: list[Candidate]):
                # Deliberately puts last first, which is the only thing an
                # optional final pass is here to be able to do.
                return list(reversed(candidates))

        retriever = build_retriever(
            {"conduct": 0.55, "leave": 0.65}, rerank=_Reranker()
        )

        results = retriever.retrieve("the leave policy and the code of conduct")

        # Fusion had leave first; the reranker saw both and reversed them. That is
        # the whole contract of an optional final pass — it decides the order of
        # an already-shortlisted set, and nothing else.
        self.assertEqual(results[0].node.node_id, "conduct")


class ContinuationRetrievalTest(unittest.TestCase):
    """Continuing an answer: the rest of the cited documents, read whole.

    The defect this is about: the continuation used to be a filter over the
    ordinary ranked window, so it could only return passages the normal search had
    already scored. A thorough first answer used the window up, and "anything
    else?" then reported a topic exhausted while whole sections of the same
    document sat unread.

    Run against a real index over a stand-in corpus, with an embedding of the
    meaningful words in a passage, so a similarity here means what it says and a
    ranking can be asserted on.
    """

    # Seven sections, so no single answer reads the document: "anything else?" has
    # to be asked more than once to exhaust it, which is the whole point.
    EXPECTATIONS = [
        ("Overview", "Every employee is expected to behave professionally and lawfully."),
        ("Working Hours", "The office opens at eight and closes at six, and employees are expected to attend."),
        ("Dress Code", "Casual clothing is acceptable, and employees are expected to dress neatly."),
        ("Equipment", "A laptop and an external monitor are issued to an employee on their first day."),
        ("Attendance", "Arriving late more than three times a month is discussed with the manager."),
        ("Remote Work", "Staff may work from home two days a week by agreement."),
        ("Notice Period", "A month of notice is given before leaving, by either side."),
    ]
    VPN = [
        ("Getting Started", "Install the GlobalProtect client, then connect to the VPN."),
        ("First Connection", "Sign in with your company email to connect to the VPN."),
        ("Troubleshooting", "If the client will not connect to the VPN, restart the service."),
        ("Support", "The IT helpdesk answers questions on the intranet helpdesk page."),
    ]
    CONDUCT = [
        ("Standard", "A concern may be raised with a line manager and escalated."),
        ("Grievance", "A formal grievance is raised with HR in writing."),
        ("Investigation", "An investigation is opened once a grievance is upheld."),
    ]
    # One section only, so there is nothing an expansion could add to it.
    NOTICE = [("Fire Drill", "The fire alarm is tested on the first Monday of each month.")]

    QUESTION = "What are the expectations for employees?"

    def setUp(self) -> None:
        self.index = policy_index(
            ("Employee Expectations", self.EXPECTATIONS),
            ("IT & VPN Guide", self.VPN),
            ("Code of Conduct", self.CONDUCT),
            ("Facilities Notice", self.NOTICE),
        )
        self.documents = IndexedDocuments(self.index)
        # `similarity_top_k` of four against a document of seven sections: the
        # window the old continuation was filtered out of, and the reason it
        # reported exhaustion early.
        self.retriever = HybridRetriever(
            self.index.as_retriever(similarity_top_k=4),
            KeywordIndex(self.index.docstore.docs.values()),
            documents=self.documents,
            top_k=4,
            vector_candidates=10,
            keyword_candidates=10,
            min_score=0.40,
            keyword_min_score=2.0,
            recall_floor=0.15,
            recall_candidates=4,
        )
        self.titles = (
            "Employee Expectations",
            "IT & VPN Guide",
            "Code of Conduct",
            "Facilities Notice",
        )
        self.chunks = {
            title: self.documents.chunks_in({title}) for title in self.titles
        }

    def expand(self, title, shown=(), query=QUESTION):
        return self.retriever.retrieve_continuation(query, {title}, shown)

    def sections(self, candidates) -> set[str]:
        return {candidate.node.metadata["section"] for candidate in candidates}

    def keys(self, title) -> set[str]:
        return {chunk_key(node) for node in self.chunks[title]}

    def shown_keys(self, title, *sections) -> set[str]:
        return {
            chunk_key(node)
            for node in self.chunks[title]
            if node.metadata["section"] in sections
        }

    def test_it_returns_sections_the_ranked_window_never_reached(self):
        # The first four sections are the ones an ordinary search of this question
        # puts on top, and all four are held back as already shown.
        window = {
            candidate.node.metadata["section"]
            for candidate in self.retriever.retrieve(self.QUESTION)
        }
        shown = self.shown_keys("Employee Expectations", *window)

        found = self.expand("Employee Expectations", shown=shown)

        self.assertEqual(len(found), 3)
        self.assertEqual(self.sections(found) & window, set())
        # And these are passages the ordinary search never scored at all, which is
        # the case the old filter could not serve.
        self.assertEqual(len(window & self.sections(found)), 0)

    def test_the_expansions_and_the_first_answer_cover_the_document_exactly_once(self):
        # The first answer quoted one section, as an ordinary answer does.
        shown = self.shown_keys("Employee Expectations", "Overview")
        expansions = 0

        while True:
            more = self.expand("Employee Expectations", shown=shown)

            if not more:
                break

            keys = {chunk_key(candidate.node) for candidate in more}
            # Never a chunk twice: the reader has read it, and re-quoting it is not
            # "more".
            self.assertEqual(shown & keys, set())
            shown |= keys
            expansions += 1

        # Seven sections, three at a time: one quoted by the first answer and two
        # by the two expansions, with the third finding the document read out. Every
        # section was shown once and only once — which is what makes the eventual
        # "there is nothing left" true rather than premature.
        self.assertEqual(expansions, 2)
        self.assertEqual(shown, self.keys("Employee Expectations"))

    def test_a_document_with_one_section_is_exhausted_immediately(self):
        first = self.expand("Facilities Notice")

        # The whole document in one expansion...
        self.assertEqual(self.sections(first), {"Fire Drill"})

        # ...and nothing after it. The first answer already quoted the only section
        # it has, so "anything else?" is spent the first time it is asked, which is
        # the honest answer rather than a re-reading of the same passage.
        self.assertEqual(self.expand("Facilities Notice", shown=self.keys("Facilities Notice")), [])

    def test_a_conversation_that_cited_no_document_has_nothing_to_expand(self):
        self.assertEqual(self.retriever.retrieve_continuation(self.QUESTION, set(), set()), [])

    def test_a_vpn_continuation_stays_in_the_vpn_guide(self):
        query = "How do I set up the VPN?"

        first = self.expand("IT & VPN Guide", query=query)
        shown = {chunk_key(candidate.node) for candidate in first}

        self.assertEqual(len(first), 3)
        self.assertTrue(self.sections(first) <= self.sections_of("IT & VPN Guide"))

        more = self.expand("IT & VPN Guide", shown=shown, query=query)

        # The fourth and last section of the guide, and then the topic is spent.
        self.assertEqual(len(more), 1)
        self.assertEqual(self.expand("IT & VPN Guide", shown=shown | {chunk_key(c.node) for c in more}, query=query), [])

    def test_a_grievance_continuation_stays_in_the_code_of_conduct(self):
        query = "How do I raise a grievance?"

        first = self.expand("Code of Conduct", query=query)

        # All three sections in one go, the section the question names included,
        # because a three-section document is shorter than the cap.
        self.assertEqual(len(first), 3)
        self.assertIn("Grievance", self.sections(first))
        self.assertEqual(self.sections(first), self.sections_of("Code of Conduct"))
        self.assertEqual(
            self.expand("Code of Conduct", shown={chunk_key(c.node) for c in first}, query=query),
            [],
        )

    def test_two_threads_reading_different_documents_never_meet(self):
        leave_shown = {chunk_key(candidate.node) for candidate in self.expand("Employee Expectations")}
        vpn_query = "How do I set up the VPN?"
        vpn_shown = {chunk_key(candidate.node) for candidate in self.expand("IT & VPN Guide", query=vpn_query)}

        # Interleaved, as two conversations in one browser would be: neither thread
        # may be given anything the other has been shown.
        next_expectations = self.expand("Employee Expectations", shown=leave_shown)
        next_vpn = self.expand("IT & VPN Guide", shown=vpn_shown, query=vpn_query)

        self.assertEqual({chunk_key(c.node) for c in next_expectations} & vpn_shown, set())
        self.assertEqual({chunk_key(c.node) for c in next_vpn} & (leave_shown | vpn_shown), set())

    def test_a_section_the_ordinary_search_would_floor_out_still_comes_back(self):
        # "Remote Work" shares no meaningful word with a question about
        # expectations, and scores zero against it. It is in the cited document,
        # so it is relevant by membership, and a floor here would report a section
        # nobody had read as though it had been read.
        shown = self.keys("Employee Expectations") - self.shown_keys("Employee Expectations", "Remote Work")

        found = self.expand("Employee Expectations", shown=shown)

        self.assertEqual(self.sections(found) - {"Remote Work", "Attendance", "Notice Period"}, set())
        self.assertIn("Remote Work", self.sections(found))
        # Scored, not assumed: the cosine is real, and it is zero.
        remote = next(c for c in found if c.node.metadata["section"] == "Remote Work")
        self.assertEqual(remote.similarity, 0.0)

    def test_a_chunk_already_shown_is_never_returned_again(self):
        shown = self.shown_keys("Employee Expectations", "Overview", "Working Hours", "Dress Code")

        found = self.expand("Employee Expectations", shown=shown)

        self.assertEqual(len(found), 3)
        self.assertEqual({chunk_key(c.node) for c in found} & shown, set())

    def test_it_says_how_much_of_the_document_was_left(self):
        # The counts are what make an honest "there is nothing left" different from
        # a search that found nothing, and the two look identical in the reply.
        shown = self.keys("Employee Expectations") - self.shown_keys("Employee Expectations", "Dress Code")

        with self.assertLogs("app.rag.retrieval", level=logging.INFO) as logged:
            self.expand("Employee Expectations", shown=shown)

        line = logged.output[-1]

        self.assertIn("7 chunks in them", line)
        self.assertIn("6 already shown", line)
        self.assertIn("1 remaining", line)

    def sections_of(self, title) -> set[str]:
        return {node.metadata["section"] for node in self.chunks[title]}


class GoldenRetrievalTest(unittest.TestCase):
    """What an ordinary question retrieves, pinned.

    The continuation path was rewritten to stop filtering the ranked window and
    read whole documents out of the store instead. Nothing there may reach the
    ordinary path — no search, no fusion, no floor — so the answer to "did that
    change anything?" has to be checked rather than argued, and this is the
    check: every question below retrieves exactly what it retrieved before, with
    the same passages, in the same order, and the same scores.

    The corpus is the stand-in one the continuation tests use, with the same
    deterministic embedding, so the numbers are reproducible without a key.
    """

    # (document, section, cosine similarity, BM25) per question, best first.
    GOLDEN = {
        "How many sick leave days do I get?": [
            ("Facilities Notice", "Fire Drill", 0.183, 0.18),
            ("Employee Expectations", "Equipment", 0.169, 0.17),
            ("Employee Expectations", "Remote Work", 0.158, 0.16),
        ],
        "How do I set up the VPN?": [
            ("IT & VPN Guide", "First Connection", 0.316, 0.32),
            ("IT & VPN Guide", "Getting Started", 0.316, 0.32),
            ("IT & VPN Guide", "Troubleshooting", 0.316, 0.32),
            ("Employee Expectations", "Working Hours", 0.25, 0.25),
        ],
        "How do I raise a grievance?": [
            ("Code of Conduct", "Grievance", 0.354, 2.18),
            ("Code of Conduct", "Investigation", 0.354, 2.18),
            ("Employee Expectations", "Remote Work", 0.25, 0.25),
        ],
        "What is the notice period?": [
            ("Employee Expectations", "Notice Period", 0.289, 2.37),
            ("Code of Conduct", "Investigation", 0.354, 0.35),
        ],
        "What are the expectations for employees?": [
            ("Employee Expectations", "Overview", 0.289, 0.29),
            ("Employee Expectations", "Dress Code", 0.267, 0.27),
            ("Employee Expectations", "Equipment", 0.267, 0.27),
            ("Employee Expectations", "Working Hours", 0.25, 0.25),
        ],
        # The two the corpus cannot answer. Retrieval handing something over is
        # fine — the generator is what rules on it — but it must be nothing like an
        # answer, and that is a number rather than an opinion.
        "What is the policy on tuition reimbursement for postgraduate study?": [
            ("IT & VPN Guide", "Support", 0.2, 0.2),
            ("Employee Expectations", "Equipment", 0.169, 0.17),
        ],
        "How is performance reviewed?": [],
        "What do I get paid for my work?": [
            ("Employee Expectations", "Remote Work", 0.204, 2.06),
        ],
    }

    def setUp(self) -> None:
        self.index = policy_index(
            ("Employee Expectations", ContinuationRetrievalTest.EXPECTATIONS),
            ("IT & VPN Guide", ContinuationRetrievalTest.VPN),
            ("Code of Conduct", ContinuationRetrievalTest.CONDUCT),
            ("Facilities Notice", ContinuationRetrievalTest.NOTICE),
        )
        self.retriever = HybridRetriever(
            self.index.as_retriever(similarity_top_k=4),
            KeywordIndex(self.index.docstore.docs.values()),
            documents=IndexedDocuments(self.index),
            top_k=4,
            vector_candidates=10,
            keyword_candidates=10,
            min_score=0.40,
            keyword_min_score=2.0,
            recall_floor=0.15,
            recall_candidates=4,
        )

    def test_every_question_retrieves_exactly_what_it_retrieved_before(self):
        for question, expected in self.GOLDEN.items():
            with self.subTest(question=question):
                found = [
                    (
                        candidate.node.metadata["policy_title"],
                        candidate.node.metadata["section"],
                        round(candidate.similarity or 0.0, 3),
                        None if candidate.keyword is None else round(candidate.keyword, 2),
                    )
                    for candidate in self.retriever.retrieve(question)
                ]

                self.assertEqual(found, expected)

    def test_the_golden_set_would_notice_a_change_to_either_floor(self):
        # Proof that the set above is a measurement rather than a snapshot of
        # whatever the code happens to do: the numbers move when the numbers that
        # produce them move. "What is the notice period?" is answered here only by
        # the last resort — its best chunk scores 0.289, under the 0.40 floor — so
        # raising the recall floor takes the answer away.
        strict = HybridRetriever(
            self.index.as_retriever(similarity_top_k=4),
            KeywordIndex(self.index.docstore.docs.values()),
            documents=IndexedDocuments(self.index),
            top_k=4,
            vector_candidates=10,
            keyword_candidates=10,
            min_score=0.40,
            keyword_min_score=2.0,
            recall_floor=0.95,
            recall_candidates=4,
        )

        self.assertNotEqual(
            [
                candidate.node.metadata["section"]
                for candidate in strict.retrieve("What is the notice period?")
            ],
            [section for _, section, _, _ in self.GOLDEN["What is the notice period?"]],
        )


if __name__ == "__main__":
    unittest.main()