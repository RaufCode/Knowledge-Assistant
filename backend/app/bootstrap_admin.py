"""Creates the first administrator, from a shell.

    python -m app.bootstrap_admin --email you@acmetech.example --name "Your Name"

The password is read from stdin without an echo, so it is not left in shell
history or in a process listing, and it goes through the same policy check as one
set through the invitation flow.

This is the better way to do this job wherever a shell is reachable:
`POST /api/auth/bootstrap-admin` exists for the deployments where one is not, and
both refuse to do anything once an administrator exists.
"""

import argparse
import getpass
import sys
from uuid import uuid4

from app.config import settings
from app.database import SessionLocal, User, init_db
from app.schemas_auth import MIN_PASSWORD_LENGTH, check_password_policy
from app.security import has_company_domain, hash_password, normalize_email, sanitize_text


def create_first_admin(email: str, name: str, password: str) -> User:
    """Creates the administrator, or refuses to.

    The refusal matters more than the creation: this command is how the first
    administrator is made, so anything loose about it would be a way to add
    accounts for good.
    """
    if not settings.auth_is_usable:
        raise SystemExit(
            "AUTH_SECRET_KEY is unset or shorter than 32 characters. "
            'Generate one with: python -c "import secrets; print(secrets.token_urlsafe(48))"'
        )

    email = normalize_email(email)
    name = sanitize_text(name)

    if not has_company_domain(email):
        raise SystemExit(f"That address is not a company address (@{settings.email_domain}).")

    if not name:
        raise SystemExit("A name is required.")

    try:
        password = check_password_policy(password)
    except ValueError as rejected:
        raise SystemExit(str(rejected))

    init_db()
    db = SessionLocal()
    try:
        existing = db.query(User).filter(User.role == "admin").count()

        if existing:
            raise SystemExit(
                "An administrator already exists. Add people with the invitation flow "
                "rather than by creating accounts here."
            )

        if db.query(User).filter(User.email == email).first() is not None:
            raise SystemExit(
                f"{email} already has an account. Invite them to reset their password instead."
            )

        user = User(
            id=uuid4().hex,
            email=email,
            name=name,
            role="admin",
            password_hash=hash_password(password),
            is_active=True,
        )
        db.add(user)
        db.commit()
        db.refresh(user)

        return user
    finally:
        db.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="Create the first administrator account.")
    parser.add_argument("--email", required=True, help="Company email address.")
    parser.add_argument("--name", required=True, help="Name shown in the app.")
    arguments = parser.parse_args()

    # `getpass` rather than an argument, so the password never appears in shell
    # history or in `ps` output for another user on the machine.
    password = getpass.getpass(f"Password (at least {MIN_PASSWORD_LENGTH} characters): ")
    confirmation = getpass.getpass("Again: ")

    if password != confirmation:
        raise SystemExit("The two passwords did not match.")

    user = create_first_admin(arguments.email, arguments.name, password)
    print(f"Created administrator {user.email}. Sign in at the app's sign-in screen.")

    return 0


if __name__ == "__main__":
    sys.exit(main())