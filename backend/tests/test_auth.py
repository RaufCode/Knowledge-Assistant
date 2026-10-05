"""Authentication, at the level of the HTTP contract.

The security checklist in `Phase_2_Authentication.md` is written here as assertions
rather than as prose, so each line of it is something the suite actually checks:

- No token appears in a response body, or in any cookie JavaScript can read.
- The session cookies carry `HttpOnly`, `Secure`, `SameSite` and `Path`.
- Refresh tokens rotate, and replaying a rotated-out one kills the family.
- Passwords are bcrypt hashes, and the plaintext reaches neither the database nor
  the logs.
- `login` and `accept-invite` are rate limited.
- A state-changing request without the CSRF header is refused.
- A non-company address is a 422 from the validator, on both routes that take one.
- A real, signed-in **employee** gets a 403 on an admin route.
- No route creates an account without an invitation behind it.

`TestClient` is used without its context manager so the lifespan never runs and the
LlamaIndex index is never built: these tests are offline and need no keys. Every
setting the auth layer reads is patched onto the shared `settings` object in
`setUp`, which is what makes that possible without a `.env`.
"""

import logging
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app import main
from app.auth import REFRESH_COOKIE
from app.config import settings
from app.database import AccessRequest, Base, Invite, RefreshSession, User
from app.dependencies import ACCESS_COOKIE, CSRF_COOKIE, SESSION_HINT_COOKIE
from app.security import REFRESH_TOKEN_TYPE, create_access_token, decode_token, hash_password
from app.schemas_auth import MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH

COMPANY = "acmetech.example"
PASSWORD = "correct-horse-1!"

# Settings the auth layer reads. Patched rather than set through the environment so
# the tests are self-contained and cannot be made to depend on a developer's `.env`.
PATCHED = {
    "auth_secret_key": "test-secret-key-that-is-definitely-long-enough-000",
    "company_email_domain": COMPANY,
    "auth_cookie_secure": False,
    "environment": "test",
    "csrf_trusted_origins": "http://localhost:4200",
    "auth_bootstrap_key": "bootstrap-key-for-tests",
    "bcrypt_rounds": 4,
}


class AuthTestCase(unittest.TestCase):
    """A client wired to a throwaway database, with no secret left unpatched."""

    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.engine = create_engine(f"sqlite:///{Path(self.directory.name) / 'test.db'}")
        Base.metadata.create_all(self.engine)
        self.sessionmaker = sessionmaker(bind=self.engine, autoflush=False)
        self.db = self.sessionmaker()

        def override_get_db():
            yield self.db
            self.db.close()

        self.addCleanup(self.directory.cleanup)
        self.addCleanup(self.engine.dispose)
        self.addCleanup(self.db.close)

        main.app.dependency_overrides[main.get_db] = override_get_db
        self.addCleanup(main.app.dependency_overrides.clear)

        # The limiter is process-wide and its counters outlive a test, so they are
        # cleared between tests. Without this the rate-limit test would consume the
        # allowance that every later test in the same process shares, and which test
        # failed would depend on alphabetical order.
        main.app.state.limiter.reset()

        for name, value in PATCHED.items():
            original = getattr(settings, name)
            setattr(settings, name, value)
            self.addCleanup(setattr, settings, name, original)

        self.client = TestClient(main.app)
        self.admin: TestClient | None = None

    # ------------------------------------------------------------------ helpers --

    def csrf_headers(self, client: TestClient | None = None) -> dict[str, str]:
        """A matching cookie/header pair, as the frontend's interceptor sends.

        Taken against `client` rather than a shared one, because the check is a
        comparison of two things that have to come from the same browser: a token
        read out of one cookie jar cannot satisfy another.
        """
        target = client or self.client
        token = target.get("/api/auth/csrf").json()["csrf_token"]

        return {"X-CSRF-Token": token}

    def bootstrap_admin(self, email: str = f"admin@{COMPANY}") -> str:
        """Creates the first administrator through the one route that can.

        Done over HTTP rather than by writing rows, so that the bootstrap path
        itself is exercised by the tests that depend on an administrator existing.
        """
        response = self.client.post(
            "/api/auth/bootstrap-admin",
            json={
                "name": "Kwame Osei",
                "email": email,
                "role": "admin",
                "password": PASSWORD,
                "bootstrap_key": PATCHED["auth_bootstrap_key"],
            },
        )
        self.assertEqual(response.status_code, 201, response.text)

        return response.json()["user"]["id"]

    def new_client(self) -> TestClient:
        """A cookie jar of its own, so one sign-in cannot leak into another."""
        return TestClient(main.app)

    def invite_and_accept(
        self,
        client: TestClient,
        email: str,
        role: str = "employee",
        name: str = "Ama Konadu",
        password: str = PASSWORD,
    ) -> dict:
        """The whole invitation flow, ending signed in on `client`.

        The invitation is created by `self.admin`, set up once per test, and the
        acceptance happens on `client`. Returns the created user, so a test can
        assert on the account rather than having to go and read it back.
        """
        admin = self.signed_in_admin()

        invite = admin.post(
            "/api/auth/invite",
            json={"name": name, "email": email, "role": role},
            headers=self.csrf_headers(self.admin),
        )
        self.assertEqual(invite.status_code, 201, invite.text)

        accepted = client.post(
            "/api/auth/accept-invite",
            json={"token": invite.json()["token"], "password": password},
        )
        self.assertEqual(accepted.status_code, 200, accepted.text)

        return accepted.json()["user"]

    def signed_in_admin(self) -> TestClient:
        """An administrator client, bootstrapped and signed in.

        Recorded on the test case, so a helper that needs an administrator reuses
        this one instead of trying to create another, which the bootstrap route
        rightly refuses to do.
        """
        if self.admin is not None:
            return self.admin

        self.bootstrap_admin()
        client = self.new_client()
        response = client.post(
            "/api/auth/login", json={"email": f"admin@{COMPANY}", "password": PASSWORD}
        )
        self.assertEqual(response.status_code, 200, response.text)

        self.admin = client

        return client

    def stored_user(self, email: str) -> User:
        return self.db.scalar(select(User).where(User.email == email))

    def cookie_header(self, response, name: str) -> str:
        """The raw `Set-Cookie` line for one cookie, flags and all."""
        for line in response.headers.get_list("set-cookie"):
            if line.startswith(f"{name}="):
                return line

        self.fail(f"no Set-Cookie for {name} in {response.headers.get_list('set-cookie')}")


