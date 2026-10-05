import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { API_BASE_URL } from '../../core/api.config';
import type { AccessRequestRowDto } from '../../core/models/access-request.model';
import { AuthServiceStub, provideAuthStub } from '../../core/testing/auth-service.stub';
import { AdminDashboardViewComponent } from './admin-dashboard-view.component';

describe('AdminDashboardViewComponent', () => {
  let fixture: ComponentFixture<AdminDashboardViewComponent>;
  let auth: AuthServiceStub;
  let http: HttpTestingController;

  const element = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const text = (): string => element().textContent ?? '';

  /** One access request, with only the fields the screen reads spelled out. */
  const request = (over: Partial<AccessRequestRowDto> = {}): AccessRequestRowDto => ({
    id: 'r1',
    name: 'Ama Konadu',
    email: 'ama@acmetech.example',
    status: 'pending',
    requested_at: '2026-10-01T09:00:00',
    decided_at: null,
    ...over,
  });

  /**
   * Answers the two HTTP reads the screen makes.
   *
   * The access-request queue comes from the auth stub rather than from here: it is
   * that service's read, and `AuthService`'s own spec covers the request itself.
   */
  const settle = (options?: {
    documents?: string[];
    conversations?: { id: string; title: string | null; updated_at: string }[];
    documentsFail?: boolean;
  }): void => {
    const documents = http.expectOne(`${API_BASE_URL}/documents`);

    if (options?.documentsFail) {
      documents.flush('nope', { status: 500, statusText: 'Server Error' });
    } else {
      documents.flush(options?.documents ?? []);
    }

    http
      .expectOne((request) => request.url.startsWith(`${API_BASE_URL}/api/conversations?`))
      .flush({ conversations: options?.conversations ?? [] });
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AdminDashboardViewComponent],
      providers: [
        provideRouter([{ path: 'admin', component: AdminDashboardViewComponent }]),
        // The dashboard reads real endpoints now, so it needs an HttpClient behind a
        // testing backend rather than no client at all.
        provideHttpClient(),
        provideHttpClientTesting(),
        provideAuthStub(),
      ],
    }).compileComponents();

    auth = TestBed.inject(AuthServiceStub);
    http = TestBed.inject(HttpTestingController);
    auth.setRole('admin');

    fixture = TestBed.createComponent(AdminDashboardViewComponent);
  });

  /** Renders once, with the given loads answered. */
  const render = async (options?: Parameters<typeof settle>[0]): Promise<void> => {
    fixture.detectChanges();
    settle(options);
    fixture.detectChanges();
    await fixture.whenStable();
  };

  afterEach(() => http.verify());

  it('withholds the dashboard from somebody who is not an administrator', async () => {
    auth.setRole('employee');

    fixture.detectChanges();
    fixture.detectChanges();
    await fixture.whenStable();

    expect(element().querySelector('app-admin-access-required')).not.toBeNull();
    // Nothing is asked for either. A screen rendered for the wrong role should not
    // depend on the guard having run for its own correctness, and `http.verify` in
    // the afterEach is what proves no request was made.
  });

  it('counts the documents the backend says are indexed', async () => {
    await render({ documents: ['Leave Policy', 'Security Policy', 'Onboarding Policy'] });

    expect(text()).toContain('3');
    expect(text()).toContain('Available to answer from');
  });

  it('does not call an unbuilt corpus zero documents', async () => {
    await render({ documents: [] });

    // "0 documents" reads as a company with no policies, which is a very different
    // claim from an index that has not been built.
    expect(text()).toContain('Nothing indexed yet');
  });

  it('counts only the requests still waiting, since those are the ones needing a person', async () => {
    auth.setAccessRequests([
      request(),
      request({ id: 'r2', status: 'approved', decided_at: '2026-10-01T10:00:00' }),
      request({ id: 'r3', status: 'declined', decided_at: '2026-10-01T11:00:00' }),
    ]);

    await render();

    // One, not three. The other two are settled and nobody is waiting on them.
    expect(text()).toContain('1');
    expect(text()).toContain('Asked for an account');
  });

  it('says nobody is waiting when there is nobody, which is good news not a problem', async () => {
    auth.setAccessRequests([request({ status: 'approved', decided_at: '2026-10-01T10:00:00' })]);

    await render();

    expect(text()).toContain('Nobody is waiting');
  });

  it('lists a decided request as two events, so an approval has the ask attached', async () => {
    auth.setAccessRequests([
      request({
        name: 'Yaw Boateng',
        status: 'approved',
        requested_at: '2026-10-01T09:00:00',
        decided_at: '2026-10-01T10:00:00',
      }),
    ]);

    await render();

    expect(text()).toContain('Yaw Boateng');
    expect(text()).toContain('asked for access');
    expect(text()).toContain('was given access');
  });

  it('orders activity newest first across both sources', async () => {
    auth.setAccessRequests([request({ requested_at: '2026-09-01T09:00:00' })]);

    await render({
      conversations: [{ id: 'c1', title: 'Leave Policy', updated_at: '2026-10-02T09:00:00' }],
    });

    const rows = Array.from(element().querySelectorAll('li')).map((row) =>
      row.textContent?.replace(/\s+/g, ' ').trim(),
    );

    // One chronology rather than two lists: the reader should not have to work out
    // which of the rows is the more recent one themselves.
    expect(rows[0]).toContain('Leave Policy');
    expect(rows[1]).toContain('Ama Konadu');
  });

  it('explains an empty activity list rather than leaving a blank panel', async () => {
    await render({ documents: [], conversations: [] });

    // It has to say what will appear and where, or an empty list reads as a section
    // that failed to load rather than as a quiet week.
    expect(text()).toContain('Nothing yet');
    expect(text()).toContain('will show up here');
  });

  it('carries no refresh control, because arriving here already asked', async () => {
    await render({ documents: ['Leave Policy'], conversations: [] });

    // A refresh button whose only effect is to repeat the load this screen just did is
    // a control that looks like it answers a problem it cannot have.
    const labels = Array.from(element().querySelectorAll('button')).map((button) =>
      button.textContent?.trim(),
    );

    expect(labels).not.toContain('Refresh');
    expect(labels).not.toContain('Check again');
  });

  it('does not read an empty list as an error, which the shared empty state would', async () => {
    await render({ documents: [], conversations: [] });

    // Nothing has gone wrong here, so nothing is dressed as a failure and no
    // retry-in-disguise is the primary thing offered.
    expect(text()).not.toContain('Nothing has happened yet');
  });

  it('still shows what it could read when one source fails', async () => {
    auth.setAccessRequests([request({ name: 'Yaw Boateng' })]);

    await render({ documents: ['Leave Policy'], documentsFail: true });

    // A failed read costs its own rows, not the whole screen. The activity list is
    // still there, and the conversation that did load is still in it.
    expect(text()).toContain('Recent activity');
    expect(text()).toContain('Yaw Boateng');
  });

  it('carries no tab bar, because navigation is the sidebar alone', async () => {
    await render();

    // A tab bar here as well would mean two systems for one job, and the reader
    // would have no way to tell which of the two marks the current screen.
    expect(element().querySelector('nav[aria-label="Administration sections"]')).toBeNull();
  });

  it('does not show the indexing breakdown, which was derived from a placeholder list', async () => {
    await render({ documents: ['Leave Policy'] });

    // These figures counted rows in a hardcoded array. Left in place next to real
    // numbers they would be indistinguishable from them, and one of the two would be
    // an administrator making decisions on.
    expect(text()).not.toContain('still indexing');
    expect(text()).not.toContain('need attention');
    expect(text()).not.toContain('Knowledge base health');
    expect(text()).not.toContain('Manage documents');
  });
});