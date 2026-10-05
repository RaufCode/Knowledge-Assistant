import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  effect,
  input,
  model,
  output,
  signal,
  viewChild,
} from '@angular/core';

import {
  QUESTION_OUTCOME_LABELS,
  type QuestionLog,
  type QuestionOutcome,
} from '../../../../core/models/question-log.model';
import { SourceTagComponent } from '../../../response/components/source-tag/source-tag.component';
import { AvatarComponent } from '../../../../shared/components/avatar/avatar.component';
import { BadgeComponent, type BadgeTone } from '../../../../shared/components/badge/badge.component';
import { ButtonComponent } from '../../../../shared/components/button/button.component';
import { IconComponent } from '../../../../shared/components/icon/icon.component';
import { markdownToHtml } from '../../../../shared/utils/markdown.util';
import { formatRelativeTime } from '../../../../shared/utils/relative-time.util';

/** Colour per outcome, matching the badge in the list. */
const OUTCOME_TONES: Record<QuestionOutcome, BadgeTone> = {
  answered: 'info',
  'not-found': 'warning',
  failed: 'danger',
};

/**
 * One question log opened for reading: the whole question, what the asker was
 * shown, and the passages retrieval considered.
 *
 * The list deliberately truncates, because a log is scanned rather than read, so
 * without this an administrator can see that a question was asked and can never
 * find out why. The two failure modes are kept visibly distinct, because they call
 * for opposite responses: a `not-found` means the corpus is missing something, and
 * a `failed` means the assistant never got to answer and the corpus may be fine.
 *
 * It is a native `<dialog>` pinned to the right edge, so the list stays visible
 * behind it and an administrator can work down the log without going back.
 */
@Component({
  selector: 'app-question-log-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AvatarComponent, BadgeComponent, ButtonComponent, IconComponent, SourceTagComponent],
  host: { class: 'contents' },
  template: `
    <dialog
      #dialog
      class="ml-auto h-full max-h-none w-[min(100%,32rem)] max-w-none border-l border-border
        bg-card p-0 text-foreground shadow-raised backdrop:bg-foreground/40
        [&::backdrop]:bg-foreground/40"
      aria-labelledby="question-log-detail-title"
      (cancel)="onCancel($event)"
      (close)="onClose()"
    >
      @if (log(); as entry) {
        <div class="flex h-full flex-col">
          <header class="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
            <div class="flex min-w-0 flex-col gap-2">
              <app-badge [tone]="tones[entry.outcome]" class="self-start">
                {{ labels[entry.outcome] }}
              </app-badge>
              <h2
                id="question-log-detail-title"
                class="text-base font-semibold leading-snug text-foreground"
              >
                {{ entry.question }}
              </h2>
            </div>

            <button
              app-button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Close question log"
              (click)="close()"
            >
              <app-icon name="x" [size]="18" />
            </button>
          </header>

          <div class="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-5 py-4">
            <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <app-avatar [initials]="entry.askedByInitials" tone="muted" [size]="24" />
              <span>{{ entry.askedBy }}</span>
              <span aria-hidden="true">·</span>
              <span>{{ relativeTime(entry.createdAt) }}</span>
              <span aria-hidden="true">·</span>
              <span>{{ duration(entry.durationMs) }}</span>
            </div>

            <div class="mt-5 flex items-center justify-between gap-3">
              <h3 class="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {{ answerHeading(entry.outcome) }}
              </h3>

              <button
                app-button
                type="button"
                variant="ghost"
                size="sm"
                (click)="copyQuestion(entry)"
              >
                <app-icon name="copy" [size]="14" />
                <span>{{ copied() ? 'Copied' : 'Copy question' }}</span>
              </button>
            </div>

            @if (entry.answer; as answer) {
              <div
                class="answer-prose mt-2 text-sm leading-relaxed text-foreground"
                [innerHTML]="htmlFor(answer)"
              ></div>
            } @else {
              <!--
                Reached only by a failed request. A not-found keeps its explanation,
                because the assistant did answer, so this copy is reserved for the
                case where the asker saw an error and nothing was ever produced.
              -->
              <div
                class="mt-2 flex items-start gap-2 rounded-lg bg-danger/5 px-3 py-2.5 text-sm
                  text-muted-foreground"
              >
                <app-icon name="alert-triangle" [size]="16" class="mt-0.5 shrink-0 text-danger" />
                <p>
                  No answer was produced. The request gave up before the assistant replied, so
                  this says nothing about the documents. Check the backend logs for this time.
                </p>
              </div>
            }

            <h3
              class="mt-6 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
            >
              {{ sourceHeading(entry.outcome) }}
            </h3>

            @if (entry.sources.length > 0) {
              <div class="mt-2 flex flex-col gap-1.5">
                @for (source of entry.sources; track source.document + source.section) {
                  <app-source-tag [source]="source" />
                }
              </div>
            } @else {
              <p class="mt-2 text-sm text-muted-foreground">
                Nothing was retrieved for this question, so there is nothing to judge it against.
              </p>
            }
          </div>

          <!--
            The review actions a log implies, stated rather than offered. Marking a
            log reviewed or re-asking it would need somewhere to record the outcome,
            and neither exists yet, so a button here would be a control that silently
            does nothing.
          -->
          <p class="border-t border-border px-5 py-3 text-xs text-muted-foreground">
            Marking a log reviewed, and re-asking a question from here, are not connected yet.
          </p>
        </div>
      }
    </dialog>
  `,
})
export class QuestionLogDetailComponent {
  /** Whether a log is open. */
  readonly isOpen = model(false);

