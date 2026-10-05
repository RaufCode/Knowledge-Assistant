import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import { MOCK_DOCUMENTS } from '../../core/data/mock-admin.data';
import type { PolicyDocument } from '../../core/models/document.model';
import { AuthService } from '../../core/services/auth.service';
import { AdminAccessRequiredComponent } from '../../features/admin/components/admin-access-required/admin-access-required.component';
import { DocumentDropzoneComponent } from '../../features/admin/components/document-dropzone/document-dropzone.component';
import { DocumentTableComponent } from '../../features/admin/components/document-table/document-table.component';
import { ViewHeaderComponent } from '../../features/chat/components/view-header/view-header.component';
import { ButtonComponent } from '../../shared/components/button/button.component';
import { ConfirmDialogComponent } from '../../shared/components/confirm-dialog/confirm-dialog.component';
import { EmptyStateComponent } from '../../shared/components/empty-state/empty-state.component';
import { IconComponent } from '../../shared/components/icon/icon.component';
import { InputComponent } from '../../shared/components/input/input.component';
import { ModalComponent } from '../../shared/components/modal/modal.component';
import { formatFileSize } from '../../shared/utils/file-size.util';

/**
 * The document inventory. Uploading and deleting are not connected to a server,
 * so both act on the placeholder list and say so, which is enough to review the
 * confirmation flow, the indexing state and the empty state.
 */
@Component({
  selector: 'app-admin-documents-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AdminAccessRequiredComponent,
    ButtonComponent,
    ConfirmDialogComponent,
    DocumentDropzoneComponent,
    DocumentTableComponent,
    EmptyStateComponent,
    IconComponent,
    InputComponent,
    ModalComponent,
    ViewHeaderComponent,
  ],
  host: { class: 'flex min-h-0 flex-1 flex-col' },
  template: `
    <app-view-header title="Documents" />

    @if (auth.isAdmin()) {
      <!--
        No max-width, for the same reason the dashboard has none: the header strip
        above spans the full content area, and a centred column under it leaves the
        title and the table it is about at two different widths.
      -->
      <div class="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:px-8">
        <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div class="w-full sm:max-w-xs">
            <app-input
              [value]="search()"
              (valueChange)="search.set($event)"
              placeholder="Search documents"
              ariaLabel="Search documents"
            />
          </div>

          <button
            app-button
            type="button"
            class="shrink-0"
            (click)="isUploadOpen.set(true)"
          >
            <app-icon name="upload" [size]="16" />
            <span>Upload document</span>
          </button>
        </div>

          @if (notice()) {
            <p
              class="mt-4 flex items-start gap-2 rounded-md bg-muted px-3 py-2 text-xs
                text-muted-foreground"
            >
              <app-icon name="info" [size]="14" class="mt-0.5 shrink-0" />
              <span>{{ notice() }}</span>
            </p>
          }

        @if (visibleDocuments().length > 0) {
          <p class="mt-5 text-xs text-muted-foreground">{{ summary() }}</p>

          <div class="mt-2">
            <app-document-table
              [documents]="visibleDocuments()"
              (deleteRequested)="askToDelete($event)"
              (retryRequested)="retry($event)"
              (renamed)="applyRename($event)"
            />
          </div>
        } @else {
          <div class="mt-5 rounded-lg border border-border bg-card py-6">
            <app-empty-state icon="file-plus" [title]="emptyTitle()" [message]="emptyMessage()">
              @if (search() === '') {
                <button app-button type="button" (click)="isUploadOpen.set(true)">
                  <app-icon name="upload" [size]="16" />
                  <span>Upload a document</span>
                </button>
              } @else {
                <button app-button type="button" variant="outline" (click)="search.set('')">
                  Clear search
                </button>
              }
            </app-empty-state>
          </div>
        }
      </div>

      <!--
        Uploading is a modal rather than a panel on the page.

        It is a short task with one outcome, and the person who came here to look at
        the inventory did not come to be interrupted by a drop target taking up the
        top third of it. The panel is also the only part of this screen that is not
        about what is already uploaded, so it is the one thing here that does not
        belong beside the table permanently.
      -->
      <app-modal
        title="Upload a document"
        message="The assistant answers from what it can read. PDF, DOCX and TXT are supported."
        icon="upload"
        [isOpen]="isUploadOpen()"
        (closed)="isUploadOpen.set(false)"
      >
        <app-document-dropzone (fileAccepted)="addDocument($event)" />
      </app-modal>

      <app-confirm-dialog
        [isOpen]="isDeleteOpen()"
        tone="danger"
        icon="trash-2"
        title="Delete this document?"
        [message]="deleteMessage()"
        confirmLabel="Delete"
        (confirmed)="deleteDocument()"
      />
    } @else {
      <app-admin-access-required />
    }
  `,
})
export class AdminDocumentsViewComponent {
  /** Who is signed in, which decides whether this area is open at all. */
  protected readonly auth = inject(AuthService);

