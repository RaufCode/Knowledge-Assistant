"""Retrieval: vector similarity, keyword matching, and the fusion of the two.

Both halves run on every question. Neither is sufficient alone, and the failures
they each cover are exactly the mirror image of each other:

- Vector similarity is good at meaning. "annual leave" finds a chunk headed
  "Paid Time Off" because it embeds the same idea in the same neighbourhood. It
  under-ranks a chunk that happens to contain the exact term asked for — a named
  policy ("Code of Conduct"), an acronym, a figure — because one literal match
  among forty-five tokens of prose is a small signal in embedding space.
- Keyword matching is good at those literals. It cannot tell that "vacation days"
  and "annual leave" are the same question, and it ranks a chunk containing every
  stopword above one containing the phrase that was actually asked about.

So each is run, the two ranked lists are merged by Reciprocal Rank Fusion, and the
best of the merged list is what the generator is given. Fusing on rank rather than
on score is what makes it work: cosine similarity and BM25 are not on the same
scale and cannot be compared or averaged, but "how near the top of each list" can
be. A chunk that both lists like rises to the top; a chunk only one list found is
still carried rather than discarded, which is the case that matters most — it is
the exact-term hit the vector search would have buried.

The keyword side runs over the same chunk objects the vector index already holds,
in this process. A second copy of the corpus in the database would be a second
thing to keep in step with the first for no ranking gain.
"""

import logging
import math
import re
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass

logger = logging.getLogger(__name__)

# BM25's two free parameters. The standard values from Robertson & Zaragoza: k1
# controls how fast a repeated term stops counting for (1.2-2.0 is the usual
# range, and the ranking barely moves inside it), b controls how much a chunk's
# length is penalised (0.75 gives long documents half a penalty).
BM25_K1 = 1.5
BM25_B = 0.75

# RRF's damping constant, as in the original Cormack et al. paper. It is large on
# purpose: it flattens the contribution of the top ranks so a chunk cannot win the
# fusion by being first in one list and merely present in the other. The value is
# near-irrelevant for result quality — only the *order* of the fused scores changes
# — and 60 is the near-universal default, kept here so this implementation is
# comparable with the ones it is meant to match.
RRF_K = 60

# Words that appear in almost any question about a company and carry no signal
# about which document it lands in. Deliberately short: an aggressive list starts
# dropping the words that make a question specific, and a specific question is the
# one this half of the retrieval exists to serve.
STOPWORDS = frozenset(
    """
    a about above after again against all am an and any are as at be because been
    before being below between both but by can cannot could did do does doing down
    during each few for from further had has have having he her here hers herself him
    himself his how i if in into is it its itself just me more most my myself no nor
    not of off on once only or other ought our ours ourselves out over own same she
    should so some such than that the their theirs them themselves then there these
    they this those through to too under until up very was we were what when where
    which while who whom why will with would you your yours yourself yourselves
    """.split()
)

_WORD = re.compile(r"[a-z0-9]+")

# A one- or two-letter token is a fragment ("hr", "it"), never a policy name, and
# letting them into the index only adds noise.
MIN_TOKEN_LENGTH = 3


def normalise(token: str) -> str:
    """One word as the index stores it, so a query and a chunk agree on its form.

    Documents are written in prose, so the same word arrives as "policy",
    "policies" and "Policy". Folding the plural and the trailing "s" means a
    question using either reaches the same chunks, without pulling in a
    general-purpose stemmer to do it: the singular forms below are the only two
    English plural endings that are not a plain trailing "s", and handling them by
    rule is both smaller and more predictable than a dependency that would have to
    be downloaded and versioned alongside this.
    """
    if len(token) > 4 and token.endswith("ies"):
        return token[:-3] + "y"

    if len(token) > 3 and token.endswith("s") and not token.endswith(("ss", "us", "is")):
        return token[:-1]

    return token


