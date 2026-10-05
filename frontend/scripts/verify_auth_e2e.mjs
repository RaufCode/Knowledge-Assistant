/**
 * Drives the real sign-in and invitation flows in a real browser, against the real
 * backend, and checks the security properties that only hold end to end.
 *
 * The unit suites cover each piece with mocked HTTP. This covers the parts that
 * only exist when a browser, a cross-origin request and a server are all involved:
 * whether cookies are actually stored, whether the CSRF header reaches the server,
 * whether the guards redirect, and whether anything token-shaped is left where
 * JavaScript could read it.
 *
 * Run with the frontend on :4201 and the backend on :8099:
 *   node scripts/verify_auth_e2e.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import puppeteer from 'puppeteer-core';

const APP = process.env.APP_URL ?? 'http://127.0.0.1:4201';
const API = process.env.API_URL ?? 'http://127.0.0.1:8099';
const DOMAIN = 'acmetech.example';
const PASSWORD = 'correct-horse-1!';

// A fresh address each run. The bootstrap above forces an empty database, but this
// keeps the employee account from colliding with one an earlier run left behind if
// the database is restored rather than recreated.
const EMPLOYEE = `ama.${Date.now().toString(36)}@${DOMAIN}`;

let passed = 0;
let failed = 0;

const check = (label, actual, expected) => {
  const same = JSON.stringify(actual) === JSON.stringify(expected);

  if (same) {
    console.log(`  PASS  ${label}`);
    passed += 1;
  } else {
    console.log(
      `  FAIL  ${label}\n          expected ${JSON.stringify(expected)}\n          got      ${JSON.stringify(actual)}`,
    );
    failed += 1;
  }
};

const truthy = (label, value) => check(label, Boolean(value), true);
const falsy = (label, value) => check(label, Boolean(value), false);

/** A backend call from Node, for the parts only an administrator can do. */
const api = async (path, { method = 'GET', body, cookies, headers = {} } = {}) => {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });

  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    setCookie: response.headers.getSetCookie?.() ?? [],
    body: await response.text(),
  };
};

/**
 * One cookie's value out of a `Cookie` request header.
 *
 * Split on `;` by hand rather than with `URLSearchParams`, which splits on `&` and
 * would quietly return nothing for every cookie in the jar.
 */
const cookieFrom = (header, name) =>
  header
    .split(';')
    .map((pair) => pair.trim())
    .find((pair) => pair.startsWith(`${name}=`))
    ?.slice(name.length + 1);

/** Everything a browser could read: its own storage and its readable cookies. */
const readableState = (page) =>
  page.evaluate(() => ({
    localStorage: { ...localStorage },
    sessionStorage: { ...sessionStorage },
    documentCookie: document.cookie,
  }));

/** A token, by shape, anywhere in a blob of text. */
const looksLikeAJwt = (text) => /eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\./.test(text);

/** The value of a cookie by name, from the browser's own jar. */
const cookieValue = async (page, name) =>
  page.cookies().then((all) => all.find((cookie) => cookie.name === name)?.value);

/**
 * Waits for the app to settle on a URL.
 *
 * Reports what the screen said and what the API returned when it never gets there.
 * Without that, every failure in this script looks identical, and the interesting
 * ones (a refused password, a spent rate limit) are only visible in what the page
 * said about itself.
 */
const waitForUrl = async (page, fragment, timeout = 20000) => {
  try {
    await page.waitForFunction(
      (wanted) => window.location.pathname === wanted,
      { timeout },
      fragment,
    );
  } catch {
    const calls = apiCalls;
    const text = await page.evaluate(() => document.body.innerText);

    console.error(`\n  Did not reach ${fragment}. Now at ${page.url()}`);
    console.error(`  API calls: ${JSON.stringify(calls, null, 2)}`);
    console.error(
      `  On screen: ${JSON.stringify(text.split('\n').filter(Boolean).slice(-8), null, 2)}`,
    );
    throw new Error(`expected to end up at ${fragment}`);
  }
};

