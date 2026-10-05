"""How an answer's confidence is worked out, and why it is worked out here.

One function, called from two places: the stream that produces a fresh answer and
the message that is read back out of the database days later. Both call *this*, so
a conversation reads the same whether it is being watched being answered or is
reopened a week later. A second implementation would be a second number for the
same evidence, and the two would drift apart the first time either was edited.

## The formula

> **confidence = round(mean(similarity of the chunks used) x 10)**, clamped to 1-10,
> where a chunk's similarity is the cosine similarity the retriever assigned it, and
> only chunks that passed `MIN_SCORE` are counted because those are the only ones
> the answer was built from.

Scaled linearly from the retriever's own 0.0-1.0 range onto 0-10. Every step of that
is deterministic: no model is asked how sure it is, so the number cannot be
flattered by a confident phrasing or changed by the wording of the answer.

### Why the mean, and not the top score

The top chunk is the one that happened to match best, which says more about the
question's phrasing than about whether the answer is right. A question matching one
excellent passage and three poor ones is a question the corpus barely covers, and
the mean reports that where the maximum would not.

### Why the mean, and not a weighted blend

A blend weighted towards the top score is defensible and was considered. It was
dropped because the weights would have to be chosen rather than derived, and a
confidence figure is the last place to hide a chosen constant: somebody reading
"Confidence: 7/10" reasonably assumes the 7 means something specific.

## What the number does not mean

Not a probability that the answer is correct. It is how well the question matched
the documents, which is the input this pipeline actually controls.

It also reads lower than a reader may expect on this corpus. These embeddings put a
straightforward, correctly answered policy question in the region 0.40-0.60, so a
good answer frequently scores 4-6. That is the retriever's scale rather than a
judgement about the answer, and the scale was left unadjusted on purpose: dividing
by an assumed ceiling would make the number look better while making it less
meaningful, because the ceiling would be a guess. If these are ever recalibrated,
change `MIN_SCORE` and this file together, and say in the release notes that the
numbers moved.
"""

# The scale the answer is reported on. Fixed rather than configured: a confidence
# read against one scale and compared against another is worse than no confidence.
CONFIDENCE_MAX = 10

# Below this the mean is rounded up to it rather than reported as zero.
#
# An answer only exists if at least one chunk cleared `MIN_SCORE`, so "no evidence
# at all" is not a state this function can be asked about. Reporting 0/10 for the
# weakest answer the pipeline will still produce would also be the one number a
# reader is most likely to take as a verdict on the answer itself.
CONFIDENCE_FLOOR = 1


def confidence_from_scores(scores: list[float]) -> int | None:
    """A 1-10 confidence for an answer built from chunks with these similarities.

    None when there is nothing to be confident about, which is every response that
    was not generated from the documents: a greeting, a refusal, and a question the
    corpus genuinely does not cover. Those carry no number rather than a low one,
    because "Confidence: 1/10" beside "I couldn't find that" reads as a poor answer
    rather than as the absence of one.
    """
    usable = [float(score) for score in scores if score is not None]

    if not usable:
        return None

    mean = sum(usable) / len(usable)

    return max(CONFIDENCE_FLOOR, min(CONFIDENCE_MAX, round(mean * CONFIDENCE_MAX)))


def confidence_from_sources(sources: list | None) -> int | None:
    """The same figure, from stored citations rather than from retrieved nodes.

    The second entry point, for a message read back out of the database. It reads
    the `score` already recorded against each citation, which is why nothing extra
    has to be stored: the evidence the number was built from is already on the row.

    Citations arrive either as plain dicts (straight off a database row) or as
    `Source` models (once validated for the response), and both are read here so
    this one function serves both rather than each caller converting for itself.
    """
    if not sources:
        return None

    def score_of(source) -> float | None:
        return source.get("score") if isinstance(source, dict) else getattr(source, "score", None)

    return confidence_from_scores([score_of(source) for source in sources])