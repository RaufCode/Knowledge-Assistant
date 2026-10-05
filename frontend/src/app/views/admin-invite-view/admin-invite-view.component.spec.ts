import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { API_BASE_URL } from '../../core/api.config';
import { MIN_PASSWORD_LENGTH } from '../../core/models/auth.model';
import { AuthService } from '../../core/services/auth.service';
import { AdminInviteViewComponent } from './admin-invite-view.component';

const ACCOUNTS_URL = `${API_BASE_URL}/api/auth/accounts`;
const DOMAIN = 'acmetech.example';

/** Long enough to satisfy the policy, since that is what the field enforces. */
const PASSWORD = 'correct-horse-1!';

describe('AdminInviteViewComponent', () => {
  let fixture: ComponentFixture<AdminInviteViewComponent>;
  let http: HttpTestingController;

  const element = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const fields = (): HTMLInputElement[] =>
    Array.from(element().querySelectorAll<HTMLInputElement>('app-form-field input'));

  const render = async (): Promise<void> => {
    fixture.detectChanges();
    await fixture.whenStable();
  };

  const type = (index: number, value: string): void => {
    fields()[index].value = value;
    fields()[index].dispatchEvent(new Event('input'));
    fixture.detectChanges();
  };

  const submit = async (): Promise<void> => {
    (element().querySelector('form') as HTMLFormElement).dispatchEvent(
      new Event('submit', { cancelable: true }),
    );
    await render();
  };

  /** The button whose label is exactly this. */
  const button = (label: string): HTMLButtonElement =>
    Array.from(element().querySelectorAll<HTMLButtonElement>('button')).find(
      (candidate) => candidate.textContent?.trim() === label,
    ) as HTMLButtonElement;

  /** Fills the form with a valid person and sends it. */
  const fillAndSubmit = async (
    name = 'Ama Konadu',
    email = `ama@${DOMAIN}`,
    password = PASSWORD,
  ): Promise<void> => {
    type(0, name);
    type(1, email);
    type(2, password);
    await submit();
  };

  /** Signs in, because this screen only makes sense for an administrator. */
  const signedInAs = async (role: 'employee' | 'admin'): Promise<void> => {
    const bootstrap = TestBed.inject(AuthService).bootstrap();

    http.expectOne(`${API_BASE_URL}/api/auth/me`).flush({
      id: 'u1',
      name: 'Kwame Osei',
      email: `kwame@${DOMAIN}`,
      role,
    });
    await bootstrap;
    await new Promise((resolve) => setTimeout(resolve, 0));

    http.expectOne(`${API_BASE_URL}/api/auth/csrf`).flush({ csrf_token: 'token' });
    fixture.detectChanges();
  };

  /** What the backend answers a created account with. */
  const CREATED = {
    user: { id: 'u2', name: 'Ama Konadu', email: `ama@${DOMAIN}`, role: 'employee' },
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AdminInviteViewComponent],
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();

    fixture = TestBed.createComponent(AdminInviteViewComponent);
    http = TestBed.inject(HttpTestingController);
  });

  describe('as an administrator', () => {
    beforeEach(async () => {
      await signedInAs('admin');
    });

    it('asks for a name, an address, a password and a role', async () => {
      await render();

      // The password is part of what makes this flow work: there is no mail service
      // to deliver an invitation with, so the account is created outright and the
      // credentials are handed over.
      expect(fields().length).toBe(3);
      expect(element().textContent).toContain('Employee');
      expect(element().textContent).toContain('Administrator');

      // Described, not just named: handing out an administrator is a large thing and
      // the screen should say what it is.
      expect(element().textContent).toContain('Can also add people');
    });

    it('defaults to the least privileged role', async () => {
      await fillAndSubmit();

      const request = http.expectOne(ACCOUNTS_URL);

      expect(request.request.body).toEqual({
        name: 'Ama Konadu',
        email: `ama@${DOMAIN}`,
        role: 'employee',
        password: PASSWORD,
      });

      request.flush(CREATED);
    });

    it('grants the administrator role only when that option is chosen', async () => {
      type(0, 'Kofi Mensah');
      type(1, `kofi@${DOMAIN}`);
      type(2, PASSWORD);

      const adminOption = Array.from(
        element().querySelectorAll<HTMLInputElement>('input[type="radio"]'),
      ).find((radio) => radio.value === 'admin') as HTMLInputElement;

      adminOption.click();
      await render();
      await submit();

      const request = http.expectOne(ACCOUNTS_URL);

      expect((request.request.body as { role: string }).role).toBe('admin');
      request.flush(CREATED);
    });

    it('refuses an address outside the company before making a round trip', async () => {
      await fillAndSubmit('Ama Konadu', 'ama@gmail.com');

      expect(element().textContent).toContain(`Use their @${DOMAIN} work email`);
      http.expectNone(ACCOUNTS_URL);
    });

    it('refuses a password the backend would refuse, before making a round trip', async () => {
      await fillAndSubmit('Ama Konadu', `ama@${DOMAIN}`, 'short');

      // The server runs the same rule and is the authority, but somebody choosing a
      // password for another person should not have to make a round trip to be told.
      expect(element().textContent).toContain(`at least ${MIN_PASSWORD_LENGTH} characters`);
      http.expectNone(ACCOUNTS_URL);
    });

    it('names every missing field on the first attempt', async () => {
      await submit();

      expect(element().textContent).toContain('Enter their full name');
      expect(element().textContent).toContain('Enter their work email');
      expect(element().textContent).toContain('Choose a password for them');
      http.expectNone(ACCOUNTS_URL);
    });

    it('shows the credentials to hand over, because they are the deliverable', async () => {
      await fillAndSubmit();

      http.expectOne(ACCOUNTS_URL).flush(CREATED);
      await render();

      expect(element().textContent).toContain(`ama@${DOMAIN}`);
      expect(element().textContent).toContain(PASSWORD);
      // And says this is the only time, so it is not mistaken for a receipt that can
      // be fetched later. The backend keeps a hash, so it genuinely is the only time.
      expect(element().textContent).toContain('the only time the password is shown');
    });

    it('offers a copy button, which is the whole handover', async () => {
      await fillAndSubmit();

      http.expectOne(ACCOUNTS_URL).flush(CREATED);
      await render();

      expect(button('Copy both')).toBeTruthy();

      // And says so when the clipboard write was refused, rather than leaving the
      // administrator believing they captured something they did not.
      button('Copy both').click();
      await render();

      // jsdom has no clipboard, so the write fails. The point is that this is visible.
      expect(element().textContent).toContain('Could not copy automatically');
    });

    it('forgets the last password when starting on somebody else', async () => {
      await fillAndSubmit();
      http.expectOne(ACCOUNTS_URL).flush(CREATED);
      await render();
      expect(element().textContent).toContain(PASSWORD);

      button('Add someone else').click();
      await render();

      // Otherwise the first person's password sits in a tab being read over a
      // shoulder while the second one is being typed.
      expect(element().textContent).not.toContain(PASSWORD);
      expect(fields()[0].value).toBe('');
    });

    it("passes the backend's refusal through, because the reason is useful", async () => {
      await fillAndSubmit();

      http
        .expectOne(ACCOUNTS_URL)
        .flush(
          { detail: 'That address already has an active account.' },
          { status: 409, statusText: 'Conflict' },
        );
      await render();

      // Usually that somebody was already created here, which is worth more than a
      // generic failure.
      expect(element().textContent).toContain('already has an active account');
      expect(element().textContent).not.toContain(PASSWORD);
    });

    it('clears the previous credentials when a new attempt starts', async () => {
      await fillAndSubmit();
      http.expectOne(ACCOUNTS_URL).flush(CREATED);
      await render();
      expect(element().textContent).toContain(PASSWORD);

      // Otherwise the administrator could hand the first person's credentials to the
      // second person.
      type(0, 'Kofi Mensah');
      type(2, 'another-passphrase-1!');
      await submit();

      expect(element().textContent).not.toContain(PASSWORD);
      http.expectOne(ACCOUNTS_URL).flush({
        user: { id: 'u3', name: 'Kofi Mensah', email: `kofi@${DOMAIN}`, role: 'employee' },
      });
    });
  });

  describe('as an employee', () => {
    beforeEach(async () => {
      await signedInAs('employee');
    });

    it('explains itself instead of offering the form', async () => {
      await render();

      expect(element().querySelector('app-admin-access-required')).toBeTruthy();
      expect(element().textContent).not.toContain('Create account');

      // And nothing was asked of the backend.
      http.expectNone(ACCOUNTS_URL);
    });
  });
});