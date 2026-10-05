import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';

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
          { path: 'admin', children: [] },
          { path: 'admin/documents', children: [] },
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
    const ask = Array.from(element().querySelectorAll('a')).find(
      (link) => link.textContent?.trim() === 'Ask',
    ) as HTMLAnchorElement;

    expect(ask?.getAttribute('href')).toBe('/');

    const switchRow = ask?.closest('div');
    const accountRow = element().querySelector('button[aria-label="Account menu"]');

    expect(switchRow?.compareDocumentPosition(accountRow as Node)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );

    // And the account card is for the account: opening it must not also offer it.
    (accountRow as HTMLButtonElement).click();
    await render();

    const labels = Array.from(element().querySelectorAll('[role="menuitem"]')).map((item) =>
      item.textContent?.trim(),
    );

    expect(labels).toEqual(['Sign out']);
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

  it('offers an administrator the three destinations, and nothing else', async () => {
    auth.setRole('admin');
    await render('/admin');

    expect(adminLink('Dashboard')).toBe('/admin');
    expect(adminLink('Documents')).toBe('/admin/documents');
    expect(adminLink('Add a user')).toBe('/admin/invite');

    // Question logs and access requests still resolve, but neither is offered: the
    // sidebar is the only navigation there is, so a screen reachable only by typing
    // its URL is not part of the product.
    const labels = Array.from(
      element().querySelectorAll('nav[aria-label="Administration"] a'),
    ).map((link) => link.textContent?.trim());

    expect(labels).toEqual(['Dashboard', 'Documents', 'Add a user']);
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

  it('closes the account card when the page outside it is clicked', async () => {
    auth.setRole('admin');
    await render();

    (element().querySelector('button[aria-label="Account menu"]') as HTMLButtonElement).click();
    await render();
    expect(element().querySelector('[role="menu"]')).not.toBeNull();

    // The overlay rather than a document listener, so the click that opened the card
    // cannot also be the one that closes it.
    (element().querySelector('button[aria-hidden="true"]') as HTMLButtonElement).click();
    await render();

    expect(element().querySelector('[role="menu"]')).toBeNull();
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