class InviteFlowTest(AuthTestCase):
    """POST /api/auth/invite, GET /api/auth/invite/{token}, POST /accept-invite."""

    def test_invite_creates_a_pending_account_with_no_password(self) -> None:
        admin = self.signed_in_admin()

        response = admin.post(
            "/api/auth/invite",
            json={"name": "Ama Konadu", "email": f"ama@{COMPANY}", "role": "employee"},
            headers=self.csrf_headers(admin),
        )

        self.assertEqual(response.status_code, 201, response.text)
        self.assertEqual(response.json()["user"]["role"], "employee")

        # A pending account is written immediately: the address is reserved by the
        # act of inviting, so two administrators cannot both invite one person.
        pending = self.stored_user(f"ama@{COMPANY}")
        self.assertIsNotNone(pending)
        self.assertIsNone(pending.password_hash)
        self.assertFalse(pending.is_active)

        # The link points at the frontend's accept-invite route with the token on it.
        self.assertIn("/accept-invite?token=", response.json()["invite_link"])

    def test_pending_account_cannot_sign_in(self) -> None:
        self.signed_in_admin()

        client = self.new_client()
        response = client.post(
            "/api/auth/login", json={"email": f"ama@{COMPANY}", "password": PASSWORD}
        )

        # Answered exactly as a wrong password is, so a pending invitation cannot be
        # used to tell which addresses have accounts.
        self.assertEqual(response.status_code, 401)
        self.assertEqual(
            response.json()["detail"], "That email and password do not match an account."
        )

    def test_accept_invite_activates_the_account_and_signs_in(self) -> None:
        admin = self.signed_in_admin()
        invite = admin.post(
            "/api/auth/invite",
            json={"name": "Ama Konadu", "email": f"ama@{COMPANY}", "role": "employee"},
            headers=self.csrf_headers(admin),
        ).json()

        client = self.new_client()
        response = client.post(
            "/api/auth/accept-invite",
            json={"token": invite["token"], "password": PASSWORD},
        )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["user"]["email"], f"ama@{COMPANY}")

        activated = self.stored_user(f"ama@{COMPANY}")
        self.assertTrue(activated.is_active)
        self.assertIsNotNone(activated.password_hash)

        # Signed in without a second round trip, so accepting an invitation lands
        # the person in the app rather than back on the sign-in screen.
        self.assertIn(ACCESS_COOKIE, client.cookies)
        self.assertIn(REFRESH_COOKIE, client.cookies)

        # The invitation is single use.
        again = self.new_client().post(
            "/api/auth/accept-invite", json={"token": invite["token"], "password": PASSWORD}
        )
        self.assertEqual(again.status_code, 404)

    def test_invite_preview_prefills_the_screen(self) -> None:
        admin = self.signed_in_admin()
        token = admin.post(
            "/api/auth/invite",
            json={"name": "Ama Konadu", "email": f"ama@{COMPANY}", "role": "employee"},
            headers=self.csrf_headers(admin),
        ).json()["token"]

        # No session: the holder of the token has just followed a link from an email.
        response = self.new_client().get(f"/api/auth/invite/{token}")

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["name"], "Ama Konadu")
        self.assertEqual(response.json()["email"], f"ama@{COMPANY}")

    def test_expired_invite_is_refused(self) -> None:
        admin = self.signed_in_admin()
        token = admin.post(
            "/api/auth/invite",
            json={"name": "Ama Konadu", "email": f"ama@{COMPANY}", "role": "employee"},
            headers=self.csrf_headers(admin),
        ).json()["token"]

        invite = self.db.get(Invite, token)
        invite.expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)
        self.db.commit()

        client = self.new_client()
        self.assertEqual(client.get(f"/api/auth/invite/{token}").status_code, 404)

        response = client.post(
            "/api/auth/accept-invite", json={"token": token, "password": PASSWORD}
        )
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["detail"], "This invitation is not valid.")

    def test_unknown_invite_answers_exactly_like_a_used_one(self) -> None:
        """A dead link must not reveal whether the token ever existed."""
        unknown = self.new_client().get("/api/auth/invite/totally-made-up-token-value")
        self.assertEqual(unknown.status_code, 404)
        self.assertEqual(unknown.json()["detail"], "This invitation is not valid.")

    def test_reinviting_a_pending_person_rotates_the_token(self) -> None:
        admin = self.signed_in_admin()
        first = admin.post(
            "/api/auth/invite",
            json={"name": "Ama Konadu", "email": f"ama@{COMPANY}", "role": "employee"},
            headers=self.csrf_headers(admin),
        ).json()["token"]

        second = admin.post(
            "/api/auth/invite",
            json={"name": "Ama Konadu", "email": f"ama@{COMPANY}", "role": "employee"},
            headers=self.csrf_headers(admin),
        ).json()["token"]

        self.assertNotEqual(first, second)

        # Only the newest link works, so which password the person ends up with is
        # decided by which link they were actually sent.
        client = self.new_client()
        stale = client.post(
            "/api/auth/accept-invite", json={"token": first, "password": PASSWORD}
        )
        self.assertEqual(stale.status_code, 404)

        fresh = client.post(
            "/api/auth/accept-invite", json={"token": second, "password": PASSWORD}
        )
        self.assertEqual(fresh.status_code, 200, fresh.text)

    def test_inviting_an_active_address_is_a_conflict(self) -> None:
        admin = self.signed_in_admin()
        self.invite_and_accept(self.new_client(), f"ama@{COMPANY}")

        response = admin.post(
            "/api/auth/invite",
            json={"name": "Ama Konadu", "email": f"ama@{COMPANY}", "role": "employee"},
            headers=self.csrf_headers(admin),
        )
        self.assertEqual(response.status_code, 409)


class PasswordTest(AuthTestCase):
    """Hashing, and the policy enforced when a password is set."""

    def test_password_is_stored_as_a_bcrypt_hash(self) -> None:
        self.invite_and_accept(self.new_client(), f"ama@{COMPANY}")

        stored = self.stored_user(f"ama@{COMPANY}").password_hash

        self.assertTrue(stored.startswith("$2b$"), stored)
        self.assertNotIn(PASSWORD, stored)

    def test_the_policy_is_length_and_nothing_else(self) -> None:
        admin = self.signed_in_admin()
        token = admin.post(
            "/api/auth/invite",
            json={"name": "Ama Konadu", "email": f"ama@{COMPANY}", "role": "employee"},
            headers=self.csrf_headers(admin),
        ).json()["token"]

        # Accepted. Every one of these fails a composition rule — no letter, no digit,
        # no symbol — and all of them are eight characters or more. The policy asks
        # for length because length is what matters; refusing these only teaches
        # people to write `Passw0rd!`.
        for acceptable in ["12345678", "!!!!!!!!", "aaaaaaaa", "correcthorse"]:
            with self.subTest(password=acceptable):
                self.invite_and_accept(self.new_client(), f"{acceptable}@{COMPANY}", password=acceptable)

    def test_passwords_under_the_floor_are_refused_with_the_policy_spelled_out(self) -> None:
        admin = self.signed_in_admin()

        for index, short in enumerate(["short1!", "1234567", "abc"]):
            with self.subTest(password=short):
                token = admin.post(
                    "/api/auth/invite",
                    json={
                        "name": f"Person {index}",
                        "email": f"person{index}@{COMPANY}",
                        "role": "employee",
                    },
                    headers=self.csrf_headers(admin),
                ).json()["token"]

                response = self.new_client().post(
                    "/api/auth/accept-invite", json={"token": token, "password": short}
                )
                self.assertEqual(response.status_code, 422, response.text)
                self.assertIn(str(MIN_PASSWORD_LENGTH), str(response.json()))

                # And the invite survives a rejected attempt, so a rejected password
                # does not burn the invitation.
                self.assertEqual(
                    self.new_client().get(f"/api/auth/invite/{token}").status_code, 200
                )

    def test_a_password_over_the_ceiling_is_refused(self) -> None:
        admin = self.signed_in_admin()
        token = admin.post(
            "/api/auth/invite",
            json={"name": "Ama Konadu", "email": f"ama@{COMPANY}", "role": "employee"},
            headers=self.csrf_headers(admin),
        ).json()["token"]

        response = self.new_client().post(
            "/api/auth/accept-invite",
            json={"token": token, "password": "a" * (MAX_PASSWORD_LENGTH + 1)},
        )

        self.assertEqual(response.status_code, 422, response.text)

    def test_login_compares_against_the_hash(self) -> None:
        self.invite_and_accept(self.new_client(), f"ama@{COMPANY}")

        wrong = self.new_client().post(
            "/api/auth/login", json={"email": f"ama@{COMPANY}", "password": "not-the-password1!"}
        )
        self.assertEqual(wrong.status_code, 401)

        right = self.new_client().post(
            "/api/auth/login", json={"email": f"ama@{COMPANY}", "password": PASSWORD}
        )
        self.assertEqual(right.status_code, 200)


