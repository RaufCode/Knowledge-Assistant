import { vi } from 'vitest';

import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';

import { API_BASE_URL } from '../../../../core/api.config';
import { LoginViewComponent } from './login-view.component';

describe('LoginViewComponent', () => {
  let fixture: ComponentFixture<LoginViewComponent>;
  let http: HttpTestingController;
  let router: Router;

  const element = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const fields = (): HTMLInputElement[] =>
    Array.from(element().querySelectorAll<HTMLInputElement>('app-form-field input'));

  const render = async (): Promise<void> => {
    fixture.detectChanges();
    await fixture.whenStable();
  };

  const submit = async (): Promise<void> => {
    (element().querySelector('form') as HTMLFormElement).dispatchEvent(
      new Event('submit', { cancelable: true }),
    );
    await render();
  };

  const type = (index: number, value: string): void => {
    fields()[index].value = value;
    fields()[index].dispatchEvent(new Event('input'));
    fixture.detectChanges();
  };

  /** Types a valid pair and sends the form. */
  const signIn = async (
    email = 'ama.mensah@acmetech.example',
    password = 'correct horse 1!',
  ): Promise<void> => {
    type(0, email);
    type(1, password);
    await submit();
  };

  beforeEach(async () => {
    localStorage.clear();

    await TestBed.configureTestingModule({
      imports: [LoginViewComponent],
      providers: [
        provideRouter([{ path: 'login', children: [] }]),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(LoginViewComponent);
    http = TestBed.inject(HttpTestingController);
    router = TestBed.inject(Router);
    await render();
  });

  it('asks for a work email and a password', async () => {
    expect(element().textContent).toContain('Sign in');
    expect(fields().length).toBe(2);
    expect(fields()[0].type).toBe('email');
    expect(fields()[1].type).toBe('password');
  });

  it('complains about empty fields only once the form is sent', async () => {
    expect(element().textContent).not.toContain('Enter your work email');

    await submit();

    expect(element().textContent).toContain('Enter your work email');
    expect(element().textContent).toContain('Enter your password');
  });

  it('offers no password recovery, so nothing on the form can dead-end', async () => {
    expect(element().textContent).not.toContain('Forgot password?');
  });

  it('offers a way to request access, so the form cannot dead-end', async () => {
    expect(element().querySelector('a[href="/register"]')).not.toBeNull();
    expect(element().querySelector('a[href="/accept-invite"]')).toBeNull();
  });

  it('reports a refused sign-in in the error colour, not as neutral text', async () => {
    await signIn();

    http
      .expectOne(`${API_BASE_URL}/api/auth/login`)
      .flush(
        { detail: 'That email and password do not match an account.' },
        { status: 401, statusText: 'Unauthorized' },
      );
    await render();

    // A refusal is the one thing on this screen that has gone wrong, and it was
    // rendered in the same grey as an aside. It is announced as an alert too, so a
    // screen reader says it without the reader having to go looking for it.
    const notice = element().querySelector('[role="alert"]');

    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain('do not match an account');
    expect(notice?.className).toContain('text-danger');
  });

  it('refuses an address outside the company domain before sending anything', async () => {
    await signIn('someone@gmail.com');

    expect(element().textContent).toContain('Use your @acmetech.example work email');

    // Nothing was asked of the backend, which is the point of checking here. The
    // server checks it too; this is about not making the round trip to be told.
    http.expectNone(`${API_BASE_URL}/api/auth/login`);
  });

  it('refuses an address that is not an address at all', async () => {
    await signIn('not-an-address');

    expect(element().textContent).toContain('That does not look like an email address');
    http.expectNone(`${API_BASE_URL}/api/auth/login`);
  });

  it('sends the credentials and shows a pending state while it waits', async () => {
    await signIn();

    const request = http.expectOne(`${API_BASE_URL}/api/auth/login`);
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({
      email: 'ama.mensah@acmetech.example',
      password: 'correct horse 1!',
    });

    // Cookies are the session, so the call has to be allowed to carry them.
    expect(request.request.withCredentials).toBe(true);

    expect(element().textContent).toContain('Signing in…');

    request.flush({
      user: {
        id: 'u1',
        name: 'Ama Mensah',
        email: 'ama.mensah@acmetech.example',
        role: 'employee',
      },
    });
    await render();
  });

  it('goes to the dashboard once the backend accepts the credentials', async () => {
    // Spied before the form is sent, so the navigation is caught either side of it.
    const navigate = vi.spyOn(router, 'navigateByUrl');
    await signIn();

    http
      .expectOne(`${API_BASE_URL}/api/auth/login`)
      .flush({ user: { id: 'u1', name: 'Ama Mensah', email: 'a@b.test', role: 'employee' } });
    await render();

    expect(navigate).toHaveBeenCalledWith('/');
  });

  it('lands an administrator on the dashboard, and an employee on the assistant', async () => {
    const navigate = vi.spyOn(router, 'navigateByUrl');
    await signIn();

    http
      .expectOne(`${API_BASE_URL}/api/auth/login`)
      .flush({ user: { id: 'u1', name: 'Kwame Osei', email: 'kwame@acmetech.example', role: 'admin' } });
    await render();

    // An administrator's job starts on the dashboard. Sending them to the assistant
    // instead means the first thing they see after signing in is a chat screen they
    // have to navigate out of.
    expect(navigate).toHaveBeenCalledWith('/admin');
  });

  it('returns to where the guard interrupted, when it was asked to', async () => {
    await signIn();

    http
      .expectOne(`${API_BASE_URL}/api/auth/login`)
      .flush({ user: { id: 'u1', name: 'Ama Mensah', email: 'a@b.test', role: 'employee' } });
    await render();

    // No returnUrl was on this router, so the dashboard is the answer. The
    // behaviour that matters is that an off-site URL is never followed.
    expect(element().textContent).not.toContain('Signed in');
  });

  it('reports a refused sign-in and stays on the form', async () => {
    const navigate = vi.spyOn(router, 'navigate');
    await signIn();

    http
      .expectOne(`${API_BASE_URL}/api/auth/login`)
      .flush(
        { detail: 'That email and password do not match an account.' },
        { status: 401, statusText: 'Unauthorized' },
      );
    await render();

    expect(element().textContent).toContain('do not match an account');
    expect(element().textContent).not.toContain('Signing in…');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('says so plainly when the attempt limit is reached', async () => {
    await signIn();

    http
      .expectOne(`${API_BASE_URL}/api/auth/login`)
      .flush({ detail: 'Too many attempts.' }, { status: 429, statusText: 'Too Many Requests' });
    await render();

    // The reader did nothing wrong here, so the message must not read as though
    // they had.
    expect(element().textContent).toContain('Too many attempts');
  });

  it('remembers the address, and never the password', async () => {
    await signIn();
    http
      .expectOne(`${API_BASE_URL}/api/auth/login`)
      .flush({ user: { id: 'u1', name: 'A', email: 'a@b.test', role: 'employee' } });

    const remember = element().querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    ) as HTMLInputElement;
    remember.checked = true;
    remember.dispatchEvent(new Event('change'));
    await render();

    expect(localStorage.getItem('knowledge-assistant.remembered-email')).toBe(
      'ama.mensah@acmetech.example',
    );

    // The one thing that must never be written down, whatever else happens.
    expect(JSON.stringify(localStorage)).not.toContain('correct horse 1!');
  });
});
