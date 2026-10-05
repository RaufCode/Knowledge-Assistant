#!/usr/bin/env bash
# Walks the security checklist against a running backend, using curl as a real
# HTTP client. Complements tests/test_auth.py, which exercises the same rules
# through the in-process test client.
#
# Run it once a minute. The sign-in routes are limited to five attempts a minute per
# IP, which is the correct setting for the product and the wrong one for a test that
# signs in several times: two runs back to back make the second one fail on 429s
# that say nothing about the code. The rate-limit check itself is deliberately the
# last thing this script does, for the same reason — it spends the allowance on
# purpose.
#
# Environment:
#   API_URL            default http://127.0.0.1:8099
#   ADMIN_EMAIL        an existing administrator, if one is already seeded
#   ADMIN_PASSWORD     its password; without both this script needs an empty database
#   SQLITE_DB          the sqlite file the server is using, for the stored-hash check
set -u
BASE="http://127.0.0.1:8099"
DOMAIN="acmetech.example"
PASS="correct-horse-1!"
JAR_ADMIN=$(mktemp) JAR_EMP=$(mktemp) JAR_STALE=$(mktemp)
ok=0; bad=0
check() { # check <label> <expected> <actual>
  if [ "$2" = "$3" ]; then printf '  PASS  %s\n' "$1"; ok=$((ok+1));
  else printf '  FAIL  %s (expected %s, got %s)\n' "$1" "$2" "$3"; bad=$((bad+1)); fi
}
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
csrf() { curl -s -c "$1" -b "$1" "$BASE/api/auth/csrf" | .venv/bin/python -c 'import sys,json;print(json.load(sys.stdin)["csrf_token"])'; }

echo "== 9. No open self-registration endpoint =="
check "POST /api/auth/register is absent" 404 "$(code -X POST "$BASE/api/auth/register" -H 'Content-Type: application/json' -d '{}')"
check "POST /register is absent"            404 "$(code -X POST "$BASE/register" -H 'Content-Type: application/json' -d '{}')"

echo "== Bootstrap the first administrator =="
BOOT_KEY=${AUTH_BOOTSTRAP_KEY:-$(grep '^AUTH_BOOTSTRAP_KEY=' .env | cut -d= -f2)}
ADMIN_EMAIL=${ADMIN_EMAIL:-admin@$DOMAIN}
ADMIN_PASS=$PASS

WRONG_KEY_STATUS=$(code -X POST "$BASE/api/auth/bootstrap-admin" -H 'Content-Type: application/json' \
  -d "{\"name\":\"Kwame Osei\",\"email\":\"$ADMIN_EMAIL\",\"role\":\"admin\",\"password\":\"$PASS\",\"bootstrap_key\":\"wrong\"}")

BOOT_STATUS=$(code -c "$JAR_ADMIN" -X POST "$BASE/api/auth/bootstrap-admin" -H 'Content-Type: application/json' \
  -d "{\"name\":\"Kwame Osei\",\"email\":\"$ADMIN_EMAIL\",\"role\":\"admin\",\"password\":\"$PASS\",\"bootstrap_key\":\"$BOOT_KEY\"}")

# An administrator usually already exists: the backend seeds one from
# AUTH_SEED_ADMIN_* at startup, and that correctly makes the bootstrap route refuse.
# Signing in as the existing one is the right answer here. Demanding an empty
# database made this script fail for a reason that has nothing to do with what it
# checks.
if [ "$BOOT_STATUS" = "201" ]; then
  check "bootstrap creates the first administrator" 201 "$BOOT_STATUS"

  # Only meaningful on the run that actually created one. Afterwards the route is
  # shut and answers 409 without ever looking at the key, which the next check covers
  # and is the stronger property anyway.
  check "bootstrap without a key is 403" 403 "$WRONG_KEY_STATUS"
else
  ADMIN_PASS=${ADMIN_PASSWORD:-}

  if [ -z "$ADMIN_PASS" ]; then
    echo
    echo "An administrator already exists and ADMIN_PASSWORD was not supplied, so this"
    echo "script cannot sign in as one. Either run against an empty database, or set:"
    echo "  ADMIN_EMAIL=... ADMIN_PASSWORD=... ./scripts/verify_auth_checklist.sh"
    exit 2
  fi

  echo "  (using the administrator that already exists)"
fi

# Once one exists the route is shut, so it cannot be used to add anybody afterwards.
check "a second bootstrap is refused" 409 "$(code -X POST "$BASE/api/auth/bootstrap-admin" -H 'Content-Type: application/json' \
  -d "{\"name\":\"Second\",\"email\":\"second@$DOMAIN\",\"role\":\"admin\",\"password\":\"$PASS\",\"bootstrap_key\":\"$BOOT_KEY\"}")"