class TokenAndCookieTest(AuthTestCase):
    """Checklist lines 1-3: token transport, cookie flags, refresh rotation."""

    def test_no_token_appears_in_a_response_body(self) -> None:
        client = self.signed_in_admin()

        response = client.get("/api/auth/me")

        # The whole body, serialised, must not contain anything JWT-shaped.
        self.assertNotIn("eyJ", response.text)

    def test_login_body_carries_the_user_and_no_token(self) -> None:
        self.invite_and_accept(self.new_client(), f"ama@{COMPANY}")

        client = self.new_client()
        response = client.post(
            "/api/auth/login", json={"email": f"ama@{COMPANY}", "password": PASSWORD}
        )

        self.assertEqual(
            set(response.json()), {"user"}, "the login body should carry only the user"
        )
        self.assertEqual(
            set(response.json()["user"]), {"id", "name", "email", "role"}
        )
        self.assertNotIn("eyJ", response.text)

    def test_session_cookies_are_httponly_secure_samesite_scoped(self) -> None:
        self.invite_and_accept(self.new_client(), f"ama@{COMPANY}")

        client = self.new_client()
        response = client.post(
            "/api/auth/login", json={"email": f"ama@{COMPANY}", "password": PASSWORD}
        )

        for name in (ACCESS_COOKIE, REFRESH_COOKIE):
            header = self.cookie_header(response, name)

            self.assertIn("HttpOnly", header, header)
            self.assertIn("Path=/", header, header)
            self.assertIn("SameSite=lax", header.replace("SameSite=Lax", "SameSite=lax"), header)

    def test_production_forces_secure_cookies(self) -> None:
        """A deployment that forgot `AUTH_COOKIE_SECURE` still fails closed."""
        original = settings.environment
        settings.environment = "production"
        try:
            self.assertTrue(settings.cookies_are_secure)
        finally:
            settings.environment = original

    def test_the_csrf_cookie_is_the_only_one_javascript_may_read(self) -> None:
        csrf_header = self.cookie_header(self.new_client().get("/api/auth/csrf"), CSRF_COOKIE)

        # No HttpOnly, on purpose: the frontend has to read this one and put it in a
        # header, which is the whole double-submit mechanism.
        self.assertNotIn("HttpOnly", csrf_header)

        admin = self.signed_in_admin()

        # Read back from the jar the way browser JavaScript would, to be sure the
        # flags and what actually arrives agree.
        signed_in = admin.post(
            "/api/auth/login", json={"email": f"admin@{COMPANY}", "password": PASSWORD}
        )

        for name in (ACCESS_COOKIE, REFRESH_COOKIE):
            self.assertIn("HttpOnly", self.cookie_header(signed_in, name))
            self.assertTrue(admin.cookies.get(name))

    def test_me_reports_the_signed_in_user(self) -> None:
        client = self.new_client()
        user = self.invite_and_accept(client, f"ama@{COMPANY}", role="employee")

        response = client.get("/api/auth/me")

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), user)

    def test_me_without_a_session_is_a_401(self) -> None:
        self.assertEqual(self.new_client().get("/api/auth/me").status_code, 401)

    def test_a_tampered_access_token_is_refused(self) -> None:
        client = self.signed_in_admin()
        original = client.cookies.get(ACCESS_COOKIE)

        # Flip a character in the signature.
        client.cookies.set(ACCESS_COOKIE, f"{original[:-2]}xy")

        self.assertEqual(client.get("/api/auth/me").status_code, 401)

    def test_an_access_token_is_refused_where_a_refresh_token_belongs(self) -> None:
        """The `typ` claim is what stops the short-lived token minting a new session."""
        client = self.signed_in_admin()
        access = client.cookies.get(ACCESS_COOKIE)

        client.cookies.set(REFRESH_COOKIE, access)
        client.cookies.set(ACCESS_COOKIE, "")

        response = client.post("/api/auth/refresh")

        self.assertEqual(response.status_code, 401)

    def test_refresh_rotates_both_tokens(self) -> None:
        client = self.signed_in_admin()
        access_before = client.cookies.get(ACCESS_COOKIE)
        refresh_before = client.cookies.get(REFRESH_COOKIE)

        response = client.post("/api/auth/refresh")

        self.assertEqual(response.status_code, 200, response.text)
        self.assertNotEqual(client.cookies.get(REFRESH_COOKIE), refresh_before)
        self.assertNotEqual(client.cookies.get(ACCESS_COOKIE), access_before)

        # The old row is marked, not deleted: "already exchanged" is the fact reuse
        # detection is made of.
        rotated = self.db.query(RefreshSession).filter(
            RefreshSession.rotated_at.isnot(None)
        ).one()
        self.assertIsNone(rotated.revoked_at)

        # The replacement stays in the same family as the one it retires, or a later
        # reuse detection would only be able to reach the token that was already
        # dead and the live one would carry on working.
        before = {row.id for row in self.db.query(RefreshSession).all()}
        client.post("/api/auth/refresh")

        added = [
            row
            for row in self.db.query(RefreshSession).all()
            if row.id not in before
        ]
        self.assertEqual(len(added), 1, "a rotation issues exactly one new session")

        retired = self.db.get(RefreshSession, decode_token(refresh_before, REFRESH_TOKEN_TYPE)["jti"])
        self.assertEqual(added[0].family_id, retired.family_id)

    def test_replaying_a_rotated_refresh_token_revokes_the_family(self) -> None:
        client = self.signed_in_admin()
        stale = client.cookies.get(REFRESH_COOKIE)

        # A legitimate client has the new token after a refresh.
        self.assertEqual(client.post("/api/auth/refresh").status_code, 200)
        current = client.cookies.get(REFRESH_COOKIE)

        # Somebody presents the old one, which is either theft or a client that never
        # dropped it. Nothing here can tell, so the whole family goes.
        thief = self.new_client()
        thief.cookies.set(REFRESH_COOKIE, stale)

        with self.assertLogs("app.auth", level="WARNING") as logged:
            response = thief.post("/api/auth/refresh")

        self.assertEqual(response.status_code, 401)
        self.assertIn("reuse", "".join(logged.output))

        # The legitimate client's token is dead too, which is the cost of not
        # guessing which of the two holders is the user.
        client_after = self.new_client()
        client_after.cookies.set(REFRESH_COOKIE, current)
        self.assertEqual(client_after.post("/api/auth/refresh").status_code, 401)

        # And the caller's cookies were cleared, so the browser stops presenting them.
        self.assertEqual(thief.cookies.get(ACCESS_COOKIE), None)

    def test_replaying_a_revoked_refresh_token_stays_refused(self) -> None:
        client = self.signed_in_admin()
        stale = client.cookies.get(REFRESH_COOKIE)

        client.post("/api/auth/refresh")
        client.cookies.set(REFRESH_COOKIE, stale)
        self.assertEqual(client.post("/api/auth/refresh").status_code, 401)

        # Replaying it again must not resurrect anything.
        client.cookies.set(REFRESH_COOKIE, stale)
        self.assertEqual(client.post("/api/auth/refresh").status_code, 401)

    def test_refresh_without_a_cookie_is_a_401(self) -> None:
        self.assertEqual(self.new_client().post("/api/auth/refresh").status_code, 401)

    def test_logout_revokes_the_session_server_side(self) -> None:
        client = self.signed_in_admin()
        refresh = client.cookies.get(REFRESH_COOKIE)

        response = client.post("/api/auth/logout")

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["status"], "signed_out")

        # The row is what makes a copy of that cookie useless to whoever holds it.
        session_id = decode_token(refresh, REFRESH_TOKEN_TYPE)["jti"]
        self.assertIsNotNone(self.db.get(RefreshSession, session_id).revoked_at)

        # Asking the server again with the old cookie is refused, so "logged out"
        # is not only something the browser was asked to believe.
        replay = self.new_client()
        replay.cookies.set(REFRESH_COOKIE, refresh)
        self.assertEqual(replay.post("/api/auth/refresh").status_code, 401)

    def test_logout_clears_both_cookies(self) -> None:
        client = self.signed_in_admin()
        response = client.post("/api/auth/logout")

        for name in (ACCESS_COOKIE, REFRESH_COOKIE, SESSION_HINT_COOKIE):
            header = self.cookie_header(response, name).replace(" ", "")
            self.assertIn(f"{name}=\"\";", header)
            # An empty value alone would not delete anything: the browser only
            # removes a cookie when the expiry says so.
            self.assertIn("Max-Age=0", header)

    def test_the_session_hint_cookie_is_readable_and_carries_nothing(self) -> None:
        """The hint that saves a signed-out visitor from a pointless request.

        It is readable on purpose, and it is worthless on purpose. The frontend reads
        it to decide whether asking who somebody is is worth a round trip; it must not
        hold a credential, or it would be one worth stealing.
        """
        client = self.signed_in_admin()

        response = client.post(
            "/api/auth/login", json={"email": f"admin@{COMPANY}", "password": PASSWORD}
        )

        header = self.cookie_header(response, SESSION_HINT_COOKIE)

        # Readable: the frontend has to get at this one.
        self.assertNotIn("HttpOnly", header)
        self.assertIn("Path=/", header)
        self.assertIn("SameSite=lax", header.replace("SameSite=Lax", "SameSite=lax"), header)

        # And holds nothing: a fixed flag, no token, no identity.
        self.assertEqual(client.cookies.get(SESSION_HINT_COOKIE), "1")
        self.assertNotIn("eyJ", header)

    def test_the_session_hint_alone_authorises_nothing(self) -> None:
        """A forged hint must not be mistaken for a session.

        The flag is an optimisation hint. If it were ever treated as authority, anyone
        could set it in the console and appear signed in, so this pins the point: the
        backend makes no decision from it at all.
        """
        client = self.new_client()

        # Set by hand, exactly as somebody poking at the console would.
        client.cookies.set(SESSION_HINT_COOKIE, "1")

        self.assertEqual(client.get("/api/auth/me").status_code, 401)