  /** The placeholder inventory, copied so deletes only affect this screen. */
  private readonly documentsState = signal<PolicyDocument[]>([...MOCK_DOCUMENTS]);

  /** Whether the upload panel is open. */
  protected readonly isUploadOpen = signal(false);

  /** Current search term. */
  protected readonly search = signal('');

  /** Explanatory message shown after an action. */
  protected readonly notice = signal('');

  /** The document a delete is waiting on confirmation for. */
  private readonly deleteTarget = signal<PolicyDocument | null>(null);

  /** Whether the confirmation dialog is open. */
  protected readonly isDeleteOpen = computed(() => this.deleteTarget() !== null);

  /** The documents left after searching. */
  protected readonly visibleDocuments = computed(() => {
    const term = this.search().trim().toLowerCase();
    const documents = this.documentsState();

    if (term === '') {
      return documents;
    }

    return documents.filter((document) =>
      `${document.title} ${document.category}`.toLowerCase().includes(term),
    );
  });

  /** Heading of the empty state, which differs between "none" and "no match". */
  protected readonly emptyTitle = computed(() =>
    this.search().trim() === '' ? 'No documents yet' : 'No documents match your search',
  );

  /** Supporting line for the empty state. */
  protected readonly emptyMessage = computed(() =>
    this.search().trim() === ''
      ? 'Upload a policy document and the assistant will start answering from it.'
      : 'Try a different title or category.',
  );

  /**
   * One line above the table, counting what is listed and what is still running.
   *
   * Wording it as "showing N of M" keeps the searchable list honest when a search
   * narrows it, which a bare total would not.
   */
  protected readonly summary = computed(() => {
    const total = this.documentsState().length;
    const shown = this.visibleDocuments().length;
    const indexing = this.documentsState().filter(
      (document) => document.status === 'processing',
    ).length;

    const count =
      shown === total
        ? `Showing ${total} document${total === 1 ? '' : 's'}`
        : `Showing ${shown} of ${total} documents`;

    return indexing === 0 ? `${count}, all indexed` : `${count}, ${indexing} still indexing`;
  });

  /** What the confirmation dialog is about to do. */
  protected readonly deleteMessage = computed(() => {
    const target = this.deleteTarget();

    return target
      ? `${target.title} will be removed from the knowledge base. Answers that cited it lose that source.`
      : '';
  });

  /** Opens the confirmation dialog for a document. */
  protected askToDelete(document: PolicyDocument): void {
    this.notice.set('');
    this.deleteTarget.set(document);
  }

  /** Removes the confirmed document from the placeholder list. */
  protected deleteDocument(): void {
    const target = this.deleteTarget();
    this.deleteTarget.set(null);

    if (!target) {
      return;
    }

    this.documentsState.update((documents) =>
      documents.filter((document) => document.id !== target.id),
    );
    this.notice.set(`${target.title} was removed from the preview list only.`);
  }

  /** Marks a failed document as indexed again. */
  protected retry(document: PolicyDocument): void {
    this.documentsState.update((documents) =>
      documents.map((candidate) =>
        candidate.id === document.id ? { ...candidate, status: 'indexed' as const } : candidate,
      ),
    );
    this.notice.set(`${document.title} was re-indexed in the preview list only.`);
  }

  /**
   * Adds the chosen file to the preview list, as a document still being indexed.
   *
   * The file's own name and size are used, so the row is the file. It arrives as
   * processing rather than indexed because that is the state an upload passes
   * through, and the notice says where the bytes went: nowhere.
   */
  protected addDocument(file: File): void {
    const now = new Date().toISOString();


    this.documentsState.update((documents) => [
      {
        id: `doc-upload-${documents.length + 1}`,
        title: file.name,
        category: 'Uncategorised',
        status: 'processing' as const,
        sizeLabel: formatFileSize(file.size),
        sectionCount: 0,
        uploadedAt: now,
        updatedAt: now,
        updatedBy: this.auth.user()?.name ?? '',
      },
      ...documents,
    ]);
    this.notice.set(
      `${file.name} was added to the preview list only: uploads are not connected to a server, so nothing was transmitted.`,
    );

    // Closed on the way out: the row is on the page behind it, and leaving a modal
    // open over the thing it just changed hides the result of the action.
    this.isUploadOpen.set(false);
  }

  /**
   * Applies a new title to a document in the preview list.
   *
   * Real, because the title is the only part of a document an administrator can
   * change without a file, and a control that could not do it would be decoration.
   */
  protected applyRename(change: { document: PolicyDocument; title: string }): void {
    this.documentsState.update((documents) =>
      documents.map((candidate) =>
        candidate.id === change.document.id
          ? { ...candidate, title: change.title, updatedAt: new Date().toISOString() }
          : candidate,
      ),
    );
    this.notice.set(`${change.document.title} was renamed in the preview list only.`);
  }
}
