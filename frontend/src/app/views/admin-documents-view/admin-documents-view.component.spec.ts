import { ComponentFixture, TestBed } from '@angular/core/testing';
import { vi } from 'vitest';

import { AuthServiceStub, provideAuthStub } from '../../core/testing/auth-service.stub';
import { AdminDocumentsViewComponent } from './admin-documents-view.component';

describe('AdminDocumentsViewComponent', () => {
  let fixture: ComponentFixture<AdminDocumentsViewComponent>;
  let auth: AuthServiceStub;

  const element = (): HTMLElement => fixture.nativeElement as HTMLElement;

  const render = async (): Promise<void> => {
    fixture.detectChanges();
    await fixture.whenStable();
  };

  /** Rows currently listed. */
  const rows = (): number => element().querySelectorAll('app-document-table > div > div').length;

  /** The inventory alone, so a message about a deleted document is not a row. */
  const tableText = (): string => element().querySelector('app-document-table')?.textContent ?? '';

  /** The delete control on a row. */
  const deleteControl = (): HTMLButtonElement =>
    element().querySelector<HTMLButtonElement>('button[aria-label^="Delete"]') as HTMLButtonElement;

  /** The confirming button in the dialog. */
  const confirmControl = (): HTMLButtonElement =>
    Array.from(
      element().querySelectorAll<HTMLButtonElement>('app-confirm-dialog dialog button'),
    ).find((button) => button.textContent?.trim() === 'Delete') as HTMLButtonElement;

  const typeSearch = (term: string): void => {
    const field = element().querySelector('app-input input') as HTMLInputElement;
    field.value = term;
    field.dispatchEvent(new Event('input'));
  };

  /**
   * Drops a file onto the upload panel, the way a person would.
   *
   * The event is built by hand because a file input's `files` list is read-only,
   * so there is no way to set one the way a picker would.
   */
  const chooseFile = (file: File): void => {
    const zone = element().querySelector('app-document-dropzone > div') as HTMLElement;
    const event = new Event('drop') as DragEvent;
    Object.defineProperty(event, 'dataTransfer', { value: { files: [file] } });
    zone.dispatchEvent(event);
  };

  /** Clicks a control inside the upload panel, found by its label. */
  const clickInDropzone = (label: string): void => {
    const button = Array.from(
      element().querySelectorAll<HTMLButtonElement>('app-document-dropzone button'),
    ).find((candidate) => candidate.textContent?.trim() === label) as HTMLButtonElement;
    button.click();
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AdminDocumentsViewComponent],
      // The role comes from the backend now, so a test supplies it rather than
      // flipping a switch inside the app.
      providers: [provideAuthStub()],
    }).compileComponents();

    fixture = TestBed.createComponent(AdminDocumentsViewComponent);
    auth = TestBed.inject(AuthServiceStub);
  });

  it('closes the area to an employee', async () => {
    auth.setRole('employee');
    await render();

    // The route is reachable by typing it, so the screen has to explain itself
    // rather than rely on the link in the sidebar being absent.
    expect(element().querySelector('app-admin-access-required')).toBeTruthy();
    expect(element().textContent).toContain('Administrators only');
    expect(element().querySelector('app-document-table')).toBeFalsy();
  });

  it('lists the inventory for an administrator', async () => {
    auth.setRole('admin');
    await render();

    expect(element().querySelector('app-admin-access-required')).toBeFalsy();
    expect(element().textContent).toContain('Employee Handbook 2026');
    expect(element().textContent).toContain('7 documents, 1 still indexing');
  });

  it('shows a running ingest as running rather than as a settled state', async () => {
    auth.setRole('admin');
    await render();

    // A file still being embedded is not "Indexed" and not a failure, and the
    // spinner is what tells an administrator to come back later.
    expect(tableText()).toContain('Processing');
    expect(element().querySelector('.animate-spin')).toBeTruthy();
  });

  it('offers a retry only on the row that failed', async () => {
    auth.setRole('admin');
    await render();

    // Named by the button's own label, so adding another row action later cannot
    // make this pass by counting the wrong buttons.
    const retry = element().querySelectorAll<HTMLButtonElement>('app-document-table button');

    expect(
      Array.from(retry).filter((button) => button.textContent?.trim() === 'Retry'),
    ).toHaveLength(1);
  });

  it('filters the inventory as the search term changes', async () => {
    auth.setRole('admin');
    await render();
    const before = rows();

    typeSearch('remote');
    await render();

    expect(rows()).toBeLessThan(before);
    expect(element().textContent).toContain('Remote Work Policy');
  });

  it('falls back to an empty state when nothing matches', async () => {
    auth.setRole('admin');
    await render();

    typeSearch('zzzz');
    await render();

    expect(element().textContent).toContain('No documents match your search');
    expect(element().querySelector('app-empty-state')).toBeTruthy();
  });

  it('only removes a document once the dialog is confirmed', async () => {
    auth.setRole('admin');
    await render();
    const before = rows();

    deleteControl().click();
    await render();

    // The dialog is the whole point: a delete that lands on the first click is one
    // stray click from losing a policy.
    expect(rows()).toBe(before);
    expect(element().querySelector('app-confirm-dialog')?.textContent).toContain(
      'Employee Handbook 2026',
    );

    confirmControl().click();
    await render();

    expect(rows()).toBe(before - 1);
    expect(tableText()).not.toContain('Employee Handbook 2026');
  });

  it('leaves the document in place when the dialog is dismissed', async () => {
    auth.setRole('admin');
    await render();
    const before = rows();

    deleteControl().click();
    await render();

    const cancel = Array.from(
      element().querySelectorAll<HTMLButtonElement>('app-confirm-dialog dialog button'),
    ).find((button) => button.textContent?.trim() === 'Cancel') as HTMLButtonElement;
    cancel.click();
    await render();

    expect(rows()).toBe(before);
  });

  it('says a delete only touched the preview list', async () => {
    auth.setRole('admin');
    await render();

    deleteControl().click();
    await render();
    confirmControl().click();
    await render();

    // Nothing was sent anywhere, so the message must not imply the knowledge base
    // has changed.
    expect(element().textContent).toContain('preview list only');
  });

  it('refuses a file the panel does not claim to support', async () => {
    auth.setRole('admin');
    await render();
    const before = rows();

    chooseFile(new File(['x'], 'payload.exe'));
    await render();

    // Rejected by extension, in the browser, before anything is read: the file is
    // named in the refusal so the reader knows which one was turned away.
    expect(rows()).toBe(before);
    expect(element().querySelector('app-document-dropzone')?.textContent).toContain('payload.exe');
  });

  it('says nothing was transmitted when a file is taken in', async () => {
    auth.setRole('admin');
    await render();

    // The preview runs on a clock, so it is run on a fake one: the bar is driven
    // by a timer, and waiting two real seconds to assert one message is a slow way
    // to learn something that is known the moment the file is emitted.
    vi.useFakeTimers();

    try {
      chooseFile(new File(['policy text'], 'Security Policy.pdf'));
      fixture.detectChanges();

      clickInDropzone('Upload');
      await vi.advanceTimersByTimeAsync(2000);
      fixture.detectChanges();
    } finally {
      vi.useRealTimers();
    }

    // The row appears, and the copy admits the bytes went nowhere rather than
    // claiming an upload that cannot have happened.
    expect(element().textContent).toContain('Security Policy.pdf');
    expect(element().textContent).toContain('nothing was transmitted');
  });
});