  /** The log being read, or null when the drawer is empty. */
  readonly log = input<QuestionLog | null>(null);

  /** Emitted once the drawer is dismissed, so the list can clear its selection. */
  readonly closed = output<void>();

  /** Labels for each outcome. */
  protected readonly labels = QUESTION_OUTCOME_LABELS;

  /** Colours for each outcome. */
  protected readonly tones = OUTCOME_TONES;

  /** True for a moment after the question is copied, to confirm it happened. */
  protected readonly copied = signal(false);

  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('dialog');

  constructor() {
    // The open state is the single source of truth; the native dialog follows it.
    // `showModal` is absent during server rendering, where there is no top layer to
    // move the dialog into.
    effect(() => {
      const open = this.isOpen();
      const element = this.dialog()?.nativeElement;
      if (!element || typeof element.showModal !== 'function') {
        return;
      }
      if (open && !element.open) {
        element.showModal();
      } else if (!open && element.open) {
        element.close();
      }
    });
  }

  /** Heading over the answer, which differs for a request that never produced one. */
  protected answerHeading(outcome: QuestionOutcome): string {
    return outcome === 'failed' ? 'What the asker saw' : 'Answer given';
  }

  /**
   * Heading over the passages.
   *
   * For a miss these are the near-misses, not the evidence behind an answer, and
   * calling them sources would overstate how close they were.
   */
  protected sourceHeading(outcome: QuestionOutcome): string {
    return outcome === 'answered' ? 'Sources' : 'Closest passages';
  }

  /** The stored answer, converted from markdown and sanitized on binding. */
  protected htmlFor(answer: string): string {
    return markdownToHtml(answer);
  }

  /** When a question was asked, as a reader would say it. */
  protected relativeTime(isoDate: string): string {
    return formatRelativeTime(isoDate);
  }

  /** How long the answer took, in seconds. */
  protected duration(milliseconds: number): string {
    return `${(milliseconds / 1000).toFixed(1)}s`;
  }

  /**
   * Copies the question so it can be pasted back into the app and reproduced.
   *
   * Real, unlike the review actions below it, because the clipboard needs no
   * server. Failure is left silent: a denied clipboard permission should not
   * interrupt reading a log.
   */
  protected copyQuestion(entry: QuestionLog): void {
    void navigator.clipboard?.writeText(entry.question).then(() => {
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 1500);
    });
  }

  /** Dismisses and closes. */
  protected close(): void {
    this.isOpen.set(false);
    this.closed.emit();
  }

  /** Intercepts Escape so the model stays in step with the dialog. */
  protected onCancel(event: Event): void {
    event.preventDefault();
    this.close();
  }

  /** Keeps the model closed if the dialog is dismissed another way. */
  protected onClose(): void {
    if (this.isOpen()) {
      this.isOpen.set(false);
      this.closed.emit();
    }
  }
}
