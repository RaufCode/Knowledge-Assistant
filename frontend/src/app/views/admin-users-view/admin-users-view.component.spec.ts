import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { API_BASE_URL } from '../../core/api.config';
import { AuthService } from '../../core/services/auth.service';
import { AdminUsersViewComponent } from './admin-users-view.component';

const REQUESTS_URL = `${API_BASE_URL}/api/auth/requests`;

/** One request, as the backend lists it. */
const ROWS = [
  {
    id: 'r1',
    name: 'Ama Konadu',
    email: 'ama@acmetech.example',
    status: 'pending',
    requested_at: '2026-10-01T09:00:00',
    decided_at: null,
  },
];

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
      http.expectOne(REQUESTS_URL).flush({ requests: ROWS });
      await render();
    });

    it('reads people from the access-requests endpoint, since there is no accounts list', async () => {
      expect(element().textContent).toContain('ama@acmetech.example');
    });

    it('offers adding, inviting and the queue above the list', async () => {
      expect(button('Add a user')).toBeTruthy();
      expect(button('Invite by link')).toBeTruthy();
      expect(element().querySelector('a[href="/admin/access"]')).not.toBeNull();
    });

    it('opens adding a user in a dialog, not in the page', async () => {
      expect(element().querySelector('input#name, input[name="name"]')).toBeNull();

      button('Add a user').click();
      await render();

      const scroll = element().querySelector('.scrollbar-thin') as HTMLElement;
      const form = element().querySelector('form') as HTMLFormElement;

      expect(form).not.toBeNull();
      expect(scroll.contains(form)).toBe(false);
      expect(form.closest('dialog')?.textContent).toContain('Add a user');
    });

    it('creates the account and shows the password once', async () => {
      button('Add a user').click();
      await render();

      const type = (index: number, value: string): void => {
        const field = element().querySelectorAll<HTMLInputElement>(
          'app-form-field input',
        )[index];
        field.value = value;
        field.dispatchEvent(new Event('input'));
        fixture.detectChanges();
      };

      type(0, 'Ama Konadu');
      type(1, 'ama@acmetech.example');
      type(2, 'correct-horse-1!');

      const create = Array.from(element().querySelectorAll('button')).find(
        (candidate) => candidate.textContent?.trim() === 'Create account',
      ) as HTMLButtonElement;
      create.click();

      const request = http.expectOne(`${API_BASE_URL}/api/auth/accounts`);

      expect(request.request.method).toBe('POST');
      expect(request.request.body).toEqual({
        name: 'Ama Konadu',
        email: 'ama@acmetech.example',
        role: 'employee',
        password: 'correct-horse-1!',
      });
      request.flush({ user: { id: 'u1', name: 'Ama Konadu', email: 'ama@acmetech.example', role: 'employee' } });
      http.expectOne(REQUESTS_URL).flush({ requests: ROWS });
      await render();

      expect(element().textContent).toContain('can sign in now');
    });

    it('mints an invite link and shows it once', async () => {
      button('Invite by link').click();
      await render();

      const fields = element().querySelectorAll<HTMLInputElement>('app-form-field input');

      fields[0].value = 'Ama Konadu';
      fields[0].dispatchEvent(new Event('input'));
      fields[1].value = 'ama@acmetech.example';
      fields[1].dispatchEvent(new Event('input'));
      fixture.detectChanges();

      const invite = Array.from(element().querySelectorAll('button')).find(
        (candidate) => candidate.textContent?.trim() === 'Create invite link',
      ) as HTMLButtonElement;
      invite.click();

      const request = http.expectOne(`${API_BASE_URL}/api/auth/invite`);

      expect(request.request.method).toBe('POST');
      expect(request.request.body).toEqual({
        name: 'Ama Konadu',
        email: 'ama@acmetech.example',
        role: 'employee',
      });
      request.flush({
        invite_link: 'http://app/accept-invite?token=abc',
        token: 'abc',
        expires_at: '2026-10-04T09:00:00',
        user: { id: 'u1', name: 'Ama Konadu', email: 'ama@acmetech.example', role: 'employee' },
      });
      http.expectOne(REQUESTS_URL).flush({ requests: ROWS });
      await render();

      expect(element().textContent).toContain('Invite ready');
    });

    it('approves a waiting request in place', async () => {
      button('Approve').click();

      const request = http.expectOne(`${API_BASE_URL}/api/auth/requests/r1/approve`);

      expect(request.request.body).toEqual({ role: 'employee' });
      request.flush({
        request: { ...ROWS[0], status: 'approved', decided_at: '2026-10-02T09:00:00' },
        invite_link: '',
        token: '',
        expires_at: '',
      });
      await render();

      expect(element().textContent).toContain('Approved');
    });

    it('searches the people it is showing', async () => {
      const field = element().querySelector('app-input input') as HTMLInputElement;

      field.value = 'nobody here';
      field.dispatchEvent(new Event('input'));
      await render();

      expect(element().textContent).toContain('Nobody matches that search');
      expect(element().textContent).not.toContain('ama@acmetech.example');
    });
  });

  describe('as an employee', () => {
    beforeEach(async () => {
      await signedInAs('employee');
      await render();
    });

    it('asks for nothing and shows the gate', async () => {
      http.expectNone(REQUESTS_URL);

      expect(element().textContent).toContain('administrator');
    });
  });
});
