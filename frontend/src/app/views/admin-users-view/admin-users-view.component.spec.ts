import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { API_BASE_URL } from '../../core/api.config';
import { AuthService } from '../../core/services/auth.service';
import { AdminUsersViewComponent } from './admin-users-view.component';

const USERS_URL = `${API_BASE_URL}/api/auth/users?page=1`;
const ACCOUNTS_URL = `${API_BASE_URL}/api/auth/accounts`;
const DOMAIN = 'acmetech.example';

/** Accounts, as the backend pages them. */
const USERS = [
  {
    id: 'u1',
    name: 'Ama Konadu',
    email: 'ama@acmetech.example',
    role: 'employee',
    is_active: true,
    created_at: '2026-10-01T09:00:00',
  },
];

const PAGE = {
  users: USERS,
  total: 1,
  page: 1,
  per_page: 10,
  pages: 1,
};

describe('AdminUsersViewComponent', () => {
  let fixture: ComponentFixture<AdminUsersViewComponent>;
  let http: HttpTestingController;

  const element = (): HTMLElement => fixture.nativeElement as HTMLElement;

  const render = async (): Promise<void> => {
    fixture.detectChanges();
    await fixture.whenStable();
  };

  /** The button whose label contains this text. */
  const button = (label: string): HTMLButtonElement =>
    Array.from(element().querySelectorAll<HTMLButtonElement>('button')).find(
      (candidate) => candidate.textContent?.trim().includes(label),
    ) as HTMLButtonElement;

  /** The input inside the field whose label starts with this text. */
  const createField = (label: string): HTMLInputElement => {
    const field = Array.from(
      element().querySelectorAll<HTMLElement>('app-form-field'),
    ).find((candidate) =>
      candidate.querySelector('label')?.textContent?.trim().startsWith(label),
    );

    return field?.querySelector('input') as HTMLInputElement;
  };

  /** Types into the add-user dialog the way the browser does. */
  const typeIntoCreateField = (label: string, value: string): void => {
    const input = createField(label);

    input.value = value;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  };

  const openCreateDialog = async (): Promise<void> => {
    button('Add a user').click();
    await render();
  };

  const submitNewUser = async (): Promise<void> => {
    button('Create account').click();
    await render();
  };

  const signedInAs = async (role: 'employee' | 'admin'): Promise<void> => {
    const bootstrap = TestBed.inject(AuthService).bootstrap();

    http.expectOne(`${API_BASE_URL}/api/auth/me`).flush({
      id: 'me',
      name: 'Kwame Osei',
      email: 'kwame@acmetech.example',
      role,
    });
    await bootstrap;
    await new Promise((resolve) => setTimeout(resolve, 0));

    http.expectOne(`${API_BASE_URL}/api/auth/csrf`).flush({ csrf_token: 'token' });
    fixture.detectChanges();
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AdminUsersViewComponent],
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();

    fixture = TestBed.createComponent(AdminUsersViewComponent);
    http = TestBed.inject(HttpTestingController);
  });

  describe('as an administrator', () => {
    beforeEach(async () => {
      await signedInAs('admin');
      http.expectOne(USERS_URL).flush(PAGE);
      await render();
    });

    it('reads people from the accounts endpoint', async () => {
      expect(element().textContent).toContain('ama@acmetech.example');
    });

    it('offers adding a user above the list, with no invite flow', async () => {
      expect(button('Add a user')).toBeTruthy();
      expect(element().textContent).not.toContain('Invite by link');
      expect(element().querySelector('a[href="/admin/access"]')).not.toBeNull();
    });

    it('changes a role with a PATCH carrying only the role', async () => {
      button('Role').click();
      await render();

      const save = button('Save role');
      save.click();

      const request = http.expectOne(`${API_BASE_URL}/api/auth/users/u1`);

      expect(request.request.method).toBe('PATCH');
      expect(request.request.body).toEqual({ role: 'employee' });
      request.flush({ ...USERS[0], role: 'employee' });
      await render();

      // Put onto the row in place: the server answered with the corrected
      // account, and re-reading the whole list would rebuild every row to
      // change one.
      expect(element().textContent).toContain('ama@acmetech.example');
      http.expectNone(USERS_URL);
    });

    it('resets a password and shows it once', async () => {
      button('Password').click();
      await render();

      // The field asked for by name, rather than the first password input: the
      // "Add a user" dialog keeps a password field in the document too, even
      // while it is closed, and a find by type would type into that one.
      const field = Array.from(element().querySelectorAll<HTMLElement>('app-form-field')).find(
        (candidate) => candidate.querySelector('label')?.textContent?.trim().startsWith('New password'),
      ) as HTMLElement;
      const password = field.querySelector('input') as HTMLInputElement;
      password.value = 'brand-new-password-1!';
      password.dispatchEvent(new Event('input'));
      fixture.detectChanges();

      const save = button('Set password');
      save.click();

      const request = http.expectOne(`${API_BASE_URL}/api/auth/users/u1/password`);

      expect(request.request.method).toBe('POST');
      expect(request.request.body).toEqual({ password: 'brand-new-password-1!' });
      request.flush({ status: 'password-reset' });
      await render();

      expect(element().textContent).toContain("Ama Konadu's new password");
    });

    it('deletes behind a confirmation', async () => {
      const deletes = element().querySelectorAll<HTMLButtonElement>(
        'button[aria-label="Delete Ama Konadu"]',
      );
      deletes[0].click();
      await render();

      expect(element().textContent).toContain('Delete this account?');

      const confirm = button('Delete');
      confirm.click();

      const request = http.expectOne(`${API_BASE_URL}/api/auth/users/u1`);

      expect(request.request.method).toBe('DELETE');
      request.flush({ status: 'deleted' });
      await render();

      // The row is lifted out of the list already in hand, so the page is not
      // re-read: only a page emptied out from under the pager needs the server.
      expect(element().textContent).not.toContain('ama@acmetech.example');
      http.expectNone(USERS_URL);
    });

    it('validates the add-user form before sending anything', async () => {
      await openCreateDialog();

      // Submitting empty fields must show errors and never reach the server.
      await submitNewUser();

      expect(element().textContent).toContain('Enter their full name');
      expect(element().textContent).toContain('Enter their work email');
      expect(element().textContent).toContain('Choose a password for them');
      http.expectNone(ACCOUNTS_URL);

      // A malformed address and a short password are refused on the client side too.
      typeIntoCreateField('Full name', 'Kofi Mensah');
      typeIntoCreateField('Work email', 'kofi');
      typeIntoCreateField('Password', 'short');
      await submitNewUser();

      expect(element().textContent).toContain('That does not look like an email address');
      expect(element().textContent).toContain('Use at least 8 characters');
      http.expectNone(ACCOUNTS_URL);

      // An address outside the company is refused before a round trip.
      typeIntoCreateField('Work email', `kofi@gmail.com`);
      await submitNewUser();

      expect(element().textContent).toContain(`Use their @${DOMAIN} work email`);
      http.expectNone(ACCOUNTS_URL);
    });

    it('trims the name and email but never trims the password when creating a user', async () => {
      await openCreateDialog();

      typeIntoCreateField('Full name', '  Kofi Mensah  ');
      typeIntoCreateField('Work email', `  kofi@${DOMAIN}  `);
      typeIntoCreateField('Password', '  their-own-pass1  ');
      await submitNewUser();

      const request = http.expectOne(ACCOUNTS_URL);

      expect(request.request.method).toBe('POST');
      expect(request.request.body).toEqual({
        name: 'Kofi Mensah',
        email: `kofi@${DOMAIN}`,
        role: 'employee',
        password: '  their-own-pass1  ',
      });
      request.flush({
        user: {
          id: 'u2',
          name: 'Kofi Mensah',
          email: `kofi@${DOMAIN}`,
          role: 'employee',
        },
      });
      await render();

      expect(element().textContent).toContain('Kofi Mensah can sign in now');
      expect(element().textContent).toContain('kofi@acmetech.example');
      expect(element().textContent).toContain('their-own-pass1');
      http.expectOne(USERS_URL).flush(PAGE);
    });
  });

  describe('as an employee', () => {
    beforeEach(async () => {
      await signedInAs('employee');
      await render();
    });

    it('asks for nothing and shows the gate', async () => {
      http.expectNone(USERS_URL);

      expect(element().textContent).toContain('administrator');
    });
  });
});
