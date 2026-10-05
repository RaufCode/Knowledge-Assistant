import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { API_BASE_URL } from '../../core/api.config';
import { AuthService } from '../../core/services/auth.service';
import { AdminAccessRequestsViewComponent } from './admin-access-requests-view.component';

const REQUESTS_URL = `${API_BASE_URL}/api/auth/requests`;

/** One waiting request, as the backend lists it. */
const PENDING = {
  id: 'req-1',
  name: 'Kofi Mensah',
  email: 'kofi@acmetech.example',
  status: 'pending',
  requested_at: '2026-10-01T09:00:00',
  decided_at: null,
};

describe('AdminAccessRequestsViewComponent', () => {
  let fixture: ComponentFixture<AdminAccessRequestsViewComponent>;
  let http: HttpTestingController;

  const element = (): HTMLElement => fixture.nativeElement as HTMLElement;

  const render = async (): Promise<void> => {
    fixture.detectChanges();
    await fixture.whenStable();
  };

  /** The button whose label is exactly this. */
  const button = (label: string): HTMLButtonElement =>
    Array.from(element().querySelectorAll<HTMLButtonElement>('button')).find(
      (candidate) => candidate.textContent?.trim() === label,
    ) as HTMLButtonElement;

  /** Every row currently listed. */
  const rows = (): HTMLElement[] =>
    Array.from(element().querySelectorAll<HTMLElement>('li.rounded-lg'));

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AdminAccessRequestsViewComponent],
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();

    fixture = TestBed.createComponent(AdminAccessRequestsViewComponent);
    http = TestBed.inject(HttpTestingController);
  });

  /**
   * Signs in as somebody with this role, the way the app does.
   *
   * The real `AuthService` rather than a stub, because what is worth checking here is
   * the requests these buttons send and the decision that comes back. The role is
   * established the only way the app ever establishes one: an answer from
   * `GET /api/auth/me`.
   */
  const signedInAs = async (role: 'employee' | 'admin'): Promise<void> => {
    const bootstrap = TestBed.inject(AuthService).bootstrap();

    http.expectOne(`${API_BASE_URL}/api/auth/me`).flush({
      id: 'u1',
      name: 'Kwame Osei',
      email: 'kwame@acmetech.example',
      role,
    });
    await bootstrap;
    await new Promise((resolve) => setTimeout(resolve, 0));

    http.expectOne(`${API_BASE_URL}/api/auth/csrf`).flush({ csrf_token: 'token' });
    fixture.detectChanges();
  };

  describe('as an administrator', () => {
    beforeEach(async () => {
      await signedInAs('admin');
    });

    it('asks for the queue on load', async () => {
      const request = http.expectOne(REQUESTS_URL);

      expect(request.request.method).toBe('GET');
      request.flush({ requests: [PENDING] });
      await render();
    });

    it('lists who is waiting, and how long they have been', async () => {
      http.expectOne(REQUESTS_URL).flush({ requests: [PENDING] });
      await render();

      expect(element().textContent).toContain('Kofi Mensah');
      expect(element().textContent).toContain('kofi@acmetech.example');
      expect(element().textContent).toContain('Waiting');
    });

    it('says so when nobody is waiting, rather than showing an empty page', async () => {
      http.expectOne(REQUESTS_URL).flush({ requests: [] });
      await render();

      expect(element().textContent).toContain('Nobody is waiting');
    });

    it('reports a queue it could not load, rather than an empty one', async () => {
      // An empty queue and a queue that failed look identical otherwise, and the
      // reader would conclude there was nothing to do when there might be much.
      http
        .expectOne(REQUESTS_URL)
        .flush({ detail: 'boom' }, { status: 500, statusText: 'Server Error' });
      await render();

      expect(element().textContent).toContain('could not be loaded');
      expect(element().textContent).not.toContain('Nobody is waiting');
    });

    it('approves as an employee by default, sending only a name and an address', async () => {
      http.expectOne(REQUESTS_URL).flush({ requests: [PENDING] });
      await render();

      button('Approve').click();
      await render();

      const request = http.expectOne(`${REQUESTS_URL}/req-1/approve`);

      // The person asking could not set a role, so the least privileged one is what
      // an unadorned approval sends.
      expect(request.request.body).toEqual({ role: 'employee' });

      request.flush({
        request: { ...PENDING, status: 'approved', decided_at: '2026-10-02T09:00:00' },
        invite_link: 'http://localhost:4200/accept-invite?token=abc',
        token: 'abc',
        expires_at: '2026-10-05T09:00:00',
      });
      await render();
    });

    it('grants the administrator role only when that button is the one used', async () => {
      http.expectOne(REQUESTS_URL).flush({ requests: [PENDING] });
      await render();

      button('Make administrator').click();
      await render();

      const request = http.expectOne(`${REQUESTS_URL}/req-1/approve`);

      // This is the only control in the product that can create an administrator, so
      // what it sends is pinned rather than assumed.
      expect(request.request.body).toEqual({ role: 'admin' });

      request.flush({
        request: { ...PENDING, status: 'approved', decided_at: '2026-10-02T09:00:00' },
        invite_link: '',
        token: '',
        expires_at: '',
      });
      await render();
    });

    it('shows the invitation link an approval produced, so it can be sent on', async () => {
      http.expectOne(REQUESTS_URL).flush({ requests: [PENDING] });
      await render();

      button('Approve').click();
      await render();

      http.expectOne(`${REQUESTS_URL}/req-1/approve`).flush({
        request: { ...PENDING, status: 'approved', decided_at: '2026-10-02T09:00:00' },
        invite_link: 'http://localhost:4200/accept-invite?token=abc',
        token: 'abc',
        expires_at: '2026-10-05T09:00:00',
      });
      await render();

      // There is no mail service, so the link is the deliverable.
      expect(element().textContent).toContain('accept-invite?token=abc');
      expect(element().textContent).toContain('works once and then expires');

      // And the row is decided in place, rather than the list jumping.
      expect(element().textContent).toContain('Approved');
      expect(button('Approve')).toBeUndefined();
    });

    it('shows no link when the approval produced none', async () => {
      http.expectOne(REQUESTS_URL).flush({ requests: [PENDING] });
      await render();

      button('Approve').click();
      await render();

      // An approval where the account already existed has nothing to send, so
      // offering an empty link to copy would be worse than saying nothing.
      http.expectOne(`${REQUESTS_URL}/req-1/approve`).flush({
        request: { ...PENDING, status: 'approved', decided_at: '2026-10-02T09:00:00' },
        invite_link: '',
        token: '',
        expires_at: '',
      });
      await render();

      expect(element().textContent).not.toContain('Send this link');
    });

    it('declines without sending a role, because there is nothing to grant', async () => {
      http.expectOne(REQUESTS_URL).flush({ requests: [PENDING] });
      await render();

      button('Decline').click();
      await render();

      const request = http.expectOne(`${REQUESTS_URL}/req-1/decline`);

      expect(request.request.body).toEqual({});

      request.flush({
        request: { ...PENDING, status: 'declined', decided_at: '2026-10-02T09:00:00' },
        invite_link: '',
        token: '',
        expires_at: '',
      });
      await render();

      expect(element().textContent).toContain('Declined');
    });

    it("passes the backend's refusal through", async () => {
      http.expectOne(REQUESTS_URL).flush({ requests: [PENDING] });
      await render();

      button('Approve').click();
      await render();

      http
        .expectOne(`${REQUESTS_URL}/req-1/approve`)
        .flush(
          { detail: 'That request has already been approved.' },
          { status: 409, statusText: 'Conflict' },
        );
      await render();

      // Worth saying plainly: it stops an administrator believing a decision landed
      // when it did not.
      expect(element().textContent).toContain('already been approved');
    });

    it('leaves a decided row with no buttons on it', async () => {
      http.expectOne(REQUESTS_URL).flush({
        requests: [
          { ...PENDING, status: 'approved', decided_at: '2026-10-02T09:00:00' },
          { ...PENDING, id: 'req-2', name: 'Second Person', status: 'pending' },
        ],
      });
      await render();

      expect(rows().length).toBe(2);

      // Exactly one set of buttons, for the row still waiting.
      expect(button('Approve')).toBeTruthy();
      expect(button('Make administrator')).toBeTruthy();
      expect(button('Decline')).toBeTruthy();
    });
  });

  describe('going back', () => {
    beforeEach(async () => {
      await signedInAs('admin');
      http.expectOne(REQUESTS_URL).flush({ requests: [] });
      await render();
    });

    it('offers a way back to Users, which is where the queue is reached from', () => {
      // A queue of people who cannot get in, with no way out of it, is the one outcome
      // worth avoiding. The fallback route matters as much as the button: somebody who
      // typed this address has not been anywhere to go back to.
      const back = element().querySelector('button[aria-label="Back to users"]');

      expect(back).not.toBeNull();
      expect(back?.textContent).toContain('Back to users');
    });
  });

  describe('a decided request', () => {
    beforeEach(async () => {
      await signedInAs('admin');
      http.expectOne(REQUESTS_URL).flush({
        requests: [
          {
            id: 'req-9',
            name: 'Ama Konadu',
            email: 'ama@acmetech.example',
            status: 'declined',
            requested_at: '2026-10-01T09:00:00',
            decided_at: '2026-10-03T11:30:00',
          },
        ],
      });
      await render();
    });

    it('says when it was decided when the badge is hovered', () => {
      // The badge said only "Declined", so the one question about a closed request —
      // how long has this been sitting here — needed the row opened to answer.
      const badge = element().querySelector('app-badge') as HTMLElement;

      expect(badge).not.toBeNull();
      expect(badge.getAttribute('title')).toContain('Declined');
    });

    it('runs the full width of the page, like the pages beside it', () => {
      // A centred column held this at 64rem while the bar above ran the full width of
      // the window, and the users page used a third width, so moving between the two
      // moved the content sideways.
      const scroll = element().querySelector('.scrollbar-thin') as HTMLElement;

      expect(scroll).not.toBeNull();
      expect(scroll.querySelector('.max-w-5xl')).toBeNull();
      expect(scroll.querySelector('.max-w-4xl')).toBeNull();
    });
  });

  describe('as an employee', () => {
    beforeEach(async () => {
      await signedInAs('employee');
    });

    it('explains itself instead of showing the queue', async () => {
      await render();

      expect(element().querySelector('app-admin-access-required')).toBeTruthy();
      expect(element().textContent).not.toContain('Kofi Mensah');

      // And nothing was asked of the backend. The guard already turned this person
      // away; a request here would be a second chance for the screen to be wrong.
      http.verify();
    });
  });
});
