import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { API_BASE_URL } from '../../../../core/api.config';
import { RegisterViewComponent } from './register-view.component';

const DOMAIN = 'acmetech.example';

describe('RegisterViewComponent', () => {
  let fixture: ComponentFixture<RegisterViewComponent>;
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

  const fillValid = (): void => {
    type(0, 'Kofi Mensah');
    type(1, `kofi@${DOMAIN}`);
    type(2, 'correct-horse-1!');
    type(3, 'correct-horse-1!');
  };

  /** The one request this screen can make. */
  const REQUEST_URL = `${API_BASE_URL}/api/auth/request-access`;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [RegisterViewComponent],
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();

    fixture = TestBed.createComponent(RegisterViewComponent);
    http = TestBed.inject(HttpTestingController);
    await render();
  });

  it('asks for a name, an address and a password with confirmation', async () => {
    expect(element().textContent).toContain('Request access');
    expect(fields().length).toBe(4);
    expect(fields().map((field) => field.type)).toEqual(['text', 'email', 'password', 'password']);
    expect(element().textContent).toContain('At least 6 characters');
  });

  it('says the account is not created yet, so nobody expects to be signed in', async () => {
    fillValid();
    await submit();

    http.expectOne(REQUEST_URL).flush({ status: 'received' });
    await render();

    // The one thing that must not be implied: that filling this in signed anybody in.
    expect(element().textContent).toContain('with an administrator now');
    expect(element().textContent).toContain('once they approve it');
    expect(element().textContent).not.toContain('you are now signed in');
    expect(element().querySelector('app-form-field')).toBeNull();
  });

  it('sends the name, the address and the password, trimmed', async () => {
    type(0, '  Kofi Mensah  ');
    type(1, `  kofi@${DOMAIN}  `);
    type(2, 'correct-horse-1!');
    type(3, 'correct-horse-1!');
    await submit();

    const request = http.expectOne(REQUEST_URL);

    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({
      name: 'Kofi Mensah',
      email: `kofi@${DOMAIN}`,
      password: 'correct-horse-1!',
    });
    request.flush({ status: 'received' });
  });

  it('carries no role, because the person asking does not get to choose one', async () => {
    fillValid();
    await submit();

    // The backend has no field for it either, so sending one would be meaningless —
    // but the shape of what is sent is worth pinning, since a role here would be the
    // whole security property of the request flow.
    const request = http.expectOne(REQUEST_URL);

    expect(Object.keys(request.request.body as object).sort()).toEqual([
      'email',
      'name',
      'password',
    ]);
    request.flush({ status: 'received' });
  });

  it('refuses a short password and a mismatch before making a round trip', async () => {
    fillValid();
    type(2, 'abc');
    type(3, 'abc');
    await submit();

    expect(element().textContent).toContain('satisfies every rule');
    http.expectNone(REQUEST_URL);

    fillValid();
    type(3, 'something-else-1!');
    await submit();

    expect(element().textContent).toContain('Passwords do not match');
    http.expectNone(REQUEST_URL);
  });

  it('refuses an address outside the company before making a round trip', async () => {
    fillValid();
    type(1, 'kofi@gmail.com');
    await submit();

    expect(element().textContent).toContain(`Use your @${DOMAIN} work email`);
    http.expectNone(REQUEST_URL);
  });

  it('refuses something that is not an address at all', async () => {
    fillValid();
    type(1, 'kofi');
    await submit();

    expect(element().textContent).toContain('does not look like an email address');
    http.expectNone(REQUEST_URL);
  });

  it('complains about empty fields only once the form is sent', async () => {
    expect(element().textContent).not.toContain('Enter your full name');

    await submit();

    expect(element().textContent).toContain('Enter your full name');
    expect(element().textContent).toContain('Enter your work email');
    expect(element().textContent).toContain('Choose a password');
    expect(element().textContent).toContain('Type your password again');
    http.expectNone(REQUEST_URL);
  });

  it("passes the backend's own refusals through, because both are actionable", async () => {
    fillValid();
    await submit();

    // "You already have an account" is more use than a generic failure, and it comes
    // from the only place that knows.
    http
      .expectOne(REQUEST_URL)
      .flush(
        { detail: 'There is already an account for that address. Sign in instead.' },
        { status: 409, statusText: 'Conflict' },
      );
    await render();

    expect(element().textContent).toContain('already an account');
    expect(element().querySelector('form')).not.toBeNull();
  });

  it('says so plainly when the attempt limit is reached', async () => {
    fillValid();
    await submit();

    http
      .expectOne(REQUEST_URL)
      .flush({ detail: 'Too many attempts.' }, { status: 429, statusText: 'Too Many Requests' });
    await render();

    // The reader did nothing wrong, so the message must not read as though they had.
    expect(element().textContent).toContain('Too many attempts');
  });

  it('reports a failure to reach the server rather than silently doing nothing', async () => {
    fillValid();
    await submit();

    // Status 0 is what the browser reports for a request the network dropped, and it
    // has to read as a failure: the form still sitting there unchanged would look
    // like the request was never made.
    http.expectOne(REQUEST_URL).flush({}, { status: 0, statusText: 'Unknown Error' });
    await render();

    expect(element().textContent).toContain('Could not reach the server');
    expect(element().querySelector('form')).not.toBeNull();
  });

  it('offers a single-line way back to signing in, and no invite link', async () => {
    expect(element().querySelector('a[href="/login"]')).not.toBeNull();
    expect(element().querySelector('a[href="/accept-invite"]')).toBeNull();
  });
});

// A placeholder used only to keep the spy above honest about what it is not doing.
class RouterStub {
  noop(): void {
    /* deliberately empty */
  }
}
