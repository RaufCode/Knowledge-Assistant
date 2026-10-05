import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

import {
  QUESTION_OUTCOME_LABELS,
  type QuestionLog,
  type QuestionOutcome,
} from '../../../../core/models/question-log.model';
import { AvatarComponent } from '../../../../shared/components/avatar/avatar.component';
import { BadgeComponent, type BadgeTone } from '../../../../shared/components/badge/badge.component';
import { formatRelativeTime } from '../../../../shared/utils/relative-time.util';

/** Colour per outcome, so a log can be skimmed for the ones that went wrong. */
const OUTCOME_TONES: Record<QuestionOutcome, BadgeTone> = {
  answered: 'info',
  'not-found': 'warning',
  failed: 'danger',
};

/**
 * Every question asked against the knowledge base, newest first, with how it was
 * resolved and which documents were used.
 *
 * Rows are buttons, not decorations: this is a review list, and the answer and
 * passages behind each entry live in a drawer the row opens.
 */
@Component({
  selector: 'app-question-log-table',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AvatarComponent, BadgeComponent],
  host: { class: 'block' },
  template: `
    <div class="overflow-hidden rounded-lg border border-border bg-card">
      @for (log of logs(); track log.id) {
        <!--
          The whole row is the control, so the button wraps it rather than sitting
          inside it: a nested control inside a row would give the same target two
          tab stops and an ambiguous role.
        -->
        <button
          type="button"
          class="flex w-full cursor-pointer items-start gap-3 border-b border-border px-4 py-3.5
            text-left transition-colors last:border-b-0 hover:bg-secondary-soft/60
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary
            focus-visible:ring-inset"
          [class.bg-danger/5]="log.outcome === 'failed'"
          [attr.aria-label]="'Open question log: ' + log.question"
          (click)="selected.emit(log)"
        >
          <app-avatar
            [initials]="log.askedByInitials"
            tone="muted"
            [size]="36"
            [label]="log.askedBy"
          />

          <div class="flex min-w-0 flex-1 flex-col gap-1.5">
            <p class="text-sm text-foreground">{{ log.question }}</p>
            <p class="text-xs text-muted-foreground">
              {{ log.askedBy }} · {{ relativeTime(log.createdAt) }} ·
              {{ sources(log.sources.length) }} · {{ duration(log.durationMs) }}
            </p>
          </div>

          <app-badge [tone]="tones[log.outcome]" class="shrink-0">
            {{ labels[log.outcome] }}
          </app-badge>
        </button>
      }
    </div>
  `,
})
export class QuestionLogTableComponent {
  /** The questions to list, in the order the view filtered them. */
  readonly logs = input.required<QuestionLog[]>();

  /** Emitted when a row is opened, carrying the log to read. */
  readonly selected = output<QuestionLog>();

  /** Labels for each outcome. */
  protected readonly labels = QUESTION_OUTCOME_LABELS;

  /** Colours for each outcome. */
  protected readonly tones = OUTCOME_TONES;

  /** When a question was asked, as a reader would say it. */
  protected relativeTime(isoDate: string): string {
    return formatRelativeTime(isoDate);
  }

  /** How many documents backed an answer. */
  protected sources(count: number): string {
    return count === 1 ? '1 source' : `${count} sources`;
  }

  /** How long the answer took, in seconds. */
  protected duration(milliseconds: number): string {
    return `${(milliseconds / 1000).toFixed(1)}s`;
  }
}