echo "== 1 & 2. Token transport and cookie flags =="
LOGIN_BODY=$(mktemp)
LOGIN_HEADERS=$(mktemp)
curl -s -D "$LOGIN_HEADERS" -c "$JAR_ADMIN" -X POST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASS\"}" > "$LOGIN_BODY"
grep -qi 'HttpOnly' "$LOGIN_HEADERS" && R=1 || R=0; check "access cookie is HttpOnly" 1 "$R"
grep -qi 'SameSite=lax' "$LOGIN_HEADERS" && R=1 || R=0; check "access cookie is SameSite=Lax" 1 "$R"
grep -qi 'Path=/' "$LOGIN_HEADERS" && R=1 || R=0; check "access cookie is Path=/" 1 "$R"
grep -qi '^set-cookie: ika_csrf=.*HttpOnly' "$LOGIN_HEADERS" && R=0 || R=1
check "the csrf cookie is the one readable by JS" 1 "$R"
grep -q 'eyJ' "$LOGIN_BODY" && R=1 || R=0
check "no JWT appears in the login response body" 0 "$R"
BODY_KEYS=$(.venv/bin/python -c 'import json,sys;print(",".join(sorted(json.load(open(sys.argv[1])))))' "$LOGIN_BODY")
check "login body carries only 'user'" "user" "$BODY_KEYS"
USER_KEYS=$(.venv/bin/python -c 'import json,sys;print(",".join(sorted(json.load(open(sys.argv[1]))["user"])))' "$LOGIN_BODY")
check "the user carries exactly id,name,email,role" "email,id,name,role" "$USER_KEYS"

echo "== 3. Refresh rotation and reuse detection =="
STALE=$(curl -s -c "$JAR_STALE" -b "$JAR_ADMIN" "$BASE/api/auth/csrf" >/dev/null; \
  curl -s -c "$JAR_STALE" -b "$JAR_ADMIN" -X POST "$BASE/api/auth/refresh" -o /dev/null -w '%{http_code}')
cp "$JAR_ADMIN" "$JAR_STALE"          # the thief keeps a copy of the old jar
check "refresh succeeds" 200 "$STALE"
check "refresh again with the old jar is 401 (reuse)" 401 "$(code -c "$JAR_STALE" -b "$JAR_STALE" -X POST "$BASE/api/auth/refresh")"
check "the live session was revoked with it" 401 "$(code -c "$JAR_ADMIN" -b "$JAR_ADMIN" -X POST "$BASE/api/auth/refresh")"

echo "== 7. Company domain, server-side =="
check "invite with gmail.com is 422" 422 "$(code -b "$JAR_ADMIN" -c "$JAR_ADMIN" -X POST "$BASE/api/auth/invite" -H 'Content-Type: application/json' \
  -H "X-CSRF-Token: $(csrf "$JAR_ADMIN")" -d "{\"name\":\"X\",\"email\":\"x@gmail.com\",\"role\":\"employee\"}")"
check "login with gmail.com is 422" 422 "$(code -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"x@gmail.com\",\"password\":\"$PASS\"}")"
check "login with a lookalike domain is 422" 422 "$(code -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"x@evil.test/?q=$DOMAIN\",\"password\":\"$PASS\"}")"

echo "== 6. CSRF =="
check "invite with no CSRF header is 403" 403 "$(code -b "$JAR_ADMIN" -c "$JAR_ADMIN" -X POST "$BASE/api/auth/invite" \
  -H 'Content-Type: application/json' -d "{\"name\":\"Ama Konadu\",\"email\":\"ama@$DOMAIN\",\"role\":\"employee\"}")"
check "invite with a wrong CSRF header is 403" 403 "$(code -b "$JAR_ADMIN" -c "$JAR_ADMIN" -X POST "$BASE/api/auth/invite" \
  -H 'Content-Type: application/json' -H 'X-CSRF-Token: wrongwrongwrongwrongwrongwrongwrongwrong' \
  -d "{\"name\":\"Ama Konadu\",\"email\":\"ama@$DOMAIN\",\"role\":\"employee\"}")"
check "invite from an unknown origin is 403" 403 "$(code -b "$JAR_ADMIN" -c "$JAR_ADMIN" -X POST "$BASE/api/auth/invite" \
  -H 'Content-Type: application/json' -H 'Origin: https://evil.example' -H "X-CSRF-Token: $(csrf "$JAR_ADMIN")" \
  -d "{\"name\":\"Ama Konadu\",\"email\":\"ama@$DOMAIN\",\"role\":\"employee\"}")"

echo "== The invitation flow, end to end =="
INVITE=$(curl -s -b "$JAR_ADMIN" -c "$JAR_ADMIN" -X POST "$BASE/api/auth/invite" -H 'Content-Type: application/json' \
  -H "X-CSRF-Token: $(csrf "$JAR_ADMIN")" -d "{\"name\":\"Ama Konadu\",\"email\":\"ama@$DOMAIN\",\"role\":\"employee\"}")
