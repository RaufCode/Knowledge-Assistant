import re

PERSONAL_PATTERNS = [
    r"\bmy\b(\s+\w+){0,2}\s+(salary|pay\s?slip|appraisal|balance|tax)\b",
    r"\b(days|leave)\b.*\b(do i have|have i got|i have)\b.*\b(left|remaining)\b",
    r"\bhow (much|many)\b.*\b(do i have|have i got)\b.*\b(left|remaining)\b",
]


def is_personal_question(question: str) -> bool:
    q = question.lower()
    return any(re.search(p, q) for p in PERSONAL_PATTERNS)


# Small talk on its own. Anything carrying a question alongside the greeting is
# a question and is not matched: answering that with a greeting would be
# refusing to do the actual job.
GREETING_WORDS = {
    "hi",
    "hii",
    "hello",
    "helloo",
    "hey",
    "heyy",
    "yo",
    "hiya",
    "howdy",
    "greetings",
    "good morning",
    "good afternoon",
    "good evening",
    "good day",
    "good night",
    "goodnight",
    "morning",
    "afternoon",
    "evening",
    "bye",
    "byeee",
    "goodbye",
    "good bye",
    "see you",
    "see you later",
    "see ya",
    "talk to you later",
    "thanks",
    "thank you",
    "thankyou",
    "thx",
    "thanks a lot",
    "thank you so much",
    "how are you",
    "how r u",
    "how are u",
    "how is your day",
    "how was your day",
    "how's it going",
    "hows it going",
    "how is it going",
    "what's up",
    "whats up",
    "what is up",
    "sup",
    "how do you do",
    "how do u do",
    "nice to meet you",
    "who are you",
    "what are you",
    "what can you do",
    "what do you do",
    "how can you help",
    "help",
    "help me",
    "please help",
}

# Words that may follow a greeting without making it a question.
GREETING_ADDRESSEES = {
    "there",
    "assistant",
    "bot",
    "team",
    "everyone",
    "everybody",
    "folks",
    "friend",
    "friends",
    "all",
}

# Upper bound on a normalised greeting, so sentences never qualify.
MAX_GREETING_LENGTH = 32


def is_greeting(text: str) -> bool:
    """Whether this message is small talk and nothing else.

    Case, surrounding whitespace and trailing punctuation are ignored, and
    stretched letters are folded, because none of those change what the
    message is.
    """
    cleaned = re.sub(r"\s+", " ", text.strip().lower())
    cleaned = re.sub(r"(.)\1{2,}", r"\1\1", cleaned)
    cleaned = re.sub(r"[!?.\u2026,;:'\"]+$", "", cleaned).strip()

    if not cleaned or len(cleaned) > MAX_GREETING_LENGTH:
        return False

    if cleaned in GREETING_WORDS:
        return True

    head, _, tail = cleaned.rpartition(" ")

    return bool(tail) and head in GREETING_WORDS and tail in GREETING_ADDRESSEES
