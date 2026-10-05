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

  /** A complete, valid form: everything filled, and the password confirmed. */
  const fillValid = (password = 'their-own-pass1'): void => {
    type(0, 'Kofi Mensah');
    type(1, `kofi@${DOMAIN}`);
    type(2, password);
    type(3, password);
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

  it('asks for a name, an address and the password twice, and nothing else', async () => {
    expect(element().textContent).toContain('Register');
    expect(fields().length).toBe(4);
    expect(fields().map((field) => field.type)).toEqual([
      'text',
      'email',
      'password',
      'password',
    ]);
  });

  it('says what registering is for, under the title', () => {
    // The sign-in screen says why it is there; this one said nothing, which left the
    // title and a form with no indication that an administrator is involved.
    expect(element().textContent).toContain('An administrator will review your request');
  });

  it('says the account is not created yet, so nobody expects to be signed in', async () => {
    fillValid();
    await submit();

    http.expectOne(REQUEST_URL).flush({ status: 'received' });
    await render();

    // The one thing that must not be implied: that filling this in signed anybody in.
    expect(element().textContent).not.toContain('you are now signed in');
    expect(element().textContent).toContain('your request is with an administrator');
    expect(element().querySelector('app-form-field')).toBeNull();

    // And it says what to do next, which is sign in and check. The account exists from
    // here, switched off, so this is somewhere they can come back to.
    expect(element().textContent).toContain('Sign in with the password you just chose');
  });

  it('trims the name and the address but never the password', async () => {
    type(0, '  Kofi Mensah  ');
    type(1, `  kofi@${DOMAIN}  `);
    type(2, '  their-own-pass1  ');
    type(3, '  their-own-pass1  ');
    await submit();

    const request = http.expectOne(REQUEST_URL);

    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({
      name: 'Kofi Mensah',
      email: `kofi@${DOMAIN}`,
      role: 'employee',
      // Deliberately untrimmed. A password is whatever the person chose, and quietly
      // removing a space from it gives them a password they have never typed and will
      // be told is wrong.
      password: '  their-own-pass1  ',
    });
    request.flush({ status: 'received' });
  });

  it('never shows a choice of role, and asks for the least privileged one', async () => {
    // There is no role on this form. Somebody registering is asking for an account,
    // not choosing a level of access for it, and a chooser here would have been the
    // one control in the product that hands out privilege without an administrator.
    expect(element().querySelector('input[type="radio"]')).toBeNull();
    expect(element().textContent).not.toContain('Access you are asking for');
    expect(element().textContent).not.toContain('Administrator');

    fillValid();
    await submit();

    const request = http.expectOne(REQUEST_URL);

    expect(request.request.body.role).toBe('employee');
  });

  it('asks for the password twice, and refuses the two that differ', async () => {
    // The backend receives one password field and cannot tell a mistyped one from a
    // deliberate one, so this is the only place the mistake can be caught.
    type(0, 'Kofi Mensah');
    type(1, `kofi@${DOMAIN}`);
    type(2, 'their-own-pass1');
    type(3, 'their-own-pass2');
    await submit();

    http.expectNone(REQUEST_URL);
    expect(element().textContent).toContain('Those passwords do not match');
  });

  it('never sends the confirmation, only the password', async () => {
    // The confirmation is a check, not a second secret. Sending it would put a field
    // in the request that the backend has no use for.
    fillValid('their-own-pass1');
    await submit();

    const body = http.expectOne(REQUEST_URL).request.body as Record<string, unknown>;

    expect(body['password']).toBe('their-own-pass1');
    expect(Object.keys(body)).not.toContain('confirmPassword');
    expect(Object.keys(body)).not.toContain('confirm_password');
  });

  it('refuses a password the backend would refuse, before a round trip', async () => {
    fillValid('short');
    await submit();

    http.expectNone(REQUEST_URL);
    expect(element().textContent).toContain('at least 8 characters');
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
    // Re-typed at the confirmation field's index too, so the only thing wrong with
    // this form is the address.
    await submit();

    expect(element().textContent).toContain('does not look like an email address');
    http.expectNone(REQUEST_URL);
  });

  it('complains about empty fields only once the form is sent', async () => {
    expect(element().textContent).not.toContain('Enter your full name');

    await submit();

    expect(element().textContent).toContain('Enter your full name');
    expect(element().textContent).toContain('Enter your work email');
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

  it('offers a way back to signing in, on one line', () => {
    const back = element().querySelector('a[href="/login"]') as HTMLElement;

    expect(back).not.toBeNull();

    // One line, and centred with the question it answers. Stacked, these were three
    // short centred lines that read as a footnote rather than as part of the form.
    const footer = back.closest('div') as HTMLElement;

    // The two halves separately, because Angular drops the whitespace between
    // elements and the gap is a flex gap rather than a character.
    expect(footer.querySelector('span')?.textContent?.trim()).toBe(
      'Already have an account?',
    );
    expect(back.textContent?.trim()).toBe('Sign in');

    // Centred by the box rather than by `text-align`, which only holds while both
    // halves happen to be inline.
    expect(footer.className).toContain('justify-center');
    expect(footer.className).toContain('flex-wrap');
    expect(footer.className).not.toContain('flex-col');

    // The invitation route is not offered here. Somebody who was invited was told so,
    // and it reached them by a link an administrator sent.
    expect(element().querySelector('a[href="/accept-invite"]')).toBeNull();
  });
});

// A placeholder used only to keep the spy above honest about what it is not doing.
class RouterStub {
  noop(): void {
    /* deliberately empty */
  }
}