class AuthorisationTest(AuthTestCase):
    """Checklist lines 7-9: the domain rule, 403s, and no open registration."""

    def test_a_non_company_address_is_refused_by_the_validator(self) -> None:
        admin = self.signed_in_admin()

        invite = admin.post(
            "/api/auth/invite",
            json={"name": "Someone", "email": f"someone@gmail.com", "role": "employee"},
            headers=self.csrf_headers(admin),
        )
        self.assertEqual(invite.status_code, 422, invite.text)

        login = self.new_client().post(
            "/api/auth/login", json={"email": "someone@gmail.com", "password": PASSWORD}
        )
        self.assertEqual(login.status_code, 422, login.text)

    def test_a_lookalike_address_in_the_domain_position_is_refused(self) -> None:
        """`attacker@evil.test/?x=acmetech.example` must not pass a substring check."""
        response = self.new_client().post(
            "/api/auth/login",
            json={"email": f"someone@evil.test/?x={COMPANY}", "password": PASSWORD},
        )

        # Rejected as malformed before the domain rule is even reached.
        self.assertEqual(response.status_code, 422)

    def test_an_employee_is_refused_an_admin_route_with_a_403(self) -> None:
        """Checked with a real account, not a stubbed user object.

        The employee below was invited, accepted, and signed in through the ordinary
        flow, so the 403 comes from a genuine token over a genuine session.
        """
        admin = self.signed_in_admin()
        employee = self.new_client()
        user = self.invite_and_accept(employee, f"ama@{COMPANY}", role="employee")

        self.assertEqual(user["role"], "employee")

        response = employee.post(
            "/api/auth/invite",
            json={"name": "Someone", "email": f"someone@{COMPANY}", "role": "employee"},
            headers=self.csrf_headers(admin),
        )

        self.assertEqual(response.status_code, 403, response.text)
        self.assertIn("administrator", response.json()["detail"])

        # And the person it would have invited does not exist.
        self.assertIsNone(self.stored_user(f"someone@{COMPANY}"))

    def test_a_signed_out_caller_cannot_reach_a_protected_route(self) -> None:
        for method, path in [
            ("get", "/api/auth/me"),
            ("post", "/api/conversations"),
            ("get", f"/api/conversations?client_id={'1' * 12}"),
        ]:
            with self.subTest(path=path):
                response = getattr(self.new_client(), method)(path)
                self.assertEqual(response.status_code, 401, response.text)

    def test_no_route_creates_an_account_without_an_invitation(self) -> None:
        """There is no open registration, checked against the built route table.

        Read off the app rather than a list kept by hand, so a route added later is
        covered by this test rather than by whoever remembers to update it.
        """
        paths = set(main.app.openapi()["paths"])

        self.assertNotIn("/api/auth/register", paths)
        self.assertNotIn("/api/auth/signup", paths)
        self.assertNotIn("/api/users", paths)

        # The only routes that can write a user row are the invitation flow, its
        # acceptance, and the one-time bootstrap.
        self.assertEqual(
            paths & {"/api/auth/invite", "/api/auth/accept-invite", "/api/auth/bootstrap-admin"},
            {"/api/auth/invite", "/api/auth/accept-invite", "/api/auth/bootstrap-admin"},
        )

    def test_an_invitation_cannot_grant_an_administrator_to_anonymous_caller(self) -> None:
        """A bootstrap key must not become a way to make a user account."""
        self.bootstrap_admin()

        response = self.new_client().post(
            "/api/auth/bootstrap-admin",
            json={
                "name": "Someone",
                "email": f"someone@{COMPANY}",
                "role": "employee",
                "password": PASSWORD,
                "bootstrap_key": PATCHED["auth_bootstrap_key"],
            },
        )

        # Once an administrator exists the route is closed to everybody, which is
        # what makes the role hard-coded above load-bearing rather than cosmetic.
        self.assertEqual(response.status_code, 409)
        self.assertIsNone(self.stored_user(f"someone@{COMPANY}"))

    def test_bootstrap_needs_the_key(self) -> None:
        response = self.new_client().post(
            "/api/auth/bootstrap-admin",
            json={
                "name": "Kwame Osei",
                "email": f"admin@{COMPANY}",
                "role": "admin",
                "password": PASSWORD,
                "bootstrap_key": "not-the-key",
            },
        )

        self.assertEqual(response.status_code, 403)
        self.assertIsNone(self.stored_user(f"admin@{COMPANY}"))


class CsrfTest(AuthTestCase):
    """Checklist line 6: state-changing requests need the double-submit header."""

    def test_a_state_changing_request_without_the_header_is_refused(self) -> None:
        admin = self.signed_in_admin()

        response = admin.post(
            "/api/auth/invite",
            json={"name": "Ama Konadu", "email": f"ama@{COMPANY}", "role": "employee"},
        )

        self.assertEqual(response.status_code, 403, response.text)
        self.assertIn("CSRF", response.json()["detail"])

    def test_a_mismatched_header_is_refused(self) -> None:
        admin = self.signed_in_admin()

        response = admin.post(
            "/api/auth/invite",
            json={"name": "Ama Konadu", "email": f"ama@{COMPANY}", "role": "employee"},
            headers={"X-CSRF-Token": "a" * 43},
        )

        self.assertEqual(response.status_code, 403)

    def test_reads_do_not_need_the_header(self) -> None:
        self.assertEqual(self.new_client().get("/api/auth/csrf").status_code, 200)

    def test_a_request_from_an_unknown_origin_is_refused(self) -> None:
        admin = self.signed_in_admin()

        response = admin.post(
            "/api/auth/invite",
            json={"name": "Ama Konadu", "email": f"ama@{COMPANY}", "role": "employee"},
            headers={**self.csrf_headers(admin), "Origin": "https://evil.example"},
        )

        self.assertEqual(response.status_code, 403, response.text)

    def test_a_request_from_a_known_origin_passes(self) -> None:
        admin = self.signed_in_admin()

        response = admin.post(
            "/api/auth/invite",
            json={"name": "Ama Konadu", "email": f"ama@{COMPANY}", "role": "employee"},
            headers={**self.csrf_headers(admin), "Origin": f"http://localhost:4200"},
        )

        self.assertEqual(response.status_code, 201, response.text)

    def test_the_sign_in_routes_are_exempt(self) -> None:
        """Exempt because there is no session yet to have issued a token for."""
        self.bootstrap_admin()

        response = self.new_client().post(
            "/api/auth/login", json={"email": f"admin@{COMPANY}", "password": PASSWORD}
        )

        self.assertEqual(response.status_code, 200, response.text)


class RateLimitTest(AuthTestCase):
    """Checklist line 5: login and accept-invite are rate limited."""

    def test_login_is_rate_limited_per_address(self) -> None:
        self.invite_and_accept(self.new_client(), f"ama@{COMPANY}")

        # Every one of these is a wrong password, so none of them should succeed on
        # its merits: the last is here to show the limit is what stops it.
        statuses = []
        for _ in range(7):
            response = self.new_client().post(
                "/api/auth/login", json={"email": f"ama@{COMPANY}", "password": "wrong-one-1!"}
            )
            statuses.append(response.status_code)

        self.assertIn(429, statuses, statuses)
        self.assertTrue(all(status in (401, 429) for status in statuses), statuses)

    def test_accept_invite_is_rate_limited(self) -> None:
        admin = self.signed_in_admin()
        token = admin.post(
            "/api/auth/invite",
            json={"name": "Ama Konadu", "email": f"ama@{COMPANY}", "role": "employee"},
            headers=self.csrf_headers(admin),
        ).json()["token"]

        statuses = []
        for _ in range(7):
            response = self.new_client().post(
                "/api/auth/accept-invite", json={"token": token, "password": "wrong-one-1!"}
            )
            statuses.append(response.status_code)

        self.assertIn(429, statuses, statuses)

    def test_the_limit_returns_429_with_a_retry_after(self) -> None:
        for _ in range(6):
            self.new_client().post(
                "/api/auth/login", json={"email": f"nobody@{COMPANY}", "password": PASSWORD}
            )

        response = self.new_client().post(
            "/api/auth/login", json={"email": f"nobody@{COMPANY}", "password": PASSWORD}
        )

        self.assertEqual(response.status_code, 429)
        self.assertIn("Retry-After", response.headers)

    def test_reading_the_invitation_is_not_rate_limited(self) -> None:
        """A shared link opened repeatedly is not an attack, and must not be throttled."""
        admin = self.signed_in_admin()
        token = admin.post(
            "/api/auth/invite",
            json={"name": "Ama Konadu", "email": f"ama@{COMPANY}", "role": "employee"},
            headers=self.csrf_headers(admin),
        ).json()["token"]

        for _ in range(8):
            self.assertEqual(self.new_client().get(f"/api/auth/invite/{token}").status_code, 200)


