"""End-to-end check of the three classifications and the confidence, over real HTTP.

Talks to a running backend exactly as a browser would: signs in, holds the cookies,
sends the CSRF header, and reads the server-sent events. Nothing here is stubbed, so
a pass means the routing works against the real index, the real classifier and the
real model.

    python3 scripts/check_classification.py
"""

import json
import sys
import urllib.error
import urllib.request
from http.cookiejar import CookieJar

API = "http://127.0.0.1:8099"
ORIGIN = "http://127.0.0.1:4200"
CLIENT = "e2e-classify-0001"

jar = CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))


def read_password() -> str:
    with open(".env") as handle:
        for line in handle:
            if line.startswith("AUTH_SEED_ADMIN_PASSWORD="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit("AUTH_SEED_ADMIN_PASSWORD is not set")


def cookie(name: str) -> str | None:
    for entry in jar:
        if entry.name == name:
            return entry.value
    return None


def call(method: str, path: str, body: dict | None = None, csrf: bool = False):
    """One request, with the cookies and headers a browser would send."""
    request = urllib.request.Request(f"{API}{path}", method=method)

    if body is not None:
        request.add_header("Content-Type", "application/json")
        request.data = json.dumps(body).encode()

    request.add_header("Origin", ORIGIN)

    if csrf and cookie("ika_csrf"):
        request.add_header("X-CSRF-Token", cookie("ika_csrf"))

    try:
        with opener.open(request, timeout=150) as response:
            return response.status, response.read().decode()
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode()


def sign_in() -> None:
    call("GET", "/api/auth/csrf")
    status, body = call(
        "POST",
        "/api/auth/login",
        {"email": "admin@acmetech.example", "password": read_password()},
    )
    if status != 200:
        raise SystemExit(f"could not sign in: {status} {body}")


def ask(question: str) -> dict:
    """One question, returning the closing `done` event."""
    status, body = call("POST", "/api/conversations", {"client_id": CLIENT}, csrf=True)
    if status != 200:
        raise SystemExit(f"could not open a conversation: {status} {body}")
    conversation = json.loads(body)["id"]

    status, body = call(
        "POST",
        f"/api/conversations/{conversation}/messages",
        {"client_id": CLIENT, "content": question},
        csrf=True,
    )
    if status != 200:
        raise SystemExit(f"question rejected: {status} {body}")

    for line in body.splitlines():
        if not line.startswith("data:"):
            continue
        event = json.loads(line[len("data:") :])
        if event.get("type") == "done":
            return event

    raise SystemExit("the stream ended without a done event")


# Each case: the question, and the `status` the stream's closing event must carry.
#
# Not the classifier's own categories. `Intent.QUESTION` is "go and retrieve", and
# what comes back afterwards is `answered` or `not-found` depending on whether the
# corpus covered it — so "the salary band for engineers" is classified as a question
# and answered `not-found`, which is correct: the handbook does not publish bands.
CASES = [
    ("greeting", "hello", "greeting"),
    ("greeting", "thanks!", "greeting"),
    ("greeting", "how are you?", "greeting"),
    ("greeting + real question", "hello, what is the leave policy?", "answered"),
    ("normal question", "How many days of annual leave do I accrue per month?", "answered"),
    ("normal question", "How do I connect to the VPN?", "answered"),
    ("normal question", "What is the probation period?", "answered"),
    ("own record", "what is my own leave balance?", "restricted"),
    ("own record", "what is my salary", "restricted"),
    ("named directly", "What is Ama Konadu's salary?", "restricted"),
    ("phrased indirectly", "what does Kwame earn?", "restricted"),
    ("phrased indirectly", "how much is Kofi Mensah paid", "restricted"),
    ("phrased indirectly", "can you look up what Akosua gets paid", "restricted"),
    ("phrased indirectly", "Ama Konadu earns what?", "restricted"),
    ("greeting cannot bypass it", "hi, what does Ama earn?", "restricted"),
    ("must stay answerable", "How many days of paid annual leave do I get?", "answered"),
    ("classifier says question", "What is the salary band for engineers?", "not-found"),
    ("corpus gap", "What is the gym membership fee?", "not-found"),
]


def main() -> int:
    sign_in()
    print("signed in as admin@acmetech.example\n")

    wrong_status = 0
    broken_invariants = 0

    for label, question, expected in CASES:
        event = ask(question)
        status = event["status"]
        confidence = event["confidence"]
        sources = event["sources"]

        if status != expected:
            wrong_status += 1

        # The invariants that matter, checked on every case rather than asserted
        # per-case: a confidence belongs to a grounded answer and nothing else, and
        # a reply that cites nothing must say it found nothing.
        problems = []
        if status == "answered" and confidence is None:
            problems.append("a grounded answer arrived with no confidence")
        if status != "answered" and confidence is not None:
            problems.append(f"a {status} reply carried a confidence of {confidence}")
        if status != "answered" and sources:
            problems.append("an un-answered reply cited something")
        if status == "answered" and not sources:
            problems.append("a grounded answer cited nothing")
        broken_invariants += bool(problems)

        mark = "ok  " if not problems and status == expected else "FAIL"
        print(
            f"{mark} {label:<28} status={status:<10} "
            f"confidence={str(confidence):<5} sources={len(sources)}  {question!r}"
        )
        print(f"       -> {event['answer'][:96]}")
        for problem in problems:
            print(f"       !! {problem}")

    total = len(CASES)
    print(
        f"\n{total} cases: {total - wrong_status} with the expected status, "
        f"{total - broken_invariants} holding every invariant, "
        f"{wrong_status + broken_invariants} problem(s)"
    )

    return 1 if wrong_status or broken_invariants else 0


if __name__ == "__main__":
    sys.exit(main())