def tokenize(text: str) -> list[str]:
    """The words of `text` the keyword index scores on."""
    tokens: list[str] = []

    for raw in _WORD.findall(text.lower()):
        if len(raw) < MIN_TOKEN_LENGTH:
            continue

        folded = normalise(raw)

        if folded not in STOPWORDS:
            tokens.append(folded)

    return tokens


@dataclass(frozen=True)
class Hit:
    """One chunk a search returned, with the score that ranked it."""

    node: object
    score: float


class KeywordIndex:
    """A BM25 ranking over the same chunks the vector index holds.

    Built once, alongside the vector index, because it is the same corpus: dozens
    of chunks over a handful of policy documents. Scoring is a pass over each
    chunk's term counts, so a query costs no network call and no database round
    trip — the part of retrieval that has to be fast and cannot fail half way.
    """

    def __init__(self, nodes: Sequence[object]):
        self._nodes = list(nodes)
        self._counts = [Counter(tokenize(node.get_content())) for node in self._nodes]
        self._lengths = [sum(counts.values()) for counts in self._counts]
        # An average over an empty corpus is zero, and every division by it below
        # would be. A corpus this code is pointed at is never empty — there are no
        # documents to answer from — but the guard is a division by zero away.
        self._average_length = (
            sum(self._lengths) / len(self._lengths) if self._lengths else 0.0
        )
        document_frequency: Counter[str] = Counter()
        for counts in self._counts:
            document_frequency.update(counts.keys())
        self._document_frequency = document_frequency
        self._count = len(self._nodes)

    def __len__(self) -> int:
        return self._count

    def _idf(self, term: str) -> float:
        """How much a term appearing in one chunk says about the question.

        Robertson & Zaragoza's smoothed form, floored at zero by the `log(1 + ...)`
        rather than the raw `log(...)`, which goes negative for a term in more than
        half the corpus and would then *reward* matching it. A term in every chunk
        — "policy", in a corpus of policy documents — has no power to separate
        them, and must not drag unrelated chunks into the results.
        """
        frequency = self._document_frequency[term]

        return math.log(1 + (self._count - frequency + 0.5) / (frequency + 0.5))

    def search(self, query: str, top_k: int) -> list[Hit]:
        """The chunks that best match `query`, best first, at most `top_k` of them.

        A query with no searchable term in it — punctuation alone, or nothing but
        stopwords — matches nothing rather than everything, which is why nothing is
        returned rather than the whole corpus.
        """
        terms = {term for term in tokenize(query) if term in self._document_frequency}

        if not terms or self._average_length == 0:
            return []

        scored: list[Hit] = []

        for node, counts, length in zip(self._nodes, self._counts, self._lengths):
            score = 0.0

            for term in terms:
                frequency = counts.get(term)

                if not frequency:
                    continue

                # BM25's term saturation: repeated occurrences keep counting but
                # with diminishing returns, so one long chunk cannot out-score a
                # focused one purely on length.
                saturation = frequency * (BM25_K1 + 1) / (
                    frequency
                    + BM25_K1 * (1 - BM25_B + BM25_B * length / self._average_length)
                )
                score += self._idf(term) * saturation

            if score > 0:
                scored.append(Hit(node=node, score=score))

        scored.sort(key=lambda hit: (-hit.score, hit.node.node_id))

        return scored[:top_k]


@dataclass(frozen=True)
class Candidate:
    """One chunk worth answering from, and how it earned its place.

    `fused` is the Reciprocal Rank Fusion total and is what orders the result.
    `similarity` and `keyword` are the two searches' own scores, kept because they
    are what `sources` reports, what `confidence` is derived from, and what makes a
    bad retrieval diagnosable after the fact.
    """

    node: object
    fused: float
    similarity: float | None = None
    keyword: float | None = None


# The scale `confidence` is reported on. Integers 1-10, matching what the client
# renders, and deliberately not a percentage.
CONFIDENCE_MIN = 1
CONFIDENCE_MAX = 10

