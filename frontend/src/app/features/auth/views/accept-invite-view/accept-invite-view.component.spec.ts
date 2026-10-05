import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap, provideRouter } from '@angular/router';

import { API_BASE_URL } from '../../../../core/api.config';
import { AcceptInviteViewComponent } from './accept-invite-view.component';

const TOKEN = 'a-token-long-enough-to-be-one';
const PASSWORD = 'correct horse 1!';

describe('AcceptInviteViewComponent', () => {
  let fixture: ComponentFixture<AcceptInviteViewComponent>;
  let http: HttpTestingController;
  let router: Router;

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

  /**
   * Builds the component with a token in the URL.
   *
   * Provided by hand rather than through a real navigation, because what matters
   * here is that the screen reads the token out of the query string — the routing
   * itself is covered by the router's own tests.
   */
  const createWithToken = async (token: string | null): Promise<void> => {
    await TestBed.configureTestingModule({
      imports: [AcceptInviteViewComponent],
      providers: [
        provideRouter([
          { path: 'accept-invite', children: [] },
          { path: '', children: [] },
        ]),
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: { queryParamMap: convertToParamMap(token ? { token } : {}) },
          },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(AcceptInviteViewComponent);
    http = TestBed.inject(HttpTestingController);
    router = TestBed.inject(Router);
    await render();
  };

  /**
   * Answers the invitation lookup that happens on load.
   *
   * Blank by default. The pre-fill test passes real values; the rest want an empty
   * form, because a form filled in from the preview has nothing to complain about
   * and every one of their assertions is about what it says when something is
   * missing.
   */
  const answerPreview = (overrides: Record<string, unknown> = {}): void => {
    http.expectOne(`${API_BASE_URL}/api/auth/invite/${TOKEN}`).flush({
      name: '',
      email: '',
      role: 'employee',
      expires_at: '2026-12-01T00:00:00Z',
      ...overrides,
    });
  };

  /** A filled-in preview, for the tests that check the form was populated. */
  const answerFilledPreview = (): void => {
    answerPreview({ name: 'Ama Konadu', email: 'ama.konadu@acmetech.example' });
  };

  describe('with a token in the link', () => {
    beforeEach(async () => {
      await createWithToken(TOKEN);
    });

    it('asks the backend what the invitation is for, then fills the form in', async () => {
      const request = http.expectOne(`${API_BASE_URL}/api/auth/invite/${TOKEN}`);

      // No session yet, so the lookup has to be allowed to carry whatever cookies
      // the browser happens to hold.
      expect(request.request.withCredentials).toBe(true);

      request.flush({
        name: 'Ama Konadu',
        email: 'ama.konadu@acmetech.example',
        role: 'employee',
        expires_at: '2026-12-01T00:00:00Z',
      });
      await render();

      expect(fields()[0].value).toBe('Ama Konadu');
      expect(fields()[1].value).toBe('ama.konadu@acmetech.example');
    });

    it('complains about empty fields only once the form is sent', async () => {
      // The blank preview this one needs, so there is something missing to
      // complain about. Every other test in this block fills the fields in.
      answerPreview();
      await render();

      expect(element().textContent).not.toContain('Enter your full name');

      await submit();

      expect(element().textContent).toContain('Enter your full name');
    });

    it('will not send a password that misses the rules', async () => {
      answerFilledPreview();
      await render();

      type(2, 'short');
      type(3, 'short');
      await submit();

      expect(element().textContent).toContain('satisfies every rule');
      http.expectNone(`${API_BASE_URL}/api/auth/accept-invite`);
    });

    it('will not send two passwords that disagree', async () => {
      answerFilledPreview();
      await render();

      type(2, PASSWORD);
      type(3, 'something else 2@');
      await submit();

      expect(element().textContent).toContain('Passwords do not match');
      http.expectNone(`${API_BASE_URL}/api/auth/accept-invite`);
    });

    it('sends the token and the password, and nothing else', async () => {
      answerFilledPreview();
      await render();

      type(2, PASSWORD);
      type(3, PASSWORD);
      await submit();

      const request = http.expectOne(`${API_BASE_URL}/api/auth/accept-invite`);

      // The account comes from the token server-side. Sending the name and address
      // up as well would be a second, conflicting claim about who this is.
      expect(request.request.body).toEqual({ token: TOKEN, password: PASSWORD });
      expect(request.request.withCredentials).toBe(true);

      request.flush({
        user: {
          id: 'u1',
          name: 'Ama Konadu',
          email: 'ama.konadu@acmetech.example',
          role: 'employee',
        },
      });
      await render();
    });

    it('goes to the dashboard, because accepting already signed the person in', async () => {
      answerFilledPreview();
      await render();

      type(2, PASSWORD);
      type(3, PASSWORD);
      await submit();

      http.expectOne(`${API_BASE_URL}/api/auth/accept-invite`).flush({
        user: {
          id: 'u1',
          name: 'Ama Konadu',
          email: 'ama.konadu@acmetech.example',
          role: 'employee',
        },
      });
      await render();

      expect(router.url).toBe('/');
    });

    it('keeps the form on screen when the server refuses the password', async () => {
      answerFilledPreview();
      await render();

      type(2, PASSWORD);
      type(3, PASSWORD);
      await submit();

      http
        .expectOne(`${API_BASE_URL}/api/auth/accept-invite`)
        .flush({ detail: 'bad' }, { status: 422, statusText: 'Unprocessable' });
      await render();

      expect(element().textContent).toContain('does not meet the requirements');
      expect(element().querySelector('form')).not.toBeNull();
    });
  });

  it('says the invitation cannot be used, when the server will not confirm it', async () => {
    await createWithToken(TOKEN);

    http
      .expectOne(`${API_BASE_URL}/api/auth/invite/${TOKEN}`)
      .flush({ detail: 'This invitation is not valid.' }, { status: 404, statusText: 'Not Found' });
    await render();

    // The three ways of being unusable all answer the same way server-side, so the
    // screen cannot be more specific than "ask for a new one".
    expect(element().textContent).toContain('cannot be used');
    expect(element().textContent).toContain('Ask for a new one');
    expect(element().querySelector('form')).toBeNull();
  });

  it('explains itself when the link has no token at all', async () => {
    await createWithToken(null);

    expect(element().textContent).toContain('Open the link from your invitation email');
    http.expectNone(`${API_BASE_URL}/api/auth/invite/`);
  });
});
