import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import { MOCK_QUESTION_LOGS } from '../../core/data/mock-admin.data';
import {
  QUESTION_OUTCOME_LABELS,
  type QuestionLog,
  type QuestionOutcome,
} from '../../core/models/question-log.model';
import { AuthService } from '../../core/services/auth.service';
import { AdminAccessRequiredComponent } from '../../features/admin/components/admin-access-required/admin-access-required.component';
import { QuestionLogDetailComponent } from '../../features/admin/components/question-log-detail/question-log-detail.component';
import { QuestionLogTableComponent } from '../../features/admin/components/question-log-table/question-log-table.component';
import { ViewHeaderComponent } from '../../features/chat/components/view-header/view-header.component';
import { ButtonComponent } from '../../shared/components/button/button.component';
import { EmptyStateComponent } from '../../shared/components/empty-state/empty-state.component';
import { InputComponent } from '../../shared/components/input/input.component';

/** The outcome filters, with `all` standing for no filter. */
type OutcomeFilter = QuestionOutcome | 'all';

/** Filters offered above the log, in the order they are shown. */
const FILTERS: OutcomeFilter[] = ['all', 'answered', 'not-found', 'failed'];

/** Label for the filter that has no narrowing effect. */
const ALL_LABEL = 'All';

/**
 * Every question people have asked, with how each was resolved. The entries are
 * placeholders, but searching and filtering are real, so the empty state is
 * reachable without editing the file.
 */
@Component({
  selector: 'app-admin-question-logs-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AdminAccessRequiredComponent,
    ButtonComponent,
    EmptyStateComponent,
    InputComponent,
    QuestionLogDetailComponent,
    QuestionLogTableComponent,
    ViewHeaderComponent,
  ],
  host: { class: 'flex min-h-0 flex-1 flex-col' },
  template: `
    <app-view-header title="Question logs" />

    @if (auth.isAdmin()) {
      <div class="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:px-8">
        <div class="mx-auto w-full max-w-4xl">
          <div class="w-full sm:max-w-xs">
            <app-input
              [value]="search()"
              (valueChange)="search.set($event)"
              placeholder="Search questions"
              ariaLabel="Search questions"
              icon="search"
            />
          </div>

          <div
            class="mt-4 flex flex-wrap gap-1.5"
            role="group"
            aria-label="Filter questions by outcome"
          >
            @for (filter of filters; track filter) {
              <button
                type="button"
                class="cursor-pointer rounded-full border px-3 py-1 text-xs font-medium
                  transition-colors"
                [class]="filterClasses(filter)"
                [attr.aria-pressed]="outcome() === filter"
                (click)="outcome.set(filter)"
              >
                {{ filterLabel(filter) }}
              </button>
            }
          </div>

          @if (visibleLogs().length > 0) {
            <p class="mt-5 text-xs text-muted-foreground">{{ summary() }}</p>

            <div class="mt-2">
              <app-question-log-table [logs]="visibleLogs()" (selected)="openLog($event)" />
            </div>
          } @else {
            <div class="mt-5 rounded-lg border border-border bg-card py-6">
              <app-empty-state
                icon="message-square-text"
                [title]="emptyTitle()"
                [message]="emptyMessage()"
              >
                <button app-button type="button" variant="outline" (click)="resetFilters()">
                  Clear filters
                </button>
              </app-empty-state>
            </div>
          }
        </div>
      </div>
    } @else if (auth.lacksAdminAccess()) {
      <app-admin-access-required />
    }

    <!--
      Rendered outside the access branch so the drawer survives a role change or a
      filter change that empties the list: closing the browser tab is not how a
      dialog is dismissed, and a filter typed behind an open drawer must not strand
      the entry being read.
    -->
    <app-question-log-detail
      [isOpen]="openLogId() !== null"
      [log]="openLogEntry()"
      (closed)="closeLog()"
    />
  `,
})
export class AdminQuestionLogsViewComponent {
  /** Who is signed in, which decides whether this area is open at all. */
  protected readonly auth = inject(AuthService);

  /** Current search term. */
  protected readonly search = signal('');

  /** Outcome the log is narrowed to. */
  protected readonly outcome = signal<OutcomeFilter>('all');

  /**
   * Id of the log being read, or null when the drawer is closed.
   *
   * The id is held rather than the entry so the drawer survives a filter change:
   * searching behind an open drawer would otherwise blank what is being read.
   */
  private readonly openLogId = signal<string | null>(null);

  /** Filters offered above the log. */
  protected readonly filters = FILTERS;

  /** The questions left after searching and filtering. */
  protected readonly visibleLogs = computed<QuestionLog[]>(() => {
    const term = this.search().trim().toLowerCase();
    const outcome = this.outcome();
    const logs = MOCK_QUESTION_LOGS;

    return logs.filter((log) => {
      const matchesOutcome = outcome === 'all' || log.outcome === outcome;
      const matchesTerm =
        term === '' || `${log.question} ${log.askedBy}`.toLowerCase().includes(term);

      return matchesOutcome && matchesTerm;
    });
  });

  /** Heading of the empty state, which differs between "none" and "no match". */
  protected readonly emptyTitle = computed(() => {
    if (this.outcome() !== 'all') {
      return 'No questions with that outcome';
    }

    return this.search().trim() === '' ? 'No questions asked yet' : 'No questions match';
  });

  /** Supporting line for the empty state. */
  protected readonly emptyMessage = computed(() =>
    this.search().trim() === ''
      ? 'Once people start asking questions, the log fills in here.'
      : 'Try a different phrase, or clear the outcome filter.',
  );

  /** One line above the table, counting what is being shown. */
  protected readonly summary = computed(() => {
    const shown = this.visibleLogs().length;
    const total = MOCK_QUESTION_LOGS.length;

    return shown === total
      ? `${total} question${total === 1 ? '' : 's'}`
      : `${shown} of ${total} questions`;
  });

  /** Label for a filter chip. */
  protected filterLabel(filter: OutcomeFilter): string {
    return filter === 'all' ? ALL_LABEL : QUESTION_OUTCOME_LABELS[filter];
  }

  /** The log being read, looked up by id so a filter change cannot blank it. */
  protected readonly openLogEntry = computed<QuestionLog | null>(
    () => MOCK_QUESTION_LOGS.find((log) => log.id === this.openLogId()) ?? null,
  );

  /** Opens a log for reading. */
  protected openLog(log: QuestionLog): void {
    this.openLogId.set(log.id);
  }

  /** Closes the drawer. */
  protected closeLog(): void {
    this.openLogId.set(null);
  }

  /** Resets both filters, which is what the empty state's action does. */
  protected resetFilters(): void {
    this.search.set('');
    this.outcome.set('all');
  }

  /** Chip styling: the chosen filter is filled, the rest stay quiet. */
  protected filterClasses(filter: OutcomeFilter): string {
    return filter === this.outcome()
      ? 'border-primary bg-primary text-primary-foreground'
      : 'border-border bg-card text-muted-foreground hover:border-primary/30 hover:text-foreground';
  }
}
