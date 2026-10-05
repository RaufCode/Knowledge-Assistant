import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { API_BASE_URL } from '../../core/api.config';
import { AuthService } from '../../core/services/auth.service';
import { AdminUsersViewComponent } from './admin-users-view.component';

const USERS_URL = `${API_BASE_URL}/api/auth/users?page=1`;

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
      request.flush({ ...USERS[0] });
      http.expectOne(USERS_URL).flush(PAGE);
      await render();
    });

    it('resets a password and shows it once', async () => {
      button('Password').click();
      await render();

      const field = element().querySelectorAll<HTMLInputElement>(
        'app-form-field input',
      );
      const password = Array.from(field).find((input) => input.type === 'password') as HTMLInputElement;
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
      http.expectOne(USERS_URL).flush({ ...PAGE, users: [], total: 0 });
      await render();
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
