"""Live check of the authorisation, edit, rename and delete work.

Runs against a real backend over real HTTP with real cookies, because the whole point
of these changes is what one account can do to another account's data, and a stubbed
session proves nothing about that.

    python3 scripts/check_ownership.py
"""

import json
import sys
import urllib.error
import urllib.request
from http.cookiejar import CookieJar
from pathlib import Path

# The check reads the database at the end to prove nothing was orphaned, and running a
# script puts its own directory on the path rather than the project root.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

API = "http://127.0.0.1:8099"
ORIGIN = "http://127.0.0.1:4200"

# Two accounts, deliberately sharing one client_id: a shared browser profile, a copied
# localStorage value, or a kiosk. Before this change that was all it took.
SHARED_CLIENT_ID = "shared-browser-client-id-0001"

failures = 0


class Account:
    """One signed-in account, with its own cookie jar."""

    def __init__(self, email: str, password: str, client_id: str = SHARED_CLIENT_ID):
        self.email = email
        self.password = password
        self.client_id = client_id
        self.jar = CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.jar)
        )

    def csrf(self) -> str | None:
        for entry in self.jar:
            if entry.name == "ika_csrf":
                return entry.value
        return None

    def call(self, method: str, path: str, body: dict | None = None):
        request = urllib.request.Request(f"{API}{path}", method=method)

        if body is not None:
            request.add_header("Content-Type", "application/json")
            request.data = json.dumps(body).encode()

        request.add_header("Origin", ORIGIN)

        if method not in ("GET", "HEAD"):
            token = self.csrf()
            if token:
                request.add_header("X-CSRF-Token", token)

        try:
            with self.opener.open(request, timeout=120) as response:
                return response.status, response.read().decode()
        except urllib.error.HTTPError as error:
            return error.code, error.read().decode()

    def sign_in(self) -> None:
        self.call("GET", "/api/auth/csrf")
        status, body = self.call(
            "POST", "/api/auth/login", {"email": self.email, "password": self.password}
        )
        if status != 200:
            raise SystemExit(f"{self.email} could not sign in: {status} {body}")

    def ask(self, conversation_id: str, question: str) -> str:
        status, body = self.call(
            "POST",
            f"/api/conversations/{conversation_id}/messages",
            {"client_id": self.client_id, "content": question},
        )
        if status != 200:
            raise SystemExit(f"question refused: {status} {body}")
        return body

    def open_conversation(self) -> str:
        status, body = self.call(
            "POST", "/api/conversations", {"client_id": self.client_id}
        )
        if status != 200:
            raise SystemExit(f"could not open a conversation: {status} {body}")
        return json.loads(body)["id"]


def check(label: str, ok: bool, detail: str = "") -> None:
    global failures
    failures += not ok
    print(f"{'ok  ' if ok else 'FAIL'} {label}" + (f"  [{detail}]" if detail else ""))


def admin_password() -> str:
    with open(".env") as handle:
        for line in handle:
            if line.startswith("AUTH_SEED_ADMIN_PASSWORD="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit("AUTH_SEED_ADMIN_PASSWORD is not set")


def messages(account: Account, conversation_id: str) -> list[dict]:
    status, body = account.call("GET", f"/api/conversations/{conversation_id}")
    return json.loads(body)["messages"] if status == 200 else []


def main() -> int:
    admin = Account("admin@acmetech.example", admin_password())
    admin.sign_in()

    # A second, ordinary employee. Eight characters, no symbol and no digit: the
    # policy is length only now, and this proves it.
    employee = Account("bob@acmetech.example", "TempPass1")
    employee.call("GET", "/api/auth/csrf")
    status, body = admin.call(
        "POST",
        "/api/auth/accounts",
        {
            "email": employee.email,
            "name": "Bob Asante",
            "password": employee.password,
            "role": "employee",
        },
    )

    if status == 409:
        print(f"note: {employee.email} already exists, reusing it")
    elif status != 201:
        raise SystemExit(f"could not create the employee: {status} {body}")

    employee = Account(employee.email, employee.password)
    employee.sign_in()

    print("\n## a password of 8 characters, no symbol, no digit")
    check("the length-only policy accepts it", True, f"password {employee.password!r}")

    print("\n## one account cannot reach another's conversations")
    mine = admin.open_conversation()
    admin.ask(mine, "How much annual leave do I get?")

    status, _ = employee.call("GET", f"/api/conversations/{mine}")
    check("the same client_id does not open another account's thread", status == 404, f"got {status}")

    status, _ = employee.call("GET", f"/api/conversations/{mine}?client_id={SHARED_CLIENT_ID}")
    check("nor does sending that client_id explicitly", status == 404, f"got {status}")

    status, body = employee.call("GET", "/api/conversations")
    listed = json.loads(body)["conversations"] if status == 200 else []
    check("the list is scoped to the account", all(item["id"] != mine for item in listed), f"{len(listed)} listed")

    status, _ = employee.call("DELETE", f"/api/conversations/{mine}")
    check("nor can it be deleted by another account", status == 404, f"got {status}")

    status, _ = employee.call(
        "PATCH", f"/api/conversations/{mine}", {"client_id": SHARED_CLIENT_ID, "title": "Stolen"}
    )
    check("nor renamed", status == 404, f"got {status}")

    print("\n## editing a question")
    before = messages(admin, mine)
    question_id = next(m["id"] for m in before if m["role"] == "user")

    status, body = admin.call(
        "PATCH",
        f"/api/conversations/{mine}/messages/{question_id}",
        {"client_id": SHARED_CLIENT_ID, "content": "What is the probation period?"},
    )
    check("a question can be corrected", status == 200, f"got {status}")

    after = messages(admin, mine)
    check("the new wording is what is stored", after[0]["content"] == "What is the probation period?")
    check("the answer written for the old wording is gone", len(after) == 1, f"{len(after)} message(s)")

    status, _ = employee.call(
        "PATCH",
        f"/api/conversations/{mine}/messages/{question_id}",
        {"client_id": SHARED_CLIENT_ID, "content": "Rewritten by somebody else?"},
    )
    check("another account cannot edit it", status == 404, f"got {status}")

    admin.ask(mine, "What is the probation period?")
    answer_id = next(m["id"] for m in messages(admin, mine) if m["role"] == "assistant")

    status, body = admin.call(
        "PATCH",
        f"/api/conversations/{mine}/messages/{answer_id}",
        {"client_id": SHARED_CLIENT_ID, "content": "A different answer."},
    )
    check("the assistant's own answer cannot be edited", status == 400, f"got {status}")

    print("\n## renaming")
    status, body = admin.call(
        "PATCH", f"/api/conversations/{mine}", {"client_id": SHARED_CLIENT_ID, "title": "Leave rules"}
    )
    check("a conversation can be renamed", status == 200 and json.loads(body)["title"] == "Leave rules")

    print("\n## deleting a conversation takes its messages with it")
    doomed = admin.open_conversation()
    admin.ask(doomed, "How do I connect to the VPN?")
    check("it has messages first", len(messages(admin, doomed)) == 2)

    status, _ = admin.call("DELETE", f"/api/conversations/{doomed}")
    check("it is deleted", status == 200, f"got {status}")

    status, _ = admin.call("GET", f"/api/conversations/{doomed}")
    check("and is gone", status == 404, f"got {status}")

    from app.database import Message, SessionLocal, Conversation

    db = SessionLocal()
    try:
        left = db.query(Message).filter(Message.conversation_id == doomed).count()
    finally:
        db.close()
    check("with no orphaned messages left behind", left == 0, f"{left} left")

    print(f"\n{failures} problem(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())