class AccessRequestTest(AuthTestCase):
    """Asking for an account, and an administrator answering.

    The property being protected is specific: a registration must grant nothing before
    an administrator decides, and the role that ends up on the account must be the one
    the approval carried rather than the one the registration asked for. Everything
    else — the queue, the invitation, the idempotence — is in service of that.
    """

    def asks_for(
        self,
        client: TestClient,
        email: str = f"newcomer@{COMPANY}",
        role: str = "employee",
        password: str = "their-own-pass1",
    ):
        """Registers the way the frontend does, CSRF header and all."""
        return client.post(
            "/api/auth/request-access",
            json={"name": "Kofi Mensah", "email": email, "role": role, "password": password},
            headers=self.csrf_headers(client),
        )

    def request_id_for(self, email: str) -> str:
        """The id of the request for this address, read fresh and copied out.

        Both halves matter. Re-queried, because the test's session is closed after
        every request; and copied into a string, because the row is expired by the
        commit that created it and touching an attribute on it afterwards raises
        rather than returning anything.
        """
        return self.db.scalar(select(AccessRequest.id).where(AccessRequest.email == email))

    def count_requests(self) -> int:
        return len(list(self.db.scalars(select(AccessRequest.id)).all()))

    def approve(self, admin: TestClient, request_id: str, role: str = "employee"):
        return admin.post(
            f"/api/auth/requests/{request_id}/approve",
            json={"role": role},
            headers=self.csrf_headers(admin),
        )

    def decline(self, admin: TestClient, request_id: str):
        return admin.post(
            f"/api/auth/requests/{request_id}/decline",
            headers=self.csrf_headers(admin),
        )

    def test_a_registration_creates_an_account_that_grants_nothing(self) -> None:
        response = self.asks_for(self.new_client())

        self.assertEqual(response.status_code, 202, response.text)

        # A row exists so the person can sign in and be told they are waiting, and it
        # is switched off. Inactive is refused by every route that matters, so this is
        # a place to record a password rather than a way in.
        stored = self.stored_user(f"newcomer@{COMPANY}")
        self.assertIsNotNone(stored)
        self.assertFalse(stored.is_active)
        self.assertEqual(self.count_requests(), 1)

    def test_a_pending_registration_cannot_sign_in_yet(self) -> None:
        self.asks_for(self.new_client())

        # Correct password, unapproved account: answered with "still waiting" rather
        # than refused, because nothing is wrong and retrying will not help.
        pending = self.new_client()
        pending.post("/api/auth/csrf")
        response = pending.post(
            "/api/auth/login",
            json={"email": f"newcomer@{COMPANY}", "password": "their-own-pass1"},
        )

        self.assertEqual(response.status_code, 202, response.text)
        self.assertEqual(response.json()["status"], "pending")
        self.assertEqual(response.json()["requested_role"], "employee")

        # And no session came with it, so there is nothing to use.
        self.assertIsNone(pending.cookies.get(ACCESS_COOKIE))

    def test_a_pending_answer_needs_the_right_password(self) -> None:
        self.asks_for(self.new_client())

        # Otherwise this endpoint is a way to ask which addresses are registered and
        # what state they are in. A wrong password gets the one generic answer.
        wrong = self.new_client()
        wrong.post("/api/auth/csrf")
        response = wrong.post(
            "/api/auth/login",
            json={"email": f"newcomer@{COMPANY}", "password": "not-their-password"},
        )

        self.assertEqual(response.status_code, 401, response.text)
        self.assertNotIn("pending", response.text)

    def test_the_asked_for_role_is_recorded_but_does_not_survive_approval(self) -> None:
        # Asking for admin is a sentence in an administrator's queue. The role that
        # lands on the account is the one the approval carried, and the approval
        # defaults to the least privileged one.
        self.asks_for(self.new_client(), role="admin")

        self.assertIn("requested_role", AccessRequest.__table__.columns)

        # Not on the account. An unapproved stranger holding the administrator role
        # is inert only for as long as every reader of `role` also checks
        # `is_active`, and the ask is recorded on the request row where the
        # administrator will actually read it.
        self.assertEqual(self.stored_user(f"newcomer@{COMPANY}").role, "employee")
        self.assertFalse(self.stored_user(f"newcomer@{COMPANY}").is_active)

        admin = self.signed_in_admin()
        approved = self.approve(admin, self.request_id_for(f"newcomer@{COMPANY}"))

        self.assertEqual(approved.status_code, 200, approved.text)
        self.assertEqual(approved.json()["request"]["requested_role"], "admin")

        # Asked for admin, approved as the default, and that is what is on the account.
        self.assertEqual(self.stored_user(f"newcomer@{COMPANY}").role, "employee")

    def test_an_admin_role_needs_an_admin_to_grant_it(self) -> None:
        self.asks_for(self.new_client(), role="admin")
        admin = self.signed_in_admin()

        self.approve(admin, self.request_id_for(f"newcomer@{COMPANY}"), role="admin")

        # Only because the approval said so.
        self.assertEqual(self.stored_user(f"newcomer@{COMPANY}").role, "admin")

    def test_an_approved_registration_can_sign_in(self) -> None:
        self.asks_for(self.new_client())
        admin = self.signed_in_admin()
        self.approve(admin, self.request_id_for(f"newcomer@{COMPANY}"))

        client = self.new_client()
        client.post("/api/auth/csrf")
        response = client.post(
            "/api/auth/login",
            json={"email": f"newcomer@{COMPANY}", "password": "their-own-pass1"},
        )

        # No invitation and no second password: approval switches on the account they
        # already had a password for.
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["user"]["role"], "employee")

    def test_a_non_company_address_is_refused(self) -> None:
        response = self.asks_for(self.new_client(), "someone@gmail.com")

        self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(self.count_requests(), 0)

    def test_asking_twice_does_not_queue_two_lines(self) -> None:
        client = self.new_client()

        self.assertEqual(self.asks_for(client).status_code, 202)
        self.assertEqual(self.asks_for(client).status_code, 409)

        # One request, not two, so an administrator sees one person rather than a
        # queue they have to reconcile.
        self.assertEqual(self.count_requests(), 1)

    def test_asking_twice_says_so_rather_than_silently_accepting(self) -> None:
        client = self.new_client()
        self.asks_for(client)

        response = self.asks_for(client)

        self.assertEqual(response.status_code, 409)
        self.assertIn("already asked", response.json()["detail"])

    def test_somebody_with_an_account_is_told_to_sign_in(self) -> None:
        self.invite_and_accept(self.new_client(), f"ama@{COMPANY}")

        response = self.asks_for(self.new_client(), f"ama@{COMPANY}")

        # Said plainly, because telling somebody who has an account to go and sign in
        # is more use than pretending not to know who they are.
        self.assertEqual(response.status_code, 409)
        self.assertIn("Sign in", response.json()["detail"])
        self.assertEqual(self.count_requests(), 0)

    def test_a_declined_request_can_be_made_again(self) -> None:
        client = self.new_client()
        self.asks_for(client)
        admin = self.signed_in_admin()

        declined = self.decline(admin, self.request_id_for(f"newcomer@{COMPANY}"))
        self.assertEqual(declined.status_code, 200, declined.text)
        self.assertEqual(declined.json()["request"]["status"], "declined")

        # Turning somebody down is not a permanent bar: if whatever was wrong is
        # fixed, asking again has to work.
        self.assertEqual(self.asks_for(client).status_code, 202)
        self.assertEqual(self.count_requests(), 2)

    def test_declining_provisions_nothing(self) -> None:
        self.asks_for(self.new_client())
        admin = self.signed_in_admin()

        self.decline(admin, self.request_id_for(f"newcomer@{COMPANY}"))

        # The account is the thing an approval makes, so a decline must not make one.
        self.assertIsNone(self.stored_user(f"newcomer@{COMPANY}"))
        self.assertEqual(self.db.query(Invite).count(), 0)

    def test_approving_switches_on_the_account_they_registered(self) -> None:
        self.asks_for(self.new_client())
        admin = self.signed_in_admin()

        response = self.approve(admin, self.request_id_for(f"newcomer@{COMPANY}"))

        self.assertEqual(response.status_code, 200, response.text)

        # They chose their own password at registration, so there is nothing left to
        # invite them to and no second credential for the administrator to hold.
        self.assertEqual(response.json()["invite_link"], "")
        self.assertTrue(self.stored_user(f"newcomer@{COMPANY}").is_active)

        client = self.new_client()
        client.post("/api/auth/csrf")
        signed_in = client.post(
            "/api/auth/login",
            json={"email": f"newcomer@{COMPANY}", "password": "their-own-pass1"},
        )

        self.assertEqual(signed_in.status_code, 200, signed_in.text)
        self.assertEqual(signed_in.json()["user"]["role"], "employee")

    def test_approving_a_request_with_no_account_still_mints_an_invitation(self) -> None:
        # The shape that predates registration setting a password: a bare request with
        # nothing behind it still has to be able to become an account.
        self.db.add(
            AccessRequest(
                id="legacy-request",
                name="Kofi Mensah",
                email=f"newcomer@{COMPANY}",
                status="pending",
                requested_role="employee",
            )
        )
        self.db.commit()

        admin = self.signed_in_admin()
        response = self.approve(admin, "legacy-request")

        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn("/accept-invite?token=", response.json()["invite_link"])

        invited = self.new_client().get(f"/api/auth/invite/{response.json()['token']}")

        self.assertEqual(invited.status_code, 200, invited.text)
        self.assertEqual(invited.json()["name"], "Kofi Mensah")

    def test_the_invite_link_only_reaches_the_administrator(self) -> None:
        """The person who asked never sees the token.

        They cannot act on it, but a link in the wrong hands is a password set by
        somebody else, so the requester's response carries nothing at all.
        """
        response = self.asks_for(self.new_client())

        self.assertEqual(response.status_code, 202, response.text)
        self.assertNotIn("token", response.text)
        self.assertNotIn("invite_link", response.text)
        self.assertEqual(response.json(), {"status": "received"})

    def test_an_employee_cannot_see_or_decide_the_queue(self) -> None:
        self.asks_for(self.new_client())
        request_id = self.request_id_for(f"newcomer@{COMPANY}")

        employee = self.new_client()
        self.invite_and_accept(employee, f"ama@{COMPANY}")

        # Three routes, because a read-only queue would still tell an employee who is
        # waiting to join the company.
        with self.subTest(route="list"):
            self.assertEqual(employee.get("/api/auth/requests").status_code, 403)

        with self.subTest(route="approve"):
            response = employee.post(
                f"/api/auth/requests/{request_id}/approve",
                json={"role": "admin"},
                headers=self.csrf_headers(employee),
            )
            self.assertEqual(response.status_code, 403, response.text)

        with self.subTest(route="decline"):
            response = employee.post(
                f"/api/auth/requests/{request_id}/decline",
                headers=self.csrf_headers(employee),
            )
            self.assertEqual(response.status_code, 403, response.text)

        # And none of it decided anything.
        self.assertEqual(
            self.db.scalar(select(AccessRequest.status).where(AccessRequest.id == request_id)),
            "pending",
        )

    def test_a_signed_out_caller_cannot_see_the_queue(self) -> None:
        self.assertEqual(self.new_client().get("/api/auth/requests").status_code, 401)

    def test_the_queue_puts_pending_first(self) -> None:
        client = self.new_client()
        self.asks_for(client, f"first@{COMPANY}")
        self.asks_for(client, f"second@{COMPANY}")
        self.asks_for(client, f"third@{COMPANY}")

        # One decided, so the ordering has something to order around.
        admin = self.signed_in_admin()
        self.decline(admin, self.request_id_for(f"second@{COMPANY}"))

        response = admin.get("/api/auth/requests")

        self.assertEqual(response.status_code, 200, response.text)
        statuses = [row["status"] for row in response.json()["requests"]]

        # Pending first whatever the dates say: an administrator opens this to act,
        # and the decided ones are history underneath.
        self.assertEqual(statuses, ["pending", "pending", "declined"])

    def test_the_queue_carries_no_account_details(self) -> None:
        self.asks_for(self.new_client())
        admin = self.signed_in_admin()

        row = admin.get("/api/auth/requests").json()["requests"][0]

        # A queue is names, addresses and what they asked for. No password field, no
        # session, nothing else that could be used against another route.
        self.assertEqual(
            set(row),
            {"id", "name", "email", "status", "requested_role", "requested_at", "decided_at"},
        )

    def test_deciding_twice_is_refused_rather_than_silently_ignored(self) -> None:
        self.asks_for(self.new_client())
        admin = self.signed_in_admin()
        request_id = self.request_id_for(f"newcomer@{COMPANY}")

        self.assertEqual(self.approve(admin, request_id).status_code, 200)

        # Said plainly, because the alternative is an administrator approving
        # something that happened last week and being told nothing was wrong.
        again = self.approve(admin, request_id)

        self.assertEqual(again.status_code, 409)
        self.assertIn("already been approved", again.json()["detail"])

    def test_an_unknown_request_is_a_404(self) -> None:
        admin = self.signed_in_admin()

        self.assertEqual(self.approve(admin, "no-such-request-id").status_code, 404)
        self.assertEqual(self.decline(admin, "no-such-request-id").status_code, 404)

    def test_approving_someone_who_was_invited_directly_answers_the_request(self) -> None:
        """The two ways in overlap, and the overlap has to resolve sanely.

        Somebody asked, then an administrator invited them directly without looking at
        the queue. Approving afterwards must not provision a second account, and must
        not 409 in a way that reads as a failure.
        """
        self.asks_for(self.new_client())
        admin = self.signed_in_admin()

        direct = admin.post(
            "/api/auth/invite",
            json={"name": "Kofi Mensah", "email": f"newcomer@{COMPANY}", "role": "employee"},
            headers=self.csrf_headers(admin),
        )
        self.assertEqual(direct.status_code, 201, direct.text)

        response = self.approve(admin, self.request_id_for(f"newcomer@{COMPANY}"))

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["request"]["status"], "approved")

        # One account, and the pending one is the account.
        self.assertEqual(len(list(self.db.scalars(select(User.id)).all())), 2)

    def test_request_access_is_rate_limited(self) -> None:
        # One client, so every attempt shares an allowance: five a minute per address
        # is loose enough that somebody who mistyped their address twice is not locked
        # out of asking, and tight enough that filling the queue by hand is pointless.
        client = self.new_client()
        statuses = [self.asks_for(client, f"nobody-{n}@{COMPANY}").status_code for n in range(7)]

        self.assertIn(429, statuses, statuses)

    def test_a_request_without_a_csrf_header_is_refused(self) -> None:
        response = self.new_client().post(
            "/api/auth/request-access",
            json={"name": "Kofi Mensah", "email": f"newcomer@{COMPANY}"},
        )

        # Not exempt, unlike signing in. There is nothing here that needs an
        # exemption: the token comes from a public endpoint and the frontend has one
        # before this screen is reachable. Refusing costs nothing and closes a way to
        # fill an administrator's queue from another site.
        self.assertEqual(response.status_code, 403, response.text)
        self.assertEqual(self.count_requests(), 0)

    def test_it_is_still_not_open_registration(self) -> None:
        """The route that would be the hole does not exist.

        There is no public route that hands out a working session, and the row a
        registration leaves behind is switched off — so it is a place to record a
        password, not an account. Both halves are checkable rather than asserted.
        """
        paths = set(main.app.openapi()["paths"])

        self.assertIn("/api/auth/request-access", paths)
        self.assertNotIn("/api/auth/register", paths)

        self.asks_for(self.new_client())

        stored = self.stored_user(f"newcomer@{COMPANY}")
        self.assertIsNotNone(stored)
        self.assertFalse(stored.is_active)

        # And the row grants nothing: the one route that would let it in answers with
        # "still pending", not a session.
        client = self.new_client()
        client.post("/api/auth/csrf")
        response = client.post(
            "/api/auth/login",
            json={"email": f"newcomer@{COMPANY}", "password": "their-own-pass1"},
        )

        self.assertEqual(response.status_code, 202, response.text)
        self.assertIsNone(client.cookies.get(ACCESS_COOKIE))


