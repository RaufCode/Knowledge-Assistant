import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  signal,
} from '@angular/core';

import {
  DOCUMENT_STATUS_LABELS,
  type PolicyDocument,
} from '../../../../core/models/document.model';
import { BadgeComponent } from '../../../../shared/components/badge/badge.component';
import { ButtonComponent } from '../../../../shared/components/button/button.component';
import { IconComponent } from '../../../../shared/components/icon/icon.component';
import { ModalComponent } from '../../../../shared/components/modal/modal.component';
import { formatAbsoluteDate, formatRelativeTime } from '../../../../shared/utils/relative-time.util';

/**
 * The document inventory, one row per file.
 *
 * A file that is still being indexed shows a spinner rather than a badge, so a
 * running ingest reads as running; one that failed keeps its failure visible and
 * offers a retry, because that is the row an administrator is looking for.
 *
 * Each row can be renamed, in a dialog rather than in the row. That is real rather
 * than decorative: the name is what the assistant cites the document as, so it is
 * editable and saved. It used to be an inline field in the row, which meant the
 * document's own name disappeared from the screen at the moment it was being
 * changed, along with the category and section count next to it.
 */
@Component({
  selector: 'app-document-table',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BadgeComponent, ButtonComponent, IconComponent, ModalComponent],
  host: { class: 'block' },
  template: `
    <div class="overflow-hidden rounded-lg border border-border bg-card">
      @for (document of documents(); track document.id) {
        <div class="flex items-start gap-3 border-b border-border px-4 py-3.5 last:border-b-0">
          <span
            class="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-md bg-muted
              text-muted-foreground"
          >
            <app-icon name="file-text" [size]="16" />
          </span>

          <div class="flex min-w-0 flex-1 flex-col gap-1">
            <div class="flex min-w-0 flex-wrap items-center gap-2">
              <span class="truncate text-sm font-medium text-foreground">{{
                document.title
              }}</span>

              @switch (document.status) {
                @case ('processing') {
                  <span class="flex shrink-0 items-center gap-1.5 text-xs font-medium text-warning">
                    <app-icon name="loader-2" [size]="12" class="animate-spin" />
                    {{ statusLabels.processing }}
                  </span>
                }
                @case ('failed') {
                  <app-badge tone="danger">{{ statusLabels.failed }}</app-badge>
                }
                @default {
                  <app-badge tone="info">{{ statusLabels.indexed }}</app-badge>
                }
              }
            </div>

            <p class="text-xs text-muted-foreground">
              {{ document.category }} · {{ document.sizeLabel }} ·
              {{ document.sectionCount }}
              {{ document.sectionCount === 1 ? 'section' : 'sections' }} · updated
              {{ relativeTime(document.updatedAt) }} by {{ document.updatedBy }}
            </p>
          </div>

          <!--
            Kept out of the metadata line and given its own column, because the
            upload date answers a different question from "updated 2 days ago":
            one says when the file arrived, the other says when it was last
            touched, and collapsing them loses the first.
          -->
          <p class="hidden w-24 shrink-0 text-xs text-muted-foreground sm:block">
            {{ uploadDate(document.uploadedAt) }}
          </p>

          <div class="flex shrink-0 items-center gap-1">
            @if (document.status === 'failed') {
              <button
                app-button
                type="button"
                variant="ghost"
                size="sm"
                (click)="retryRequested.emit(document)"
              >
                <app-icon name="refresh-cw" [size]="14" />
                <span>Retry</span>
              </button>
            }

            <button
              app-button
              type="button"
              variant="ghost"
              tone="light"
              size="icon-sm"
              class="text-muted-foreground hover:text-primary"
              [attr.aria-label]="'Rename ' + document.title"
              (click)="openRename(document)"
            >
              <app-icon name="pencil" [size]="15" />
            </button>

            <button
              app-button
              type="button"
              variant="ghost"
              tone="light"
              size="icon-sm"
              class="text-muted-foreground hover:text-danger"
              [attr.aria-label]="'Delete ' + document.title"
              (click)="deleteRequested.emit(document)"
            >
              <app-icon name="trash-2" [size]="15" />
            </button>
          </div>
        </div>
      }
    </div>

    <!--
      The rename dialog.

      A modal rather than an inline field in the row, for one reason that inline
      renaming gets wrong: the title is the thing that identifies a document, and
      replacing it with a text box removes the document's own name from the screen
      while it is being changed. Everything needed to check the edit — the category,
      the section count, who last touched it — is on the row behind, and a dialog
      leaves all of it visible while the new title is typed.

      It also matches the credentials dialog, so "a modal" means one thing in this
      app rather than being a different shape on every screen that edits something.
    -->
    <app-modal
      [isOpen]="renamingId() !== null"
      [title]="'Rename document'"
      [message]="
        renamingId() !== null
          ? 'The new name is what the assistant cites this document as.'
          : ''
      "
      icon="pencil"
      (closed)="closeRename()"
    >
      <label class="block text-sm font-medium text-foreground" [attr.for]="renameFieldId">
        Document name
      </label>

      <input
        #renameField
        [id]="renameFieldId"
        type="text"
        class="mt-1.5 w-full rounded-md border border-border bg-background px-3 py-2 text-sm
          text-foreground outline-none focus:border-primary"
        [value]="renameDraft()"
        maxlength="120"
        (input)="onDraft($event)"
        (keydown.enter)="commitRename()"
      />

      @if (draftTooLong()) {
        <p class="mt-1.5 text-xs text-danger">
          Use at most {{ MAX_DOCUMENT_TITLE_LENGTH }} characters.
        </p>
      }

      <div modalFooter class="flex justify-end gap-2">
        <button app-button type="button" variant="ghost" (click)="closeRename()">Cancel</button>
        <button app-button type="button" [disabled]="!canSave()" (click)="commitRename()">
          Save name
        </button>
      </div>
    </app-modal>
  `,
})
export class DocumentTableComponent {
  /** The documents to list, in the order the view filtered them. */
  readonly documents = input.required<PolicyDocument[]>();

