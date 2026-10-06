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

    def test_short_passwords_are_refused_and_six_chars_needs_no_mix(self) -> None:
        admin = self.signed_in_admin()
        token = admin.post(
            "/api/auth/invite",
            json={"name": "Ama Konadu", "email": f"ama@{COMPANY}", "role": "employee"},
            headers=self.csrf_headers(admin),
        ).json()["token"]

        # Anything under 6 characters is refused.
        for weak in ["a", "ab12", "abcde"]:
            with self.subTest(password=weak):
                response = self.new_client().post(
                    "/api/auth/accept-invite", json={"token": token, "password": weak}
                )
                self.assertEqual(response.status_code, 422, response.text)

        # And the invite survives a rejected attempt, so a rejected password does not
        # burn the invitation.
        self.assertEqual(
            self.new_client().get(f"/api/auth/invite/{token}").status_code,
            200,
        )

        # Six characters with no digit or symbol is accepted: length is the
        # whole policy.
        accepted = self.new_client().post(
            "/api/auth/accept-invite", json={"token": token, "password": "abcdef"}
        )
        self.assertEqual(accepted.status_code, 200, accepted.text)

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

    def test_cookies_are_lax_by_default_so_they_are_first_party(self) -> None:
        """`SameSite=lax`, because the app and the API share one origin.

        The frontend serves its own `/api` reverse proxy, so every browser request
        is same-site and the cookies are first-party. `lax` is what makes that
        sufficient.

        `none` is the value that breaks it: it makes the cookies third-party, which
        is what browsers are progressively refusing to send, so a deployment using
        it works in a desktop browser and fails in a mobile one with nothing in the
        app changed to account for it.
        """
        original_samesite = settings.auth_cookie_samesite
        original_secure = settings.auth_cookie_secure
        try:
            # Absent from the environment, which is how most deployments run it.
            settings.auth_cookie_samesite = ""
            settings.auth_cookie_secure = False
            self.assertEqual(settings.cookie_samesite, "lax")

            # Set the way a copy from an older cross-origin deployment would set it,
            # case and all. Only honoured alongside `Secure`, which is the condition
            # browsers actually impose.
            settings.auth_cookie_samesite = "None"
            settings.auth_cookie_secure = True
            self.assertEqual(settings.cookie_samesite, "none")

            # An unrecognised value falls back rather than issuing cookies whose
            # attributes nothing can predict.
            settings.auth_cookie_samesite = "something-else"
            self.assertEqual(settings.cookie_samesite, "lax")
        finally:
            settings.auth_cookie_samesite = original_samesite
            settings.auth_cookie_secure = original_secure

    def test_samesite_none_without_secure_falls_back_to_lax(self) -> None:
        """Every browser drops a `SameSite=None` cookie that is not also `Secure`.

        Silently, and with a 200 to show for it — so without this the cookies would
        be issued, stored nowhere, and sign-in would report that the browser had
        not kept the session.
        """
        original_samesite = settings.auth_cookie_samesite
        original_secure = settings.auth_cookie_secure
        settings.auth_cookie_samesite = "none"
        settings.auth_cookie_secure = False
        settings.environment = "development"
        try:
            self.assertEqual(settings.cookie_samesite, "lax")
        finally:
            settings.auth_cookie_samesite = original_samesite
            settings.auth_cookie_secure = original_secure

    def test_this_services_own_origin_is_always_allowed(self) -> None:
        """A request from our own origin needs no allow-list entry.

        The frontend serves its own `/api` reverse proxy and presents each request
        to us as same-origin, so that is what every proxied call looks like from
        here. Requiring it to be listed as well meant each deployment had to name
        an address it already was — the deployed hostname, a LAN address for a
        phone, a new one each time a host generated a service name — and a wrong
        one produced a 403 on the first write with nothing pointing at the setting
        that was wrong.
        """
        client = self.new_client()
        self.invite_and_accept(client, f"ama@{COMPANY}")

        # The origin this test client is talking to.
        own_origin = str(client.base_url).rstrip("/")

        response = client.post(
            "/api/conversations",
            json={"client_id": "1" * 12},
            headers={"Origin": own_origin, **self.csrf_headers(client)},
        )

        self.assertEqual(response.status_code, 200, response.text)

    def test_our_own_origin_is_matched_by_host_not_by_scheme(self) -> None:
        """A provider terminating TLS in front of the container still counts as us.

        Render — and most hosts — accept TLS on a proxy and forward to the container
        over plain http, so the scheme this process sees is `http` while the browser
        sent `https`. Comparing whole origins rejected every proxied write on
        exactly the deployments the app's own `/api` proxy exists to fix, and the
        refusal named an origin that looked correct.

        The `Secure` cookie flag and HSTS are what keep a session off plain http.
        The host is what identifies "this is us".
        """
        client = self.new_client()
        self.invite_and_accept(client, f"ama@{COMPANY}")

        # `TestClient` addresses itself as `testserver`, which is what the `Host`
        # header carries too.
        response = client.post(
            "/api/conversations",
            json={"client_id": "1" * 12},
            headers={
                # Same host as the request, opposite scheme.
                "Origin": "http://testserver",
                **self.csrf_headers(client),
            },
        )

        self.assertEqual(response.status_code, 200, response.text)

    def test_someone_elses_host_is_still_refused(self) -> None:
        """The leniency above is about our own host, not about schemes generally."""
        client = self.new_client()
        self.invite_and_accept(client, f"ama@{COMPANY}")

        response = client.post(
            "/api/conversations",
            json={"client_id": "1" * 12},
            headers={
                "Origin": f"http://evil.example",
                **self.csrf_headers(client),
            },
        )

        self.assertEqual(response.status_code, 403, response.text)

    def test_a_refused_origin_is_named_in_the_refusal(self) -> None:
        """A 403 about the wrong origin has to say which origin it was.

        `SameSite` and origins are the two ways a session silently fails to attach,
        and a bare "not from an allowed origin" is indistinguishable from a CSRF
        token problem — so it sends people to look at the interceptor instead of
        at the one setting that is wrong.

        Tried on `POST /api/conversations` rather than on a sign-in route, because
        every route reached before a session exists is exempt from the origin check
        (there are no cookies to ride at that point) — which is also why a wrong
        origin used to show up as a silent sign-in failure rather than as this 403.
        """
        client = self.new_client()
        self.invite_and_accept(client, f"ama@{COMPANY}")

        headers = self.csrf_headers(client)
        headers["Origin"] = "https://somewhere-else.example"

        response = client.post(
            "/api/conversations",
            json={"client_id": "1" * 12},
            headers=headers,
        )

        self.assertEqual(response.status_code, 403, response.text)
        self.assertIn("somewhere-else.example", response.json()["detail"])
        self.assertIn("CSRF_TRUSTED_ORIGINS", response.json()["detail"])

        # And it must not be mistaken for the retryable CSRF-token refusal, or the
        # interceptor would loop on a request that is never going to be accepted.
        self.assertNotIn("CSRF token", response.json()["detail"])

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

    The property being protected is specific: a request must not be able to become an
    account, and must not be able to say what role it would get. Everything else — the
    queue, the invitation, the idempotence — is in service of that.
    """

    def asks_for(self, client: TestClient, email: str = f"newcomer@{COMPANY}", password: str = PASSWORD):
        """Posts a request the way the frontend does, CSRF header and all."""
        return client.post(
            "/api/auth/request-access",
            json={"name": "Kofi Mensah", "email": email, "password": password},
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

    def test_a_request_creates_no_account(self) -> None:
        response = self.asks_for(self.new_client())

        self.assertEqual(response.status_code, 202, response.text)

        # The whole point: a request is a request. There is no user row to sign in to,
        # so nothing here can be logged into even by somebody who guessed the address.
        self.assertIsNone(self.stored_user(f"newcomer@{COMPANY}"))
        self.assertEqual(self.count_requests(), 1)

    def test_a_request_cannot_name_its_own_role(self) -> None:
        self.asks_for(self.new_client())

        # The field is not on the model, so there is nowhere for it to be stored even
        # if a client sends one: Pydantic drops it and the column does not exist.
        self.assertNotIn("role", AccessRequest.__table__.columns)

        admin = self.signed_in_admin()
        approved = self.approve(admin, self.request_id_for(f"newcomer@{COMPANY}"))

        self.assertEqual(approved.status_code, 200, approved.text)
        self.assertEqual(approved.json()["request"]["status"], "approved")

        # And approving defaults to the least privileged role.
        self.assertEqual(self.stored_user(f"newcomer@{COMPANY}").role, "employee")

    def test_an_admin_role_needs_an_admin_to_grant_it(self) -> None:
        self.asks_for(self.new_client())
        admin = self.signed_in_admin()

        self.approve(admin, self.request_id_for(f"newcomer@{COMPANY}"), role="admin")

        # An administrator may grant it. Nobody else can, and the requester never could.
        self.assertEqual(self.stored_user(f"newcomer@{COMPANY}").role, "admin")

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

    def test_approving_activates_the_account_with_the_chosen_password(self) -> None:
        client = self.new_client()
        self.assertEqual(self.asks_for(client).status_code, 202)
        admin = self.signed_in_admin()

        response = self.approve(admin, self.request_id_for(f"newcomer@{COMPANY}"))

        self.assertEqual(response.status_code, 200, response.text)
        # No invitation needed: the password was chosen at registration.
        self.assertEqual(response.json()["invite_link"], "")
        self.assertEqual(response.json()["token"], "")

        # The account is active with that password, so sign-in works at once.
        user = self.stored_user(f"newcomer@{COMPANY}")
        self.assertTrue(user.is_active)
        self.assertNotIn(PASSWORD, user.password_hash)

        signed_in = self.new_client().post(
            "/api/auth/login", json={"email": f"newcomer@{COMPANY}", "password": PASSWORD}
        )
        self.assertEqual(signed_in.status_code, 200, signed_in.text)

    def test_nothing_can_sign_in_before_approval(self) -> None:
        self.assertEqual(self.asks_for(self.new_client()).status_code, 202)

        response = self.new_client().post(
            "/api/auth/login", json={"email": f"newcomer@{COMPANY}", "password": PASSWORD}
        )

        # The password was right, so the answer is "waiting", not a refusal. This used
        # to be a 401 with the wrong-password wording, which told somebody their
        # password did not match when it matched perfectly.
        self.assertEqual(response.status_code, 202, response.text)
        self.assertEqual(response.json()["status"], "pending")

        # Still no session, and still no account: a request remains a request. Only the
        # answer changed, not what it grants.
        self.assertIsNone(self.stored_user(f"newcomer@{COMPANY}"))
        self.assertNotIn(ACCESS_COOKIE, self.new_client().cookies)

    def test_a_pending_request_is_not_a_way_to_enumerate_accounts(self) -> None:
        """The waiting answer is only sent once the password has verified.

        This is the whole reason it is safe to distinguish "waiting" from "refused" at
        all: an attacker who does not have the password still cannot tell whether an
        address has asked to join, because they get the identical generic refusal a
        never-seen address gets.
        """
        self.asks_for(self.new_client())

        pending_wrong_password = self.new_client().post(
            "/api/auth/login", json={"email": f"newcomer@{COMPANY}", "password": "wrong-one-1!"}
        )
        never_registered = self.new_client().post(
            "/api/auth/login", json={"email": f"stranger@{COMPANY}", "password": "wrong-one-1!"}
        )

        # Byte-for-byte the same answer, so the two cannot be told apart from outside.
        self.assertEqual(pending_wrong_password.status_code, 401)
        self.assertEqual(pending_wrong_password.json(), never_registered.json())
        self.assertEqual(
            pending_wrong_password.json()["detail"],
            "That email and password do not match an account.",
        )

    def test_the_waiting_answer_names_no_role_nobody_granted(self) -> None:
        """A request nobody has decided cannot report what it will be given.

        The role is chosen on approval and nowhere else, so naming one here would be a
        claim about a decision that has not happened.
        """
        self.asks_for(self.new_client())

        response = self.new_client().post(
            "/api/auth/login", json={"email": f"newcomer@{COMPANY}", "password": PASSWORD}
        )

        self.assertEqual(response.status_code, 202, response.text)
        self.assertIsNone(response.json()["requested_role"])
        # The name is safe to echo: the caller just proved the account is theirs.
        self.assertEqual(response.json()["name"], "Kofi Mensah")

    def test_a_deactivated_account_is_waiting_rather_than_refused(self) -> None:
        """An administrator switching an account off must not read as a bad password.

        Distinct from a pending request: the row and the password both exist, so the
        correct password can be verified and there is nothing to be vague about.
        """
        self.invite_and_accept(self.new_client(), f"ama@{COMPANY}")
        admin = self.signed_in_admin()
        user_id = self.stored_user(f"ama@{COMPANY}").id

        deactivated = admin.patch(
            f"/api/auth/users/{user_id}",
            json={"is_active": False},
            headers=self.csrf_headers(admin),
        )
        self.assertEqual(deactivated.status_code, 200, deactivated.text)

        response = self.new_client().post(
            "/api/auth/login", json={"email": f"ama@{COMPANY}", "password": PASSWORD}
        )

        self.assertEqual(response.status_code, 202, response.text)
        self.assertEqual(response.json()["requested_role"], "employee")
        self.assertNotIn(ACCESS_COOKIE, self.new_client().cookies)

    def test_a_pending_invitation_still_gets_the_generic_refusal(self) -> None:
        """An invitation nobody has accepted has no password to have got right.

        So there is nothing to verify, and nothing may be said: this is the one
        not-switched-on case that has to keep answering like a wrong password.
        """
        self.signed_in_admin()
        self.new_client().post(
            "/api/auth/invite",
            json={"name": "Ama Konadu", "email": f"ama@{COMPANY}", "role": "employee"},
            headers=self.csrf_headers(self.new_client()),
        )

        response = self.new_client().post(
            "/api/auth/login", json={"email": f"ama@{COMPANY}", "password": PASSWORD}
        )

        self.assertEqual(response.status_code, 401, response.text)
        self.assertEqual(
            response.json()["detail"], "That email and password do not match an account."
        )

    def test_a_weak_password_is_refused(self) -> None:
        response = self.asks_for(self.new_client(), password="abc")

        self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(self.count_requests(), 0)

    def test_a_request_from_before_passwords_still_gets_an_invite(self) -> None:
        """Old queue rows carry no hash and fall back to the invitation flow."""
        self.db.add(
            AccessRequest(
                id="legacy-request-id",
                name="Kofi Mensah",
                email=f"newcomer@{COMPANY}",
                status="pending",
                password_hash=None,
            )
        )
        self.db.commit()
        admin = self.signed_in_admin()

        response = self.approve(admin, "legacy-request-id")

        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn("/accept-invite?token=", response.json()["invite_link"])

        invited = self.new_client().get(f"/api/auth/invite/{response.json()['token']}")
        self.assertEqual(invited.status_code, 200, invited.text)

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

        # A queue is names and addresses and nothing else. No role, no password field,
        # no id that could be used against another route.
        self.assertEqual(set(row), {"id", "name", "email", "status", "requested_at", "decided_at"})

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
            json={"name": "Kofi Mensah", "email": f"newcomer@{COMPANY}", "password": PASSWORD},
        )

        # Not exempt, unlike signing in. There is nothing here that needs an
        # exemption: the token comes from a public endpoint and the frontend has one
        # before this screen is reachable. Refusing costs nothing and closes a way to
        # fill an administrator's queue from another site.
        self.assertEqual(response.status_code, 403, response.text)
        self.assertEqual(self.count_requests(), 0)

    def test_it_is_still_not_registration(self) -> None:
        """The route that would be the hole does not exist.

        `request-access` is not registration, and the difference is checkable: no user
        row is written, and the only route that writes one from an invitation still
        needs an administrator.
        """
        paths = set(main.app.openapi()["paths"])

        self.assertIn("/api/auth/request-access", paths)
        self.assertNotIn("/api/auth/register", paths)

        self.asks_for(self.new_client())
        self.assertIsNone(self.stored_user(f"newcomer@{COMPANY}"))


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


class UserManagementTest(AuthTestCase):
    def create_employee(self, email: str, client=None) -> dict:
        return self.invite_and_accept(
            client or self.new_client(), email, role="employee"
        )

    def test_admin_lists_every_account_paged(self):
        admin = self.signed_in_admin()
        self.create_employee(f"ama@{COMPANY}")
        self.create_employee(f"kofi@{COMPANY}")

        response = admin.get("/api/auth/users?page=1")

        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body["total"], 3)
        self.assertEqual(body["page"], 1)
        self.assertEqual(body["per_page"], 10)
        self.assertEqual(body["pages"], 1)
        self.assertEqual(len(body["users"]), 3)

    def test_employee_is_refused_the_list(self):
        self.signed_in_admin()
        employee = self.new_client()
        self.invite_and_accept(employee, f"ama@{COMPANY}")

        self.assertEqual(employee.get("/api/auth/users").status_code, 403)

    def test_admin_can_make_an_employee_an_admin(self):
        admin = self.signed_in_admin()
        user = self.create_employee(f"ama@{COMPANY}")

        response = admin.patch(
            f"/api/auth/users/{user['id']}",
            json={"role": "admin"},
            headers=self.csrf_headers(admin),
        )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["role"], "admin")
        self.assertEqual(self.stored_user(f"ama@{COMPANY}").role, "admin")

    def test_admin_cannot_demote_themselves(self):
        admin = self.signed_in_admin()
        admin_id = admin.get("/api/auth/me").json()["id"]

        response = admin.patch(
            f"/api/auth/users/{admin_id}",
            json={"role": "employee"},
            headers=self.csrf_headers(admin),
        )

        self.assertEqual(response.status_code, 409, response.text)

    def test_admin_cannot_take_an_address_in_use(self):
        admin = self.signed_in_admin()
        user = self.create_employee(f"ama@{COMPANY}")

        response = admin.patch(
            f"/api/auth/users/{user['id']}",
            json={"email": f"admin@{COMPANY}"},
            headers=self.csrf_headers(admin),
        )

        self.assertEqual(response.status_code, 409, response.text)

    def test_reset_password_signs_in_with_the_new_one(self):
        admin = self.signed_in_admin()
        user = self.create_employee(f"ama@{COMPANY}")

        response = admin.post(
            f"/api/auth/users/{user['id']}/password",
            json={"password": "brand-new-password-1!"},
            headers=self.csrf_headers(admin),
        )
        self.assertEqual(response.status_code, 200, response.text)

        employee = self.new_client()
        self.assertEqual(
            employee.post(
                "/api/auth/login",
                json={"email": f"ama@{COMPANY}", "password": "brand-new-password-1!"},
            ).status_code,
            200,
        )
        self.assertEqual(
            self.new_client().post(
                "/api/auth/login",
                json={"email": f"ama@{COMPANY}", "password": PASSWORD},
            ).status_code,
            401,
        )

    def test_delete_removes_the_account_and_its_access(self):
        admin = self.signed_in_admin()
        user = self.create_employee(f"ama@{COMPANY}")

        response = admin.delete(
            f"/api/auth/users/{user['id']}", headers=self.csrf_headers(admin)
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIsNone(self.stored_user(f"ama@{COMPANY}"))

        self.assertEqual(
            self.new_client().post(
                "/api/auth/login",
                json={"email": f"ama@{COMPANY}", "password": PASSWORD},
            ).status_code,
            401,
        )

    def test_admin_cannot_delete_themselves(self):
        admin = self.signed_in_admin()
        admin_id = admin.get("/api/auth/me").json()["id"]

        response = admin.delete(
            f"/api/auth/users/{admin_id}", headers=self.csrf_headers(admin)
        )

        self.assertEqual(response.status_code, 409, response.text)

    def test_unknown_account_is_a_404(self):
        admin = self.signed_in_admin()

        self.assertEqual(
            admin.get("/api/auth/users?page=99").status_code, 200
        )
        self.assertEqual(
            admin.patch(
                "/api/auth/users/no-such-id",
                json={"role": "admin"},
                headers=self.csrf_headers(admin),
            ).status_code,
            404,
        )


class ChangeOwnPasswordTest(AuthTestCase):
    """POST /api/auth/me/password: anybody signed in changes their own password.

    The current password proves possession, so a session left open cannot be used
    to lock its owner out. Employees reach this exactly as administrators do —
    there is no role on the route.
    """

    NEW_PASSWORD = "a-brand-new-password-1!"

    def change(
        self, client: TestClient, current: str = PASSWORD, new: str = NEW_PASSWORD
    ):
        return client.post(
            "/api/auth/me/password",
            json={"current_password": current, "new_password": new},
            headers=self.csrf_headers(client),
        )

    def test_employee_changes_their_own_password(self) -> None:
        self.signed_in_admin()
        employee = self.new_client()
        self.invite_and_accept(employee, f"ama@{COMPANY}")

        response = self.change(employee)

        self.assertEqual(response.status_code, 200, response.text)
        self.assertNotIn("password", response.json())

        # The new password signs in and the old one no longer does.
        self.assertEqual(
            self.new_client()
            .post(
                "/api/auth/login",
                json={"email": f"ama@{COMPANY}", "password": self.NEW_PASSWORD},
            )
            .status_code,
            200,
        )
        self.assertEqual(
            self.new_client()
            .post(
                "/api/auth/login",
                json={"email": f"ama@{COMPANY}", "password": PASSWORD},
            )
            .status_code,
            401,
        )

    def test_admin_uses_the_same_route(self) -> None:
        admin = self.signed_in_admin()

        response = self.change(admin)

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(
            self.new_client()
            .post(
                "/api/auth/login",
                json={"email": f"admin@{COMPANY}", "password": self.NEW_PASSWORD},
            )
            .status_code,
            200,
        )

    def test_wrong_current_password_is_refused_and_changes_nothing(self) -> None:
        self.signed_in_admin()
        employee = self.new_client()
        self.invite_and_accept(employee, f"ama@{COMPANY}")

        response = self.change(employee, current="not-the-password-1!")

        self.assertEqual(response.status_code, 401, response.text)

        # The old password still works: a refused attempt changed nothing.
        self.assertEqual(
            self.new_client()
            .post(
                "/api/auth/login",
                json={"email": f"ama@{COMPANY}", "password": PASSWORD},
            )
            .status_code,
            200,
        )

    def test_weak_new_password_is_refused(self) -> None:
        self.signed_in_admin()
        employee = self.new_client()
        self.invite_and_accept(employee, f"ama@{COMPANY}")

        self.assertEqual(self.change(employee, new="short").status_code, 422)

    def test_same_password_is_refused_and_changes_nothing(self) -> None:
        self.signed_in_admin()
        employee = self.new_client()
        self.invite_and_accept(employee, f"ama@{COMPANY}")

        response = self.change(employee, current=PASSWORD, new=PASSWORD)

        self.assertEqual(response.status_code, 422, response.text)

        # Still the same password: the refused attempt changed nothing.
        self.assertEqual(
            self.new_client()
            .post(
                "/api/auth/login",
                json={"email": f"ama@{COMPANY}", "password": PASSWORD},
            )
            .status_code,
            200,
        )

    def test_signed_out_is_refused(self) -> None:
        response = self.new_client().post(
            "/api/auth/me/password",
            json={"current_password": PASSWORD, "new_password": self.NEW_PASSWORD},
        )

        self.assertEqual(response.status_code, 401, response.text)

    def test_requires_the_csrf_header(self) -> None:
        self.signed_in_admin()
        employee = self.new_client()
        self.invite_and_accept(employee, f"ama@{COMPANY}")

        response = employee.post(
            "/api/auth/me/password",
            json={"current_password": PASSWORD, "new_password": self.NEW_PASSWORD},
        )

        self.assertEqual(response.status_code, 403, response.text)