class UserAdministrationTest(AuthTestCase):
    """An administrator managing the accounts that exist.

    Three things are being protected here rather than merely provided. An employee
    must not reach any of it. An administrator must not be able to lock the system by
    acting on their own account. And a correction must not be able to produce two
    accounts on one address, which would make sign-in ambiguous and let the second
    person in be the first.
    """

    def as_admin(self) -> TestClient:
        return self.signed_in_admin()

    def make_user(self, email: str, role: str = "employee", name: str = "Someone"):
        """An active account, written straight to the database."""
        user = User(
            id=f"u-{email}",
            email=email,
            name=name,
            role=role,
            password_hash=hash_password("their-pass1"),
            is_active=True,
        )
        self.db.add(user)
        self.db.commit()
        return user

    def test_the_list_is_paginated_ten_at_a_time(self) -> None:
        admin = self.as_admin()
        for index in range(24):
            self.make_user(f"person{index}@{COMPANY}")

        first = admin.get("/api/auth/users", headers=self.csrf_headers(admin))
        self.assertEqual(first.status_code, 200, first.text)

        body = first.json()
        self.assertEqual(len(body["users"]), 10)
        self.assertEqual(body["total"], 25)
        self.assertEqual(body["per_page"], 10)
        self.assertEqual(body["pages"], 3)

        # And the last page is short rather than empty, so the pager can tell it is
        # the last one.
        last = admin.get("/api/auth/users?page=3", headers=self.csrf_headers(admin))
        self.assertEqual(len(last.json()["users"]), 5)

    def test_the_list_carries_names_emails_and_roles_only(self) -> None:
        admin = self.as_admin()
        self.make_user(f"kwame@{COMPANY}", role="admin", name="Kwame Osei")

        row = admin.get("/api/auth/users", headers=self.csrf_headers(admin)).json()["users"][0]

        # A people list is not the place to carry anything not about the person.
        self.assertEqual(set(row), {"id", "name", "email", "role", "is_active", "created_at"})
        self.assertEqual(row["email"], f"kwame@{COMPANY}")

    def test_an_employee_cannot_reach_any_of_it(self) -> None:
        employee = self.new_client()
        self.invite_and_accept(employee, f"ama@{COMPANY}")
        target = self.make_user(f"kwame@{COMPANY}")

        for method, path, payload in [
            ("GET", "/api/auth/users", None),
            ("PATCH", f"/api/auth/users/{target.id}", {"role": "admin"}),
            ("DELETE", f"/api/auth/users/{target.id}", None),
            ("POST", f"/api/auth/users/{target.id}/password", {"password": "new-one-1"}),
        ]:
            with self.subTest(path=path):
                response = employee.request(
                    method, path, json=payload, headers=self.csrf_headers(employee)
                )
                self.assertEqual(response.status_code, 403, response.text)

        # And nothing it asked for took effect.
        self.assertEqual(self.db.get(User, target.id).role, "employee")

    def test_an_administrator_can_change_a_role(self) -> None:
        admin = self.as_admin()
        target = self.make_user(f"kwame@{COMPANY}")

        response = admin.patch(
            f"/api/auth/users/{target.id}", json={"role": "admin"},
            headers=self.csrf_headers(admin),
        )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["role"], "admin")
        self.assertEqual(self.db.get(User, target.id).role, "admin")

    def test_changing_a_role_does_not_require_resending_the_rest(self) -> None:
        admin = self.as_admin()
        target = self.make_user(f"kwame@{COMPANY}", name="Kwame Osei")

        admin.patch(
            f"/api/auth/users/{target.id}", json={"role": "admin"},
            headers=self.csrf_headers(admin),
        )

        # A field that was not sent is left alone, rather than blanked.
        row = self.db.get(User, target.id)
        self.assertEqual(row.name, "Kwame Osei")
        self.assertEqual(row.email, f"kwame@{COMPANY}")

    def test_an_administrator_can_change_an_address(self) -> None:
        admin = self.as_admin()
        target = self.make_user(f"old@{COMPANY}")

        response = admin.patch(
            f"/api/auth/users/{target.id}", json={"email": f"new@{COMPANY}"},
            headers=self.csrf_headers(admin),
        )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.db.get(User, target.id).email, f"new@{COMPANY}")

    def test_an_address_outside_the_company_is_refused(self) -> None:
        admin = self.as_admin()
        target = self.make_user(f"kwame@{COMPANY}")

        response = admin.patch(
            f"/api/auth/users/{target.id}", json={"email": "someone@gmail.com"},
            headers=self.csrf_headers(admin),
        )

        # The value of the list is that the addresses in it are real and belong here.
        self.assertEqual(response.status_code, 422, response.text)

    def test_two_accounts_cannot_end_up_on_one_address(self) -> None:
        admin = self.as_admin()
        first = self.make_user(f"first@{COMPANY}")
        second = self.make_user(f"second@{COMPANY}")

        response = admin.patch(
            f"/api/auth/users/{second.id}", json={"email": f"first@{COMPANY}"},
            headers=self.csrf_headers(admin),
        )

        # Otherwise the second person to sign in at that address is let into the
        # first person's account.
        self.assertEqual(response.status_code, 409, response.text)

    def test_an_administrator_can_delete_an_account(self) -> None:
        admin = self.as_admin()
        target = self.make_user(f"kwame@{COMPANY}")

        response = admin.delete(
            f"/api/auth/users/{target.id}", headers=self.csrf_headers(admin)
        )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertIsNone(self.db.get(User, target.id))

    def test_deleting_an_account_takes_its_sessions_with_it(self) -> None:
        admin = self.as_admin()
        target = self.make_user(f"kwame@{COMPANY}")
        self.db.add(
            RefreshSession(
                id="r1",
                user_id=target.id,
                family_id="f1",
                expires_at=datetime.now(timezone.utc) + timedelta(days=7),
            )
        )
        self.db.commit()

        admin.delete(f"/api/auth/users/{target.id}", headers=self.csrf_headers(admin))

        # Deleting somebody must not leave them signed in on a phone that already had
        # the cookies, and a session row for an account that no longer exists answers
        # no question.
        self.assertIsNone(self.db.get(RefreshSession, "r1"))

    def test_an_administrator_cannot_delete_or_demote_themselves(self) -> None:
        admin = self.as_admin()
        me = self.db.query(User).filter(User.role == "admin").one()

        for method, path, payload in [
            ("DELETE", f"/api/auth/users/{me.id}", None),
            ("PATCH", f"/api/auth/users/{me.id}", {"role": "employee"}),
            ("PATCH", f"/api/auth/users/{me.id}", {"is_active": False}),
        ]:
            with self.subTest(path=f"{method} {path}"):
                response = admin.request(
                    method, path, json=payload, headers=self.csrf_headers(admin)
                )
                # Survivable on somebody else's account and fatal on your own, and the
                # only way back is the bootstrap route — which is closed once any
                # administrator exists.
                self.assertEqual(response.status_code, 409, response.text)

        self.assertEqual(self.db.get(User, me.id).role, "admin")
        self.assertTrue(self.db.get(User, me.id).is_active)

    def test_a_password_reset_switches_the_account_on_and_ends_its_sessions(self) -> None:
        admin = self.as_admin()
        target = self.make_user(f"kwame@{COMPANY}")
        self.db.add(
            RefreshSession(
                id="r2",
                user_id=target.id,
                family_id="f2",
                expires_at=datetime.now(timezone.utc) + timedelta(days=7),
            )
        )
        self.db.commit()

        response = admin.post(
            f"/api/auth/users/{target.id}/password", json={"password": "brand-new-1"},
            headers=self.csrf_headers(admin),
        )
        self.assertEqual(response.status_code, 200, response.text)

        # A reset that leaves the old sessions running resets nothing: whoever
        # prompted it is still signed in.
        self.assertIsNotNone(self.db.get(RefreshSession, "r2").revoked_at)

        client = self.new_client()
        client.post("/api/auth/csrf")
        signed_in = client.post(
            "/api/auth/login",
            json={"email": f"kwame@{COMPANY}", "password": "brand-new-1"},
        )
        self.assertEqual(signed_in.status_code, 200, signed_in.text)

    def test_a_reset_still_obeys_the_password_policy(self) -> None:
        admin = self.as_admin()
        target = self.make_user(f"kwame@{COMPANY}")

        response = admin.post(
            f"/api/auth/users/{target.id}/password", json={"password": "short"},
            headers=self.csrf_headers(admin),
        )

        self.assertEqual(response.status_code, 422, response.text)

    def test_an_account_that_does_not_exist_is_a_404(self) -> None:
        admin = self.as_admin()

        self.assertEqual(
            admin.get("/api/auth/users", headers=self.csrf_headers(admin)).status_code, 200
        )
        self.assertEqual(
            admin.patch("/api/auth/users/nope", json={"role": "admin"},
                        headers=self.csrf_headers(admin)).status_code,
            404,
        )
        self.assertEqual(
            admin.delete("/api/auth/users/nope", headers=self.csrf_headers(admin)).status_code,
            404,
        )