  /** Emits the document an administrator asked to delete. */
  readonly deleteRequested = output<PolicyDocument>();

  /** Emits the document whose ingest should be run again. */
  readonly retryRequested = output<PolicyDocument>();

  /** Emits a document under a new title. */
  readonly renamed = output<{ document: PolicyDocument; title: string }>();

  /** The row whose title is being edited, or null when the dialog is closed. */
  protected readonly renamingId = signal<string | null>(null);

  /** The name being typed, which starts as the document's own. */
  protected readonly renameDraft = signal('');

  /** The longest name the backend will store, mirrored so the field refuses it first. */
  protected readonly MAX_DOCUMENT_TITLE_LENGTH = 120;

  /** Unique per table, so the label points at this field and no other. */
  protected readonly renameFieldId = `document-rename-${nextId()}`;

  /** Over the limit the backend would refuse. */
  protected readonly draftTooLong = computed(
    () => this.renameDraft().trim().length > this.MAX_DOCUMENT_TITLE_LENGTH,
  );

  /** Whether there is anything worth saving. */
  protected readonly canSave = computed(() => {
    const title = this.renameDraft().trim();
    const current = this.documentBeingRenamed()?.title ?? '';

    return title !== '' && title !== current && !this.draftTooLong();
  });

  /** The document the dialog is open for, or null. */
  private readonly documentBeingRenamed = computed(
    () => this.documents().find((document) => document.id === this.renamingId()) ?? null,
  );

  /** Labels for each ingestion state. */
  protected readonly statusLabels = DOCUMENT_STATUS_LABELS;

  /** When a document was last touched, as a reader would say it. */
  protected relativeTime(isoDate: string): string {
    return formatRelativeTime(isoDate);
  }

  /** The day a document arrived. */
  protected uploadDate(isoDate: string): string {
    return formatAbsoluteDate(isoDate);
  }

  /**
   * Opens the dialog for one document, starting from its current name.
   *
   * One at a time, deliberately: two open dialogs would be two stacks, and the
   * second would be on top of the first with no way to tell which document each is
   * renaming.
   */
  protected openRename(document: PolicyDocument): void {
    this.renameDraft.set(document.title);
    this.renamingId.set(document.id);
  }

  /** Closes the dialog without changing anything. */
  protected closeRename(): void {
    this.renamingId.set(null);
    this.renameDraft.set('');
  }

  protected onDraft(event: Event): void {
    this.renameDraft.set((event.target as HTMLInputElement).value);
  }

  /**
   * Accepts the new name, and refuses the two edits that are not changes.
   *
   * An empty name would leave a document the assistant cannot cite by anything, and
   * re-saving the name it already has is a no-op that should not look like a change.
   * Both close the dialog without emitting, so the dialog is never a trap.
   */
  protected commitRename(): void {
    const document = this.documentBeingRenamed();

    if (document === null || !this.canSave()) {
      this.closeRename();

      return;
    }

    const title = this.renameDraft().trim();
    this.closeRename();
    this.renamed.emit({ document, title });
  }
}

/** A counter behind the generated ids, so two tables on a page do not collide. */
let idCounter = 0;

function nextId(): number {
  idCounter += 1;

  return idCounter;
}