# The two ends of the similarity range the scale is stretched across, measured
# against this corpus with this embedding model rather than picked to make the
# numbers look good:
#
# - The low anchor is the recall floor. A chunk below it was never handed to the
#   generator at all, so it cannot be the basis of a confidence figure.
# - The high anchor is where a clear, unambiguous match sits. The strongest
#   observed match on the golden set is 0.669, so 0.70 is "as good as this gets"
#   and nothing can score above the top of the range for being marginally better
#   than an already-clear answer.
#
# What that produces, and it is the point: `min_score` of 0.40 lands mid-scale,
# so a perfectly good answer reports about 5/10 rather than 8/10. That reads low,
# and it is honest — the passages matched in the middle of the range, which is
# what the figure is supposed to say. A client showing "Confidence: 5/10" next to a
# correct answer is reporting a weaker match than "Confidence: 9/10" would be.
CONFIDENCE_LOW_SIMILARITY = 0.15
CONFIDENCE_HIGH_SIMILARITY = 0.70


def retrieval_confidence(candidates: Sequence[Candidate]) -> int | None:
    """How closely the retrieved passages matched, from 1 to 10. Or None.

    What it measures, precisely: the cosine similarity of the best chunk that was
    actually retrieved. Not the correctness of the answer — nothing here knows what
    the model went on to write — and not a probability, which is why the client
    labels it a match quality rather than a certainty.

    It is the *best* chunk rather than an average because retrieval is
    best-of-the-set by construction: one chunk answering well is what makes an
    answer good, and averaging would let four mediocre chunks drag a genuinely
    well-matched one down.

    None when nothing was retrieved or no candidate carries a similarity at all,
    which is the honest answer: there were no passages to be confident about. The
    caller uses it for exactly the turns that cite nothing — a greeting, a
    refusal, an out-of-scope reply, a question the corpus does not cover — where a
    number would describe an answer that was never built from anything.
    """
    similarities = [
        candidate.similarity
        for candidate in candidates
        if candidate.similarity is not None
    ]

    if not similarities:
        return None

    span = CONFIDENCE_HIGH_SIMILARITY - CONFIDENCE_LOW_SIMILARITY
    proportion = (max(similarities) - CONFIDENCE_LOW_SIMILARITY) / span
    proportion = min(max(proportion, 0.0), 1.0)

    return int(
        round(CONFIDENCE_MIN + proportion * (CONFIDENCE_MAX - CONFIDENCE_MIN))
    )


def reciprocal_rank_fusion(ranked_lists: Sequence[Sequence[object]], k: int = RRF_K) -> dict[str, float]:
    """The fused score of every chunk that appeared in any of `ranked_lists`.

    Each chunk scores `1 / (k + rank)` in every list it appears in, summed across
    the lists, with ranks counted from 1. A chunk found by only one method still
    scores, so it competes rather than being dropped — which is the entire reason
    for running two searches.
    """
    fused: dict[str, float] = {}

    for ranked in ranked_lists:
        for position, node in enumerate(ranked, start=1):
            key = node.node_id
            fused[key] = fused.get(key, 0.0) + 1.0 / (k + position)

    return fused