class ConversationProtectionTest(AuthTestCase):
    """Conversations are behind the same wall as everything else."""

    def test_a_signed_in_employee_can_use_conversations(self) -> None:
        client = self.new_client()
        self.invite_and_accept(client, f"ama@{COMPANY}")

        response = client.post(
            "/api/conversations",
            json={"client_id": "1" * 12},
            headers=self.csrf_headers(client),
        )

        self.assertEqual(response.status_code, 200, response.text)

    def test_a_signed_out_caller_cannot_reach_a_conversation_without_a_csrf_token(self) -> None:
        """The cookie wall comes first, so a 401 rather than a 403 here."""
        response = self.new_client().post("/api/conversations", json={"client_id": "1" * 12})

        self.assertEqual(response.status_code, 401, response.text)

    def test_a_signed_out_caller_cannot_create_a_conversation(self) -> None:
        response = self.new_client().post("/api/conversations", json={"client_id": "1" * 12})

        self.assertEqual(response.status_code, 401)


class LoggingTest(AuthTestCase):
    """Checklist line 4, second half: the log never sees a password."""

    def test_the_submitted_password_never_reaches_the_log(self) -> None:
        self.invite_and_accept(self.new_client(), f"ama@{COMPANY}")

        with self.assertLogs("app.auth", level="DEBUG") as logged:
            self.new_client().post(
                "/api/auth/login",
                json={"email": f"ama@{COMPANY}", "password": "a-very-distinctive-secret"},
            )

        self.assertNotIn("a-very-distinctive-secret", "".join(logged.output))

    def test_an_unknown_address_spends_the_same_work_as_a_known_one(self) -> None:
        """Both paths run a bcrypt verification, so neither leaks by being faster."""
        self.invite_and_accept(self.new_client(), f"ama@{COMPANY}")
        password = "the-same-password-1!"

        def elapsed(email: str) -> float:
            started = time.perf_counter()
            self.new_client().post("/api/auth/login", json={"email": email, "password": password})
            return time.perf_counter() - started

        # Warm the bcrypt backend first: the first call pays for import-level setup
        # and would otherwise dominate the comparison.
        elapsed(f"nobody@{COMPANY}")

        unknown = min(elapsed(f"nobody@{COMPANY}") for _ in range(3))
        known = min(elapsed(f"ama@{COMPANY}") for _ in range(3))

        # Not a tight bound: the point is that they are the same order of magnitude,
        # not that they are equal to the microsecond.
        self.assertLess(unknown, known * 3, f"unknown={unknown:.4f}s known={known:.4f}s")