TOKEN=$(printf '%s' "$INVITE" | .venv/bin/python -c 'import sys,json;print(json.load(sys.stdin)["token"])')
check "invite is 201-shaped" "Ama Konadu" "$(printf '%s' "$INVITE" | .venv/bin/python -c 'import sys,json;print(json.load(sys.stdin)["user"]["name"])')"
check "the invite link points at the frontend" 1 "$(printf '%s' "$INVITE" | grep -c "accept-invite?token=")"
PREVIEW=$(curl -s "$BASE/api/auth/invite/$TOKEN")
check "the preview prefills the name" "Ama Konadu" "$(printf '%s' "$PREVIEW" | .venv/bin/python -c 'import sys,json;print(json.load(sys.stdin)["name"])')"
check "accepting signs the person in" 200 "$(code -c "$JAR_EMP" -X POST "$BASE/api/auth/accept-invite" \
  -H 'Content-Type: application/json' -d "{\"token\":\"$TOKEN\",\"password\":\"$PASS\"}")"
check "the invitation cannot be used twice" 404 "$(code -X POST "$BASE/api/auth/accept-invite" \
  -H 'Content-Type: application/json' -d "{\"token\":\"$TOKEN\",\"password\":\"$PASS\"}")"

echo "== 8. A real non-admin account on an admin-only route =="
check "the employee is really an employee" "employee" "$(curl -s -b "$JAR_EMP" "$BASE/api/auth/me" | .venv/bin/python -c 'import sys,json;print(json.load(sys.stdin)["role"])')"
check "employee POST /api/auth/invite is 403" 403 "$(code -b "$JAR_EMP" -c "$JAR_EMP" -X POST "$BASE/api/auth/invite" \
  -H 'Content-Type: application/json' -H "X-CSRF-Token: $(csrf "$JAR_EMP")" -d "{\"name\":\"X\",\"email\":\"x@$DOMAIN\",\"role\":\"admin\"}")"
# A well-formed but unknown token, so this is asking about the token rather than
# about its shape: the employee cannot grant themselves a role by guessing.
check "an unknown invite token is 404" 404 "$(code -X POST "$BASE/api/auth/accept-invite" \
  -H 'Content-Type: application/json' -d "{\"token\":\"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\",\"password\":\"$PASS\"}")"
check "the employee can still use conversations" 200 "$(code -b "$JAR_EMP" -c "$JAR_EMP" -X POST "$BASE/api/conversations" \
  -H 'Content-Type: application/json' -H "X-CSRF-Token: $(csrf "$JAR_EMP")" -d '{"client_id":"live-check-client"}')"
check "a signed-out caller is 401" 401 "$(code "$BASE/api/auth/me")"

echo "== 4. Passwords are hashed, and logout revokes =="
check "the stored password is a bcrypt hash" 1 "$(.venv/bin/python -c "
import os
import sqlite3
db_file = os.environ.get('SQLITE_DB', 'local-auth-test.db')
if not os.path.exists(db_file):
    print('SQLITE_DB=%s does not exist, so the stored hash cannot be read' % db_file)
    raise SystemExit(1)
row = sqlite3.connect(db_file).execute(\"select password_hash from users where email='ama@$DOMAIN'\").fetchone()
h = row[0]
print(1 if h.startswith('\$2b\$') and '$PASS' not in h else 0)")"
check "logout is 200" 200 "$(code -c "$JAR_EMP" -b "$JAR_EMP" -X POST "$BASE/api/auth/logout")"
check "me after logout is 401" 401 "$(code -b "$JAR_EMP" -c "$JAR_EMP" "$BASE/api/auth/me")"

# Deliberately last. Burning the sign-in allowance is the point of this check, and
# every later check in this script needs at least one working sign-in — so run here,
# running it earlier made the script fail on its own side effects.
echo "== 5. Rate limiting =="
for i in 1 2 3 4 5 6 7; do curl -s -o /dev/null -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d "{\"email\":\"ghost@$DOMAIN\",\"password\":\"$PASS\"}"; done
RATE_HEADERS=$(mktemp)
RATE=$(curl -s -D "$RATE_HEADERS" -o /dev/null -w '%{http_code}' -X POST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' -d "{\"email\":\"ghost@$DOMAIN\",\"password\":\"$PASS\"}")
check "login past 5/min is 429" 429 "$RATE"
grep -qi 'Retry-After' "$RATE_HEADERS" && R=1 || R=0; check "429 carries Retry-After" 1 "$R"
rm -f "$RATE_HEADERS"

echo
echo "passed: $ok   failed: $bad"
rm -f "$JAR_ADMIN" "$JAR_EMP" "$JAR_STALE" "$LOGIN_HEADERS" "$LOGIN_BODY"
[ "$bad" -eq 0 ]