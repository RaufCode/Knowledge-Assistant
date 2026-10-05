import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';

import { ConversationService } from '../../../../core/services/conversation.service';
import { AuthServiceStub, provideAuthStub } from '../../../../core/testing/auth-service.stub';
import { ChatSidebarComponent } from './chat-sidebar.component';

describe('ChatSidebarComponent', () => {
  let fixture: ComponentFixture<ChatSidebarComponent>;
  let auth: AuthServiceStub;

  const element = (): HTMLElement => fixture.nativeElement as HTMLElement;

  /**
   * Renders, optionally after navigating.
   *
   * The path is optional on purpose: navigating unconditionally would move an
   * administrator out of the section a test just put them in, and the section is
   * exactly what most of these tests are about.
   */
  const render = async (path?: string): Promise<void> => {
    if (path !== undefined) {
      await TestBed.inject(Router).navigateByUrl(path);
    }

    fixture.detectChanges();
    await fixture.whenStable();
  };

  /**
   * The href of an administration link, by its visible label.
   *
   * Null when there is no such link, which is how "an employee sees none of them"
   * is asserted: absent rather than merely disabled.
   */
  const adminLink = (label: string): string | null =>
    Array.from(element().querySelectorAll('nav[aria-label="Administration"] a'))
      .find((link) => link.textContent?.trim() === label)
      ?.getAttribute('href') ?? null;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ChatSidebarComponent],
      // The sidebar reaches the conversation services, which reach `HttpClient`.
      // Without a backend behind it they fail to construct, and the failure lands
      // whenever the injection error surfaces rather than where it is caused.
      providers: [
        // Signing out navigates, so `/login` has to be routable. The real route
        // lazy-loads the sign-in view, which is not what this test is about. The
        // admin routes are here too because the sidebar decides which navigation to
        // show from the path it is on.
        provideRouter([
          { path: 'login', children: [] },
          { path: '', children: [] },
          { path: 'ask', children: [] },
          { path: 'response', children: [] },
          { path: 'admin', children: [] },
          { path: 'admin/documents', children: [] },
          { path: 'admin/users', children: [] },
          { path: 'admin/access', children: [] },
        ]),
        provideHttpClient(),
        provideHttpClientTesting(),
        // The role comes from the backend now, so a test supplies it rather than
        // flipping a switch inside the app.
        provideAuthStub(),
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(ChatSidebarComponent);
    auth = TestBed.inject(AuthServiceStub);
  });

  it('hides the whole administration section from an employee', async () => {
    auth.setRole('employee');
    await render('/admin');

    // The section is the whole visible difference between the two roles, so it must
    // not be present rather than merely disabled. An employee sees a sidebar that
    // is identical to any other employee's, with no greyed-out rows explaining why.
    expect(element().querySelector('nav[aria-label="Administration"]')).toBeNull();
  });

  it('puts the switch above the account row, not inside the account card', async () => {
    auth.setRole('admin');
    await render('/admin');

    // Switching between running the knowledge base and using it happens as often as
    // signing in, so it is a row of its own rather than something behind a profile
    // menu. It sits directly above the account, on the other side of the rule.
    //
    // `/ask` rather than `/`: the app's front door turns an administrator away to
    // the dashboard, so a link to the assistant pointing there would bounce them
    // straight back. `/ask` is the route that reaches it.
    const ask = Array.from(element().querySelectorAll('a')).find(
      (link) => link.textContent?.trim() === 'Ask',
    ) as HTMLAnchorElement;

    expect(ask?.getAttribute('href')).toBe('/ask');

    const switchRow = ask?.closest('div');
    const accountRow = element().querySelector('button[aria-label="Account menu"]');

    expect(switchRow?.compareDocumentPosition(accountRow as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );

    // And the account card is for the account: opening it must not also offer it.
    (accountRow as HTMLButtonElement).click();
    await render();

    // Scoped to the account card. A bare `[role="menuitem"]` across the whole
    // component also matches the dialogs, which carry the same roles and have their
    // own items in them.
    const card = element().querySelector('[role="menu"]') as HTMLElement;
    const labels = Array.from(card.querySelectorAll('[role="menuitem"]')).map((item) =>
      item.textContent?.trim(),
    );

    // Changing your own password is offered from the account card, so it does not
    // require finding yourself in a list of other people first.
    expect(labels).toEqual(['Change password', 'Sign out']);
  });

  it('offers the way back while in the assistant, from the same row', async () => {
    auth.setRole('admin');
    await render('/');

    // One control that changes with the section rather than both being present: an
    // administrator reading an answer wants the dashboard, and one already on the
    // dashboard wants the assistant.
    const back = Array.from(element().querySelectorAll('a')).find(
      (link) => link.textContent?.trim() === 'View as admin',
    ) as HTMLAnchorElement;

    expect(back?.getAttribute('href')).toBe('/admin');
    expect(Array.from(element().querySelectorAll('a')).some((a) => a.textContent?.trim() === 'Ask'))
      .toBe(false);
  });

  it('offers an employee no switch at all, because there is only one section', async () => {
    auth.setRole('employee');
    await render('/');

    const labels = Array.from(element().querySelectorAll('a')).map((link) =>
      link.textContent?.trim(),
    );

    expect(labels).not.toContain('View as admin');
    expect(labels).not.toContain('Ask');
  });

  it('does not offer the assistant link to an employee, who is already on it', async () => {
    auth.setRole('employee');
    await render();

    // For an employee the whole sidebar is the assistant, so a link to it would be a
    // row that goes nowhere new. Checked across every link rather than inside the
    // admin nav, which would be null for this role regardless of where the row sits.
    const labels = Array.from(element().querySelectorAll('a')).map((link) =>
      link.textContent?.trim(),
    );

    expect(labels).not.toContain('Ask');
  });

  it('offers an administrator the four destinations, and nothing else', async () => {
    auth.setRole('admin');
    await render('/admin');

    expect(adminLink('Dashboard')).toBe('/admin');
    expect(adminLink('Documents')).toBe('/admin/documents');
    expect(adminLink('Users')).toBe('/admin/users');

    // Question logs and access requests still resolve, but neither is offered: the
    // sidebar is the only navigation there is, so a screen reachable only by typing
    // its URL is not part of the product.
    const labels = Array.from(
      element().querySelectorAll('nav[aria-label="Administration"] a'),
    ).map((link) => link.textContent?.trim());

    expect(labels).toEqual(['Dashboard', 'Documents', 'Users']);
  });

  it('names the person, because the name is what opens the account card', async () => {
    auth.setRole('admin');
    await render('/admin');

    // The name is the control rather than a caption: it carries the account's actions
    // behind it. An avatar alone would be a button whose effect cannot be guessed at.
    const trigger = element().querySelector('button[aria-label="Account menu"]');

    expect(trigger?.textContent).toContain('Ama Konadu');
    // The role is not spelled out anywhere on the sidebar: what somebody can reach is
    // already answered by which navigation they are being shown.
    expect(element().textContent).not.toContain('HR Administrator');
  });

  it('keeps the account card closed until the name is clicked', async () => {
    auth.setRole('admin');
    await render();

    expect(element().querySelector('[role="menu"]')).toBeNull();

    (element().querySelector('button[aria-label="Account menu"]') as HTMLButtonElement).click();
    await render();

    // Sign-out is the only irreversible thing in here, so it must not be a row that
    // merely exists on the page waiting to be hit.
    const card = element().querySelector('[role="menu"]');
    expect(card?.textContent).toContain('Sign out');
    expect(card?.textContent).toContain('Ama Konadu');
    expect(card?.textContent).toContain('ama.konadu@acmetech.example');
  });

  it('keeps Users lit up on the access queue, which belongs to it', async () => {
    // The queue is reached from the users screen and lives at its own address, so
    // prefix matching on `/admin/users` alone left the section looking unselected
    // while the page on screen was the queue of people waiting to join it.
    auth.setRole('admin');
    await render('/admin/access');

    const sidebar = fixture.componentInstance as unknown as {
      adminNav: { label: string }[];
      isNavItemActive: (item: unknown) => boolean;
    };
    const users = sidebar.adminNav.find((item) => item.label === 'Users') as unknown;
    const dashboard = sidebar.adminNav.find((item) => item.label === 'Dashboard') as unknown;

    expect(sidebar.isNavItemActive(users)).toBe(true);
    // And nothing else alongside it: two lit items would say two places at once.
    expect(sidebar.isNavItemActive(dashboard)).toBe(false);
  });

  it('does not light the overview for every administration page', async () => {
    // `/admin` was exact before, and must stay exact: otherwise three items are lit
    // at once and the highlight stops saying where you are.
    auth.setRole('admin');
    await render('/admin/documents');

    // Asked of the component rather than read back off the anchors. The decision is
    // what is being tested, and reading classes back out of the DOM would also be
    // asserting that Angular had flushed a change-detection pass, which is a
    // different thing and not this test's business.
    const sidebar = fixture.componentInstance as unknown as {
      adminNav: { label: string }[];
      isNavItemActive: (item: unknown) => boolean;
    };
    const isActive = (label: string): boolean =>
      sidebar.isNavItemActive(
        sidebar.adminNav.find((item) => item.label === label) as unknown,
      );

    expect(isActive('Dashboard')).toBe(false);
    expect(isActive('Documents')).toBe(true);
    expect(isActive('Users')).toBe(false);
  });

  it('highlights the conversation that is open, and only that one', async () => {
    // The highlight and the destination of a new question come from the same value.
    // They used to be computed differently — the row from the route, the question
    // from the open conversation — which is how a row could be lit for a conversation
    // nothing was being added to.
    auth.setRole('admin');
    await render();

    const conversations = TestBed.inject(ConversationService);
    const sidebar = fixture.componentInstance as unknown as {
      isActive: (id: string) => boolean;
    };

    conversations.openConversation('c2');
    fixture.detectChanges();
    await fixture.whenStable();

    expect(sidebar.isActive('c2')).toBe(true);
    expect(sidebar.isActive('c1')).toBe(false);

    // Nothing open, so nothing lit. A blank window says so when it is built, rather
    // than the sidebar hiding a disagreement it did not cause.
    conversations.startUnsaved();
    fixture.detectChanges();

    expect(sidebar.isActive('c2')).toBe(false);
  });

  it('closes the account card when the page outside it is clicked', async () => {
    auth.setRole('admin');
    await render();

    (element().querySelector('button[aria-label="Account menu"]') as HTMLButtonElement).click();
    await render();
    expect(element().querySelector('[role="menu"]')).not.toBeNull();

    // A real click on the document, from outside the sidebar entirely. The catcher
    // listens on the document rather than on an overlay element, because an overlay
    // inside the sidebar is clipped to the sidebar and cannot reach the chat area.
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await render();

    expect(element().querySelector('[role="menu"]')).toBeNull();
  });

  it('keeps the account card open when the click is inside it', async () => {
    auth.setRole('admin');
    await render();

    (element().querySelector('button[aria-label="Account menu"]') as HTMLButtonElement).click();
    await render();

    const card = element().querySelector('[role="menu"]') as HTMLElement;
    card.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await render();

    expect(element().querySelector('[role="menu"]')).not.toBeNull();
  });

  it('closes the account card on Escape, which works from anywhere on the page', async () => {
    auth.setRole('admin');
    await render();

    (element().querySelector('button[aria-label="Account menu"]') as HTMLButtonElement).click();
    await render();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await render();

    expect(element().querySelector('[role="menu"]')).toBeNull();
  });

  it('asks for confirmation before signing out, then returns to the sign-in screen', async () => {
    await render();

    (element().querySelector('button[aria-label="Account menu"]') as HTMLButtonElement).click();
    await render();

    const signOut = Array.from(
      element().querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    ).find((button) => button.textContent?.trim() === 'Sign out') as HTMLButtonElement;

    signOut.click();
    await render();

    const dialog = element().querySelector('app-confirm-dialog');
    expect(dialog?.textContent).toContain('Sign out?');

    const confirm = Array.from(dialog?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(
      (button) => button.textContent?.trim() === 'Sign out',
    ) as HTMLButtonElement;
    confirm.click();
    // Not `render()`: it navigates to `/` itself, which would paper over where signing
    // out actually sent the person.
    fixture.detectChanges();
    await fixture.whenStable();

    expect(TestBed.inject(Router).url).toBe('/login');
  });
});