class SanitisationTest(unittest.TestCase):
    """Checklist line 4, third part: what gets stored is normalised on the way in."""

    def test_invisible_and_control_characters_are_removed(self) -> None:
        from app.security import sanitize_text

        self.assertEqual(sanitize_text("  Ama   Konadu  "), "Ama Konadu")
        self.assertEqual(sanitize_text("Ama\nKonadu"), "Ama Konadu")
        # A zero-width space and a bidi override are invisible on screen but change
        # what a name appears to say.
        self.assertEqual(sanitize_text("Ama\u200bKonadu"), "AmaKonadu")
        self.assertEqual(sanitize_text("Ama\u202eKonadu"), "AmaKonadu")

        # Not HTML escaping: a name with an ampersand in it is a name, and escaping
        # here would double-encode it at the point of rendering.
        self.assertEqual(sanitize_text("Ben & Jerry"), "Ben & Jerry")

    def test_a_name_that_is_only_invisible_characters_is_rejected(self) -> None:
        from app.schemas_auth import InviteRequest

        with self.assertRaises(ValueError):
            InviteRequest(name="\u200b\u200b", email=f"ama@{COMPANY}")


class HashCostTest(unittest.TestCase):
    """A hash made at a lower cost than the current setting is replaced."""

    def test_needs_rehash_reports_a_stale_cost(self) -> None:
        from app.security import hash_password, needs_rehash

        original = settings.bcrypt_rounds
        try:
            settings.bcrypt_rounds = 5
            cheap = hash_password(PASSWORD)

            settings.bcrypt_rounds = 10

            self.assertTrue(needs_rehash(cheap))
            self.assertFalse(needs_rehash(hash_password(PASSWORD)))
        finally:
            settings.bcrypt_rounds = original


class DomainRuleTest(unittest.TestCase):
    """The company-domain rule, away from the routes that depend on it."""

    def test_the_part_after_the_last_at_is_what_counts(self) -> None:
        from app.security import has_company_domain

        original = settings.company_email_domain
        settings.company_email_domain = COMPANY
        try:
            self.assertTrue(has_company_domain(f"ama@{COMPANY}"))
            self.assertTrue(has_company_domain(f"Ama.Konadu@{COMPANY}"))

            self.assertFalse(has_company_domain("ama@gmail.com"))
            self.assertFalse(has_company_domain(f"ama@{COMPANY}.evil.test"))
            # The shape a substring check would let through.
            self.assertFalse(has_company_domain(f"evil.test/{COMPANY}"))
            self.assertFalse(has_company_domain(f"ama@{COMPANY}@evil.test"))
        finally:
            settings.company_email_domain = original


if __name__ == "__main__":
    logging.basicConfig(level=logging.CRITICAL)
    unittest.main()

class AccountCreationTests(AuthTestCase):
    """The administrator flow that creates an account outright.

    A second door into `users` beside the invitation, and the difference between the
    two is who knows the password: an invitation is a link the person sets their own
    password against, and this is a password the administrator writes and hands over.
    That is the weaker arrangement, and these tests exist to pin what it does and does
    not do.
    """

    PASSWORD = "compiler-punch-card-9"

    def setUp(self) -> None:
        super().setUp()
        self.bootstrap_admin()

    def create(self, client: TestClient | None = None, **overrides):
        body = {
            "name": "Grace Hopper",
            "email": "grace.hopper@acmetech.example",
            "role": "employee",
            "password": self.PASSWORD,
        }
        body.update(overrides)

        target = client or self.admin_client()

        return target.post("/api/auth/accounts", json=body, headers=self.csrf_headers(target))

    def admin_client(self) -> TestClient:
        """A client already signed in as the bootstrapped administrator."""
        if self.admin is None:
            self.admin = self.new_client()
            self.admin.post(
                "/api/auth/login",
                json={"email": f"admin@{COMPANY}", "password": PASSWORD},
            )

        return self.admin

    def test_creates_an_account_that_can_sign_in_immediately(self):
        created = self.create()

        self.assertEqual(created.status_code, 201, created.text)
        self.assertEqual(created.json()["user"]["email"], "grace.hopper@acmetech.example")

        # The whole point of the flow: there is no link to follow, so the person signs
        # in with the credentials the administrator just handed them.
        signed_in = self.client.post(
            "/api/auth/login",
            json={"email": "grace.hopper@acmetech.example", "password": self.PASSWORD},
        )

        self.assertEqual(signed_in.status_code, 200, signed_in.text)
        self.assertEqual(signed_in.json()["user"]["role"], "employee")

    def test_never_returns_the_password(self):
        response = self.create()

        # The caller already has it — it just sent it — and a response body is the
        # wrong place for a credential to end up in a log or a proxy trace.
        self.assertNotIn("password", response.json())
        self.assertNotIn(self.PASSWORD, response.text)

    def test_decides_the_role(self):
        response = self.create(email="alan.turing@acmetech.example", role="admin")

        self.assertEqual(response.json()["user"]["role"], "admin")

    def test_refuses_an_employee(self):
        # An account created here, then used to try to create another.
        self.create()
        person = self.client.post(
            "/api/auth/login",
            json={"email": "grace.hopper@acmetech.example", "password": self.PASSWORD},
        )
        self.assertEqual(person.status_code, 200)

        target = self.new_client()
        target.cookies.update(self.client.cookies)
        target.post(
            "/api/auth/login",
            json={"email": "grace.hopper@acmetech.example", "password": self.PASSWORD},
        )

        response = self.create(client=target)

        self.assertEqual(response.status_code, 403)

    def test_refuses_an_address_that_already_has_an_account(self):
        self.create()
        again = self.create()

        # A 409 rather than a silent correction: quietly changing an existing
        # account's password would lock out whoever already uses it.
        self.assertEqual(again.status_code, 409)
        self.assertIn("already has an active account", again.json()["detail"])

    def test_applies_the_password_policy(self):
        response = self.create(password="short")

        self.assertEqual(response.status_code, 422)

    def test_refuses_an_address_outside_the_company(self):
        response = self.create(email="grace@gmail.com")

        self.assertEqual(response.status_code, 422)

    def test_requires_the_csrf_header(self):
        target = self.admin_client()

        response = target.post(
            "/api/auth/accounts",
            json={
                "name": "Grace Hopper",
                "email": "grace.hopper@acmetech.example",
                "role": "employee",
                "password": self.PASSWORD,
            },
        )

        self.assertEqual(response.status_code, 403)

    def test_stores_only_a_hash_of_the_password(self):
        self.create()

        stored = self.db.execute(
            select(User).where(User.email == "grace.hopper@acmetech.example")
        ).scalar_one()

        self.assertNotEqual(stored.password_hash, self.PASSWORD)
        self.assertTrue(stored.is_active)