/** Every API call the page made, in order, with its status. */
const apiCalls = [];

/**
 * Replaces a field's contents.
 *
 * Selected-then-typed would be shorter, but a triple click does not reliably select
 * inside a password field, and a field that quietly appends produces a password
 * nobody typed — which looks exactly like a backend refusing a good one.
 */
const fill = async (page, index, value) => {
  const field = (await page.$$('app-form-field input'))[index];

  await field.click();
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyA');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  await field.type(value);

  // Read back rather than assuming: everything after this point is built on the
  // field holding what was asked for.
  const written = await page.evaluate((node) => node.value, field);

  if (written !== value) {
    throw new Error(
      `field ${index} holds ${JSON.stringify(written)}, expected ${JSON.stringify(value)}`,
    );
  }
};

const clickButton = async (page, label) => {
  for (const button of await page.$$('button')) {
    const text = await page.evaluate((node) => node.textContent?.trim(), button);

    if (text === label) {
      await button.click();
      return true;
    }
  }

  return false;
};

const main = async () => {
  // A fresh profile each run: a leftover cookie from an earlier run would make the
  // "signed out" checks pass for the wrong reason.
  const profile = mkdtempSync(join(tmpdir(), 'ika-e2e-'));
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome',
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    userDataDir: profile,
  });

  try {
    // ---------------------------------------------------------------- accounts --
    console.log('== Setting up two accounts through the real API ==');

    const bootstrapKey = process.env.AUTH_BOOTSTRAP_KEY ?? '';

    check('a bootstrap key is available to run this against', bootstrapKey.length > 0, true);

    const bootstrapped = await api('/api/auth/bootstrap-admin', {
      method: 'POST',
      body: {
        name: 'Kwame Osei',
        email: `admin@${DOMAIN}`,
        role: 'admin',
        password: PASSWORD,
        bootstrap_key: bootstrapKey,
      },
    });

    if (bootstrapped.status === 409) {
      // An administrator already exists — usually because the backend was started
      // with AUTH_SEED_ADMIN_* set, which seeds one at startup and makes the
      // bootstrap route correctly refuse. Signing in as that one is the right answer
      // rather than insisting on an empty database.
      const seededEmail = process.env.ADMIN_EMAIL;
      const seededPassword = process.env.ADMIN_PASSWORD;

      if (!seededEmail || !seededPassword) {
        console.error(
          '\nAn administrator already exists in the target database.\n' +
            'Either start the backend against an empty database, or point this script at\n' +
            'the existing administrator:\n' +
            '  ADMIN_EMAIL=... ADMIN_PASSWORD=... node scripts/verify_auth_e2e.mjs\n',
        );
        process.exit(2);
      }

      console.log('  (using the administrator that already exists)');
    } else {
      check('the first administrator is created', bootstrapped.status, 201);
    }

    const adminAddress = process.env.ADMIN_EMAIL ?? `admin@${DOMAIN}`;
    const adminSecret = process.env.ADMIN_PASSWORD ?? PASSWORD;

    // Sign in over HTTP to get an admin session the browser can be given later.
    const adminLogin = await api('/api/auth/login', {
      method: 'POST',
      body: { email: adminAddress, password: adminSecret },
    });

    check('the administrator can sign in', adminLogin.status, 200);
    // The `Set-Cookie` values, reduced to the `name=value` pairs a request header
    // carries. Read from this response rather than from a browser, because this is
    // the one place an administrator's session is created without a UI to create it.
    // Signing in hands over the CSRF cookie along with the session, so the next call
    // already has everything it needs.
    let adminCookies = adminLogin.setCookie.map((line) => line.split(';')[0]).join('; ');

    truthy(
      'signing in hands over a CSRF cookie with the session',
      adminCookies.includes('ika_csrf'),
    );

    const csrfToken = decodeURIComponent(cookieFrom(adminCookies, 'ika_csrf') ?? '');

    const inviteEmployee = await api('/api/auth/invite', {
      method: 'POST',
      headers: { cookie: adminCookies, 'X-CSRF-Token': csrfToken },
      body: { name: 'Ama Konadu', email: EMPLOYEE, role: 'employee' },
    });
    check('the administrator can invite an employee', inviteEmployee.status, 201);

    if (inviteEmployee.status !== 201) {
      console.error('\nCould not create the invitation:', inviteEmployee.body);
      process.exit(3);
    }

    const inviteBody = JSON.parse(inviteEmployee.body);

    // The link's origin is a deployment setting, not part of what is being checked
    // here, so it is rewritten to wherever this frontend is actually being served.
    // Left alone, a link pointing at one host would be followed from another and
    // every cookie would be dropped as cross-site.
    const inviteLink = `${APP}/accept-invite?token=${inviteBody.token}`;

    truthy(
      'the invite link the administrator gets points at the accept screen with the token on it',
      inviteBody.invite_link.includes('token=') &&
        inviteBody.invite_link.includes('/accept-invite'),
    );

    // ------------------------------------------------------- signed-out state --
    console.log('== A signed-out visitor ==');

    // Checked at the HTTP layer, before any browser is involved. A route guard runs
    // in the browser, so by the time it has run the server has already answered —
    // which would mean the dashboard's markup was sent to somebody with no session.
    for (const path of ['/', '/admin', '/conversations', '/response/some-id']) {
      const response = await fetch(`${APP}${path}`, { redirect: 'manual' });

      check(`${path} is answered with a redirect, not with the page`, response.status, 302);
      truthy(
        `${path} redirects to the sign-in screen`,
        response.headers.get('location')?.startsWith('/login'),
      );
    }

    const signInPage = await fetch(`${APP}/login`, { redirect: 'manual' });
    check('the sign-in screen itself is served', signInPage.status, 200);
    truthy(
      'and it carries the product name',
      (await signInPage.text()).includes('Internal Knowledge'),
    );

    // The static middleware has to run before the redirect, or the sign-in screen
    // would arrive with no JavaScript at all — which looks exactly like a working
    // redirect on a broken page.
    const bundle = await fetch(`${APP}/favicon.ico`, { redirect: 'manual' });
    check('static assets are served, not redirected', bundle.status, 200);

    const page = await browser.newPage();

    // Wide enough that the sidebar is the expanded column rather than the icon rail.
    // At the default viewport the sign-out control is off-screen and clicking it
    // fails for reasons that have nothing to do with what is being tested.
    await page.setViewport({ width: 1400, height: 1000 });
    const consoleErrors = [];
    page.on('console', (message) => {
      if (message.type() === 'error') {
        consoleErrors.push(message.text());
      }
    });
    page.on('response', (response) => {
      if (response.url().includes('/api/')) {
        apiCalls.push({ status: response.status(), url: response.url().replace(API, '') });
      }
    });

    // Every conversation call the browser makes, so it can be shown that none happen
    // before somebody has signed in.
    const appRequests = [];
    page.on('response', (response) => {
      if (response.url().includes('/api/conversations')) {
        appRequests.push(`${response.status()} ${response.url()}`);
      }
    });

    // Records whether the sidebar was ever in the document, on every navigation, from
    // before the first byte of app code runs.
    //
    // A check taken after the load would miss the bug this is here for. The sidebar
    // appeared and then vanished, and it did so *during* the `/api/auth/me` round
    // trip that the app initializer makes before the router is allowed to navigate at
    // all — by the time any script runs, the evidence is gone. Watching the whole
    // tree from the first navigation is the only way to see it.
    await page.evaluateOnNewDocument(() => {
      window.__sidebarAppeared = false;
      new MutationObserver(() => {
        if (document.querySelector('#app-sidebar')) {
          window.__sidebarAppeared = true;
        }
      }).observe(document.documentElement, { childList: true, subtree: true });
    });

    await page.goto(`${APP}/`, { waitUntil: 'networkidle2' });
    await waitForUrl(page, '/login');

    check(
      'a signed-out visitor is sent to the sign-in screen',
      new URL(page.url()).pathname,
      '/login',
    );
    truthy('the reason they were sent is in the URL', page.url().includes('returnUrl'));
    falsy('the sidebar is not in the document', Boolean(await page.$('#app-sidebar')));

    // The one that matters: not merely absent at rest, but never present at any point
    // during the load.
    check(
      'the sidebar was never in the document, at any point during the load',
      await page.evaluate(() => window.__sidebarAppeared),
      false,
    );

    // Nothing asked the app for company data on the way there. The shell was never
    // rendered, so there was nothing to load and nothing that could have leaked.
    check('the app was never loaded to get there', appRequests, []);

    // And nobody's details were requested. The browser that just arrived has no
    // session at all, so asking who is signed in is asking about a stranger: it
    // cannot succeed, it cannot leak anything, and it puts a 401 in the console of
    // the screen least entitled to one. A brand new browser must make no such call
    // at all, which is why the count is zero rather than "one that was refused".
    const meCalls = apiCalls.filter((call) => call.url === '/api/auth/me');

    check('nobody was asked who is signed in, before signing in', meCalls.length, 0);
    check(
      'and the sign-in screen asked the API for nothing at all',
      apiCalls.map((call) => call.url),
      [],
    );

    // The readable hint is what makes that possible: no hint, no question. Asserted
    // so that a change which quietly reintroduces the round trip cannot pass.
    falsy(
      'a browser with no session carries no hint cookie',
      await page.evaluate(() => document.cookie.includes('ika_session=')),
    );

    // ------------------------------------------------- accepting an invitation --
    console.log('== Accepting an invitation ==');

    await page.goto(inviteLink, { waitUntil: 'networkidle2' });
    await page.waitForSelector('app-form-field input');

    const prefilled = await page.$$eval('app-form-field input', (nodes) =>
      nodes.slice(0, 2).map((node) => node.value),
    );
    check('the invitation pre-fills the name', prefilled[0], 'Ama Konadu');
    check('the invitation pre-fills the address', prefilled[1], EMPLOYEE);

    // A password the backend's policy refuses, to prove the form stops it first.
    await fill(page, 2, 'short');
    await fill(page, 3, 'short');
    await clickButton(page, 'Set password');
    await new Promise((resolve) => setTimeout(resolve, 400));
    truthy(
      'a weak password is refused before it is sent',
      (await page.content()).includes('satisfies every rule'),
    );

    await fill(page, 2, PASSWORD);
    await fill(page, 3, PASSWORD);
    await clickButton(page, 'Set password');

    // Reported rather than swallowed: a refusal here has a reason the screen states,
    // and knowing which one turns a confusing timeout into a readable failure.
    try {
      await waitForUrl(page, '/', 10000);
    } catch {
      throw new Error('accepting the invitation did not land in the app');
    }

    check('accepting signs the person straight in', new URL(page.url()).pathname, '/');

    // --------------------------------------------------- where the session is --
    console.log('== Where the session lives ==');

    const afterAccept = await readableState(page);

    falsy(
      'no access token in localStorage',
      looksLikeAJwt(JSON.stringify(afterAccept.localStorage)),
    );
    falsy(
      'no access token in sessionStorage',
      looksLikeAJwt(JSON.stringify(afterAccept.sessionStorage)),
    );
    falsy(
      'no access token in a cookie JavaScript can read',
      looksLikeAJwt(afterAccept.documentCookie),
    );
    falsy(
      'the remember-email key holds no token',
      JSON.stringify(afterAccept.localStorage).includes('eyJ'),
    );

    // The CSRF cookie is the one thing JavaScript is meant to be able to read.
    truthy(
      'the CSRF cookie is readable, which is the point of it',
      afterAccept.documentCookie.includes('ika_csrf'),
    );
    falsy('the CSRF cookie is not the session', afterAccept.documentCookie.includes('ika_access'));

    // The other half of the rule above. Skipping the question when there is plainly
    // no session must not turn into skipping it when there is one: with the hint
    // present the app asks, and the answer is what puts Ama Konadu in the sidebar.
    truthy(
      'signing in leaves the readable hint behind for the app to judge by',
      afterAccept.documentCookie.includes('ika_session'),
    );
    falsy(
      'the hint holds no token, only the fact that a session exists',
      looksLikeAJwt(afterAccept.documentCookie),
    );
    truthy(
      'and the app did ask who was signed in, having been told it might be worth asking',
      apiCalls.some((call) => call.url === '/api/auth/me' && call.status === 200),
    );

    const accessCookie = await cookieValue(page, 'ika_access');
    truthy('the browser really did store an access token', accessCookie);
    check(
      'the access cookie cannot be read from script',
      await page.evaluate(() => document.cookie.includes('ika_access')),
      false,
    );

    const cookies = await page.cookies();
    const access = cookies.find((cookie) => cookie.name === 'ika_access');
    const refresh = cookies.find((cookie) => cookie.name === 'ika_refresh');

    check('the access cookie is HttpOnly', access.httpOnly, true);
    check('the refresh cookie is HttpOnly', refresh.httpOnly, true);
    check('the access cookie is SameSite=Lax', access.sameSite, 'Lax');
    check('the refresh cookie is SameSite=Lax', refresh.sameSite, 'Lax');
    // Secure is off only because this local run is over plain http; production
    // forces it on, and the cookie here proves the flag is settable at all.
    check('the cookie is scoped to the whole site', access.path, '/');

    // ------------------------------------------------------- role-gated views --
    console.log('== An employee on an admin route ==');

    await page.goto(`${APP}/admin`, { waitUntil: 'networkidle2' });
    await new Promise((resolve) => setTimeout(resolve, 1200));

    check('an employee is kept off the admin screen', new URL(page.url()).pathname, '/');
    falsy(
      'no administration link in the sidebar',
      (await page.content()).includes('Administration'),
    );

    // ------------------------------------------------------------ signing out --
    console.log('== Signing out ==');

    await page.goto(`${APP}/`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('#app-sidebar');
    await page.click('button[aria-label="Sign out"]');
    await page.waitForSelector('app-confirm-dialog dialog[open]', { timeout: 5000 });
    await clickButton(page, 'Sign out');
    await waitForUrl(page, '/login');

    falsy('the access cookie is gone', Boolean(await cookieValue(page, 'ika_access')));

    // A signed-out browser cannot get back in by typing the address.
    await page.goto(`${APP}/`, { waitUntil: 'networkidle2' });
    await waitForUrl(page, '/login');
    check('a protected route is refused after signing out', new URL(page.url()).pathname, '/login');

    // The session is revoked server-side too, not merely forgotten by the browser.
    const replay = await api('/api/auth/refresh', {
      method: 'POST',
      headers: { cookie: `ika_refresh=${refresh.value}` },
    });
    check('the old refresh token is refused after signing out', replay.status, 401);

    // ------------------------------------------------------- signing back in --
    console.log('== Signing back in ==');

    await page.goto(`${APP}/login`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('app-form-field input');

    await fill(page, 0, EMPLOYEE);
    await fill(page, 1, 'not-the-password-1!');
    await clickButton(page, 'Sign in');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    truthy(
      'a wrong password is reported and does not sign anybody in',
      (await page.content()).includes('do not match an account'),
    );
    check('and the visitor stays on the sign-in screen', new URL(page.url()).pathname, '/login');

    await fill(page, 1, PASSWORD);
    await clickButton(page, 'Sign in');
    await waitForUrl(page, '/');

    check('the right password lands in the app', new URL(page.url()).pathname, '/');
    truthy('the sidebar shows the signed-in person', (await page.content()).includes('Ama Konadu'));

    // ---------------------------------------------------- an admin's own view --
    console.log('== An administrator ==');

    const adminPage = await browser.newPage();
    await adminPage.setViewport({ width: 1400, height: 1000 });
    const adminCookiesForPage = adminCookies
      .split(';')
      .map((pair) => pair.trim())
      .filter(Boolean)
      .map((pair) => {
        const [name, ...rest] = pair.split('=');

        return { name, value: decodeURIComponent(rest.join('=')), domain: '127.0.0.1', path: '/' };
      });

    await adminPage.setCookie(...adminCookiesForPage);

    await adminPage.goto(`${APP}/admin`, { waitUntil: 'networkidle2' });
    await new Promise((resolve) => setTimeout(resolve, 1500));

    check('an administrator reaches the admin screen', new URL(adminPage.url()).pathname, '/admin');
    truthy('and the sidebar offers it', (await adminPage.content()).includes('Administration'));

    // ------------------------------------------- asking, and answering, for access --
    console.log('== Asking for access, and answering the request ==');

    // Its own browser context, which matters: tabs in one browser share a cookie jar,
    // so a tab opened here would inherit the administrator's session and be bounced
    // off the signed-out screens by guestGuard.
    const newcomerContext = await browser.createBrowserContext();
    const newcomer = await newcomerContext.newPage();
    await newcomer.setViewport({ width: 1400, height: 1000 });

    // Recorded on this tab, not the shared one: the call being checked is the
    // newcomer's, and it is not made by the tab the rest of the script drives.
    const newcomerCalls = [];
    newcomer.on('response', (response) => {
      // Non-preflight only. A cross-origin POST carrying a custom header is preceded
      // by an OPTIONS probe, and that answers 200 — which is not what "the request
      // was accepted" means, so counting it would assert against the wrong number.
      if (
        response.url().includes('/api/auth/request-access') &&
        response.request().method() === 'POST'
      ) {
        newcomerCalls.push({ status: response.status(), url: response.url().replace(API, '') });
      }
    });
    await newcomer.evaluateOnNewDocument(() => {
      window.__sidebarAppeared = false;
      new MutationObserver(() => {
        if (document.querySelector('#app-sidebar')) {
          window.__sidebarAppeared = true;
        }
      }).observe(document.documentElement, { childList: true, subtree: true });
    });

    const newcomerFields = () => newcomer.$$('app-form-field input');

    const askForAccess = async (name, email) => {
      const inputs = await newcomerFields();

      for (const [index, value] of [name, email].entries()) {
        await inputs[index].click({ clickCount: 3 });
        await newcomer.keyboard.down('Control');
        await newcomer.keyboard.press('KeyA');
        await newcomer.keyboard.up('Control');
        await newcomer.keyboard.press('Backspace');
        await inputs[index].type(value);
      }

      for (const button of await newcomer.$$('button')) {
        if (
          (await newcomer.evaluate((node) => node.textContent?.trim(), button)) === 'Request access'
        ) {
          await button.click();
          return;
        }
      }
    };

    await newcomer.goto(`${APP}/register`, { waitUntil: 'networkidle2' });
    await newcomer.waitForSelector('app-form-field input');

    check(
      'the request screen never shows the sidebar',
      await newcomer.evaluate(() => window.__sidebarAppeared),
      false,
    );

    // A personal address is refused before the round trip, and never reaches the API.
    await askForAccess('Kofi Mensah', 'kofi@gmail.com');
    await new Promise((resolve) => setTimeout(resolve, 400));
    truthy(
      'an address outside the company is refused on the screen',
      (await newcomer.content()).includes(`@acmetech.example`),
    );

    await askForAccess('Kofi Mensah', `kofi.${Date.now().toString(36)}@acmetech.example`);
    await newcomer.waitForFunction(
      () => document.body.innerText.includes('an administrator will review'),
      { timeout: 15000 },
    );

    truthy(
      'asking says an administrator decides, not that the account now exists',
      (await newcomer.content()).includes('an administrator will review'),
    );
    falsy(
      'and nothing claims to have signed anybody in',
      (await newcomer.content()).includes('you are now signed in'),
    );

    // The whole security property: asking created no account. Read from the backend
    // directly rather than from the screen, because that is where it would show up.
    truthy('the request reached the backend', newcomerCalls.length > 0);
    check('and was accepted', newcomerCalls.at(-1)?.status, 202);

    // The administrator sees it, and can answer it.
    await adminPage.goto(`${APP}/admin/access`, { waitUntil: 'networkidle2' });
    await new Promise((resolve) => setTimeout(resolve, 1200));

    truthy(
      'the queue lists the person who asked',
      (await adminPage.content()).includes('Kofi Mensah'),
    );

    const adminButtons = await adminPage.$$('button');
    for (const button of adminButtons) {
      if ((await adminPage.evaluate((node) => node.textContent?.trim(), button)) === 'Approve') {
        await button.click();
        break;
      }
    }

    await adminPage.waitForFunction(() => document.body.innerText.includes('Send this link'), {
      timeout: 15000,
    });

    truthy(
      'approving hands back a link, because there is no mail service to send one with',
      (await adminPage.content()).includes('/accept-invite?token='),
    );
    truthy('and says it works once', (await adminPage.content()).includes('works once'));

    // Direct invitation, the other way in.
    await adminPage.goto(`${APP}/admin/invite`, { waitUntil: 'networkidle2' });
    await adminPage.waitForSelector('app-form-field input');

    truthy(
      'the invite screen offers the two roles',
      (await adminPage.content()).includes('Administrator'),
    );

    const inviteInputs = await adminPage.$$('app-form-field input');
    for (const [index, value] of [
      'Yaa Asantewaa',
      `yaa.${Date.now().toString(36)}@acmetech.example`,
    ].entries()) {
      await inviteInputs[index].click({ clickCount: 3 });
      await adminPage.keyboard.down('Control');
      await adminPage.keyboard.press('KeyA');
      await adminPage.keyboard.up('Control');
      await adminPage.keyboard.press('Backspace');
      await inviteInputs[index].type(value);
    }

    for (const button of await adminPage.$$('button')) {
      if (
        (await adminPage.evaluate((node) => node.textContent?.trim(), button)) ===
        'Generate invitation link'
      ) {
        await button.click();
        break;
      }
    }

    await adminPage.waitForFunction(() => document.body.innerText.includes('Link ready for'), {
      timeout: 15000,
    });

    truthy(
      'generating an invitation shows a usable link',
      (await adminPage.content()).includes('/accept-invite?token='),
    );
    truthy(
      'and a copy button, which is the delivery mechanism',
      (await adminPage.content()).includes('Copy link'),
    );

    await newcomerContext.close();

    // A refused request is logged by the browser itself, and this journey makes
    // several on purpose: the app initializer asking while nobody is signed in, and
    // the employee reaching for a screen they may not have. What is checked here is
    // the app's own reporting — anything that is not the browser noting a status.
    const appErrors = consoleErrors.filter(
      (line) =>
        !line.includes('favicon') &&
        !line.includes('Failed to load resource') &&
        !line.includes('status of 401') &&
        !line.includes('status of 403'),
    );
    check('the app itself reported no errors', appErrors, []);

    await adminPage.close();
  } finally {
    await browser.close();
    rmSync(profile, { recursive: true, force: true });
  }

  console.log(`\npassed: ${passed}   failed: ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
};

await main();
