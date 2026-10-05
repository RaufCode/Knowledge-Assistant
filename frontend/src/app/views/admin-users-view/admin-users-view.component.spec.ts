import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { API_BASE_URL } from '../../core/api.config';
import { AuthService } from '../../core/services/auth.service';
import { AdminUsersViewComponent } from './admin-users-view.component';

const USERS_URL = `${API_BASE_URL}/api/auth/users?page=1`;

/** One account, as the backend lists it. */
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

describe('AdminUsersViewComponent', () => {
  let fixture: ComponentFixture<AdminUsersViewComponent>;
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
    });

    it('asks for the first page on load', async () => {
      const request = http.expectOne(USERS_URL);

      expect(request.request.method).toBe('GET');
      request.flush({ users: USERS, total: 1, page: 1, page_size: 10, pages: 1 });
      await render();
    });

    it('puts both actions above the list, not below it', async () => {
      http.expectOne(USERS_URL).flush({
        users: USERS,
        total: 1,
        page: 1,
        page_size: 10,
        pages: 1,
      });
      await render();

      const add = button('Add a user');
      const requests = element().querySelector('a[href="/admin/access"]');

      expect(add).toBeTruthy();
      expect(requests).not.toBeNull();

      // Above: both must come before the first account in document order. A button
      // underneath the list is one a person has to scroll to find, which is the whole
      // reason they were moved.
      const firstAccount = Array.from(element().querySelectorAll('p')).find((node) =>
        node.textContent?.includes('ama@acmetech.example'),
      ) as HTMLElement;

      expect(firstAccount).toBeTruthy();

      const precedes = (node: Element): boolean =>
        (node.compareDocumentPosition(firstAccount) &
          Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

      expect(precedes(add)).toBe(true);
      expect(precedes(requests as Element)).toBe(true);
    });

    it('opens adding a user in a dialog, not in the page', async () => {
      http.expectOne(USERS_URL).flush({
        users: USERS,
        total: 1,
        page: 1,
        page_size: 10,
        pages: 1,
      });
      await render();

      // Closed to begin with: no form anywhere in the page.
      expect(element().querySelector('input#name, input[name="name"]')).toBeNull();

      button('Add a user').click();
      await render();

      // The distinction that matters, and the one that can be checked here: a form
      // written into the page is a descendant of the page's own scroll container,
      // while a form in a dialog is inside a <dialog> element the browser has lifted
      // into the top layer. `showModal` is absent from Karma's browser, so `open`
      // cannot be asserted — but containment can, and containment is what decides
      // whether this renders at the top of the page or over it.
      const scroll = element().querySelector('.scrollbar-thin') as HTMLElement;
      const form = element().querySelector('form') as HTMLFormElement;

      expect(form).not.toBeNull();
      expect(scroll.contains(form)).toBe(false);

      const dialog = form.closest('dialog');
      expect(dialog).not.toBeNull();
      expect(dialog?.textContent).toContain('Add a user');

      // And the page has not grown an add form of its own.
      expect(scroll.textContent).not.toContain('They can sign in as soon as');
    });

    it('offers a way back out of the add-user dialog', async () => {
      http.expectOne(USERS_URL).flush({
        users: USERS,
        total: 1,
        page: 1,
        page_size: 10,
        pages: 1,
      });
      await render();

      button('Add a user').click();
      await render();

      const dialog = (element().querySelector('form') as HTMLFormElement).closest(
        'dialog',
      ) as HTMLDialogElement;
      const back = Array.from(dialog.querySelectorAll('button')).find((candidate) =>
        candidate.textContent?.trim().includes('Go back'),
      ) as HTMLButtonElement;

      expect(back).toBeTruthy();

      // Typed into first, so the form is dirty and reopening it afterwards proves
      // something: a dialog that only hid kept its contents, which is how a
      // half-typed password ends up waiting for the next person to open it.
      const type = (index: number, value: string): void => {
        const field = element().querySelectorAll<HTMLInputElement>(
          'app-form-field input',
        )[index];
        field.value = value;
        field.dispatchEvent(new Event('input'));
        fixture.detectChanges();
      };

      type(0, 'Half typed');

      back.click();
      await render();

      button('Add a user').click();
      await render();

      const reopened = (
        (element().querySelector('form') as HTMLFormElement).closest('dialog') as HTMLDialogElement
      ).querySelector('input') as HTMLInputElement;

      expect(reopened.value).toBe('');
    });

    it('runs the full width of the page, like the bar above it', async () => {
      http.expectOne(USERS_URL).flush({
        users: USERS,
        total: 1,
        page: 1,
        page_size: 10,
        pages: 1,
      });
      await render();

      const scroll = element().querySelector('.scrollbar-thin') as HTMLElement;

      expect(scroll).not.toBeNull();
      expect(scroll.querySelector('.max-w-4xl')).toBeNull();
      expect(scroll.querySelector('.max-w-5xl')).toBeNull();
    });

    it('searches the page it is showing, and says that is all it searched', async () => {
      http.expectOne(USERS_URL).flush({
        users: USERS,
        total: 1,
        page: 1,
        page_size: 10,
        pages: 1,
      });
      await render();

      const field = element().querySelector('app-input input') as HTMLInputElement;

      field.value = 'nobody here';
      field.dispatchEvent(new Event('input'));
      await render();

      // The list is paged ten at a time by the backend, so this sees one page. Saying
      // so is the difference between a search and a filter that looks like one.
      expect(element().textContent).toContain('Search the database to look further');
      expect(element().textContent).not.toContain('ama@acmetech.example');
    });

    it('finds somebody by name or by address, in any case', async () => {
      http.expectOne(USERS_URL).flush({
        users: USERS,
        total: 1,
        page: 1,
        page_size: 10,
        pages: 1,
      });
      await render();

      const type = (value: string): void => {
        const field = element().querySelector('app-input input') as HTMLInputElement;
        field.value = value;
        field.dispatchEvent(new Event('input'));
        fixture.detectChanges();
      };

      type('ama');
      expect(element().textContent).toContain('ama@acmetech.example');

      type('KONADU');
      expect(element().textContent).toContain('ama@acmetech.example');
    });

    it('states an empty list plainly rather than as a failure', async () => {
      http.expectOne(USERS_URL).flush({
        users: [],
        total: 0,
        page: 1,
        page_size: 10,
        pages: 0,
      });
      await render();

      // "Could not load" is what a failure says. Saying it because nobody has an
      // account would tell an administrator the opposite of what is true.
      expect(element().textContent).toContain('There is no account yet');
      expect(element().textContent).not.toContain('Could not load the accounts');
    });
  });

  describe('as an employee', () => {
    beforeEach(async () => {
      await signedInAs('employee');
    });

    it('does not ask for the accounts', async () => {
      http.expectNone(USERS_URL);
      await render();

      expect(element().textContent).toContain('administrator');
    });
  });
});