class HybridRetriever:
    """Vector similarity and keyword matching, merged, with an optional reranker."""

    def __init__(
        self,
        vector_retriever,
        keyword_index: KeywordIndex,
        *,
        top_k: int,
        vector_candidates: int,
        keyword_candidates: int,
        min_score: float,
        keyword_min_score: float,
        recall_floor: float,
        recall_candidates: int,
        rerank=None,
    ):
        self._vector = vector_retriever
        self._keywords = keyword_index
        self._top_k = top_k
        self._vector_candidates = vector_candidates
        self._keyword_candidates = keyword_candidates
        self._min_score = min_score
        self._keyword_min_score = keyword_min_score
        self._recall_floor = recall_floor
        self._recall_candidates = recall_candidates
        self._rerank = rerank

    def retrieve(self, query: str) -> list[Candidate]:
        """The best `top_k` chunks for `query`, ranked, or none at all.

        Empty means the corpus has nothing on the question, which the caller
        reports as such rather than answering from what it does have.
        """
        vector_hits, vector_seen, similarities = self._vector_search(query)
        keyword_hits = self._keyword_search(query, vector_seen)

        # Nothing survived either search, and the vector search never saw anything
        # worth passing on: a genuine miss, reported before the fusion rather than
        # after, so a question the corpus cannot answer at all costs two searches
        # and no list-building.
        if not vector_hits and not keyword_hits and not vector_seen:
            return []
        # The vector floor cleared nothing. Whatever the keyword leg found is very
        # likely right — a lexical hit is specific — but on its own it can be one
        # chunk that happens to share a word, and the generator has no second
        # opinion to weigh it against. So the best sub-floor vector chunks are added
        # to the pool rather than replacing it: the keyword hit keeps its rank, the
        # semantic evidence is alongside it, and the generator decides with both in
        # front of it.
        #
        # This is the only path that looks below `min_score`, and only when the
        # strict pass found no vector match at all — a question that already has one
        # never comes through here, so no question that is answered well today is
        # re-ranked by this.
        #
        # It exists because `min_score` cannot simply be lowered to cover these
        # cases. On this embedding model the two ranges overlap and no score
        # separates them: questions the corpus answers have best-chunk cosines as
        # low as 0.22 ("How much do I earn?", Compensation first at 0.222), while
        # questions it cannot answer peak near 0.32 ("How many dentists does the
        # company have?"). Any threshold admitting the first admits the second, and
        # the corpus would be answering from the nearest irrelevant document. The
        # generator can tell those apart and a number cannot, so the judgement goes
        # to the generator — which is already what decides `NOT_FOUND` when the
        # strict pass does return chunks.
        if not vector_hits:
            recall = self._recall_hits(query)

            if recall:
                already = {hit.node.node_id for hit in keyword_hits}
                keyword_hits = [*keyword_hits, *[h for h in recall if h.node.node_id not in already]]
                logger.info(
                    "no chunk cleared the vector floor for %r; added %d below it for "
                    "the generator to rule on",
                    query,
                    len(recall),
                )

        # The two searches are handed the same chunk objects, but they are not
        # guaranteed to return the *same instances* of them, so the fusion is keyed
        # on the chunk's own id and each search's detail looked up by it.
        by_id = {
            hit.node.node_id: hit.node
            for hit in [*vector_hits, *keyword_hits]
        }
        keyword = {hit.node.node_id: hit.score for hit in keyword_hits}

        candidates = [
            Candidate(
                node=by_id[node_id],
                fused=score,
                # Every candidate's real cosine, not only the ones that cleared
                # `min_score`. A rescued chunk was still scored by the vector
                # search — it just scored low — and reporting that as no score at
                # all, or as zero, misdescribes it in both directions: zero reads
                # as "no similarity at all", which is not what under the floor
                # means. `confidence` is derived from this too, so a chunk that
                # was only just rescued reports a low confidence honestly rather
                # than a fabricated one.
                similarity=similarities.get(node_id),
                keyword=keyword.get(node_id),
            )
            for node_id, score in reciprocal_rank_fusion(
                [
                    [hit.node for hit in vector_hits],
                    [hit.node for hit in keyword_hits],
                ]
            ).items()
        ]
        # The fused score orders the result. Ties go to the chunk the vector
        # search liked more, because that is the layer this retrieval treats as
        # primary: two chunks each first in one list and absent from the other are
        # equally well attested by rank fusion alone, and breaking that on the
        # chunk's id would be arbitrary in a way nobody could debug afterwards.
        candidates.sort(
            key=lambda candidate: (
                -candidate.fused,
                -(candidate.similarity or 0.0),
                candidate.node.node_id,
            )
        )

        if self._rerank is not None:
            candidates = self._rerank.rerank(query, candidates[: self._top_k * 3])

        return candidates[: self._top_k]

    def _vector_search(self, query: str) -> tuple[list[Hit], set[str], dict[str, float]]:
        """The chunks closest to the question in meaning, every id it considered, and
        the cosine it gave each one.

        The similarity floor is applied to the returned hits rather than after the
        fusion, and it is the existing one: it decides what counts as a match at
        all. Fusion orders the chunks that already qualified, so loosening this to
        admit more would admit chunks whose *ranking* is meaningful but whose
        relevance is not.

        The set is every chunk the search looked at, floor or no floor, and it is
        what the keyword leg checks membership against — so the retrieval depth is
        doing double duty: it decides what can be rescued, not just what can be
        ranked. The map is every chunk's cosine, which is what `confidence` is
        derived from and what `sources` reports.
        """
        try:
            retrieved = self._vector.retrieve(query)
        except Exception as exc:  # noqa: BLE001
            # The keyword half is independent and still able to answer, so a vector
            # search that fails degrades to keyword-only rather than failing the
            # question. Logged, because a silently halved retrieval is otherwise
            # very hard to notice from the outside.
            logger.warning("vector search failed, falling back to keyword only: %s", exc)
            return [], set(), {}

        similarities = {node.node_id: float(node.score or 0.0) for node in retrieved}
        seen = set(similarities)

        hits = [
            Hit(node=node, score=float(node.score or 0.0))
            for node in retrieved
            if (node.score or 0) >= self._min_score
        ]
        hits.sort(key=lambda hit: (-hit.score, hit.node.node_id))

        return hits[: self._vector_candidates], seen, similarities

    def _recall_hits(self, query: str) -> list[Hit]:
        """The best chunks below `min_score`, for the generator to rule on.

        A last resort, so it asks the vector search for the same depth it would
        normally: the point is that `min_score` already rejected these, and
        re-querying more deeply would be changing the question rather than
        answering it. Only chunks above `recall_floor` are kept — with no floor at
        all this would hand the generator the least similar chunk in the corpus,
        which is noise rather than evidence.
        """
        try:
            retrieved = self._vector.retrieve(query)
        except Exception as exc:  # noqa: BLE001
            logger.warning("recall pass could not re-query: %s", exc)
            return []

        hits = [
            Hit(node=node, score=float(node.score or 0.0))
            for node in retrieved
            if self._recall_floor <= float(node.score or 0.0) < self._min_score
        ]
        hits.sort(key=lambda hit: (-hit.score, hit.node.node_id))

        return hits[: self._recall_candidates]

    def _keyword_search(self, query: str, vector_seen: set[str]) -> list[Hit]:
        """The chunks containing the question's actual words.

        The floor is on BM25 rather than on a term count, because a count cannot
        tell a question that matched a rare term from one that matched a common
        one, and those are not remotely the same confidence.

        A chunk the vector search did not return at all is dropped however well it
        scored on keywords alone, and that is the one non-obvious rule here.

        BM25's IDF measures how rare a term is *in this corpus*, and in a corpus
        of sixty-odd policy chunks that is a much weaker signal than it is over a
        large document collection: a light verb used in four of the chunks scores
        as "rare" and as discriminating as a policy name used in four. So
        "What do I get paid for my work?" put the IT & VPN guide first on the
        strength of "get" and "work" alone — terms whose cosine similarity to that
        chunk is 0.163, nowhere near the floor — and the generator was then handed
        an IT setup guide in answer to a question about pay. Requiring the vector
        search to have returned the chunk at all fixes it without touching the
        ranking: BM25 still decides the order of the candidates, it just cannot
        admit one on its own.

        This is not the same as `min_score`. That floor decides whether a chunk the
        vector search *did* return is close enough to count, and it is deliberately
        not applied here — the whole point of the keyword leg is to rescue chunks
        the vector search under-scored, `grievance` among them, which it returns
        at 0.149. Here the test is membership of the vector candidate list, which
        is a much weaker requirement than a score.
        """
        return [
            hit
            for hit in self._keywords.search(query, self._keyword_candidates)
            if hit.score >= self._keyword_min_score and hit.node.node_id in vector_seen
        ]
