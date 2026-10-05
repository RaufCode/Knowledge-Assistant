import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';

import { SourceReference } from '../../../../core/models/message.model';
import { IconComponent } from '../../../../shared/components/icon/icon.component';
import { markdownToSnippetHtml } from '../../../../shared/utils/markdown.util';

/** Roughly three lines of the citation's own small type. */
const CLAMPED_CHARS = 180;

/**
 * The citation under an answer: which document and section it came from, and the
 * passage that backs it.
 *
 * There is no "view document" control, and that is deliberate rather than
 * unfinished. The backend serves no document bodies, so there is nothing to open
 * and a control that navigated nowhere would be a promise the app cannot keep.
 * The passage travels with the answer, so the citation is checkable as it stands.
 *
 * `score` is deliberately not rendered: it is a retrieval internal on a scale the
 * API does not define. The confidence figure on the card is derived from those same
 * scores and is labelled as what it is, which is the honest way to show them.
 *
 * The surface is the card's own background with a border, not a tint. It was
 * `secondary-soft`, a pale orange, on the grounds that a reference should read as
 * belonging to the answer — but it made the references the only coloured thing in a
 * thread of white cards, so the eye went to the supporting evidence and away from the
 * answer it supports. A border separates them; colour would have to be earned.
 */
@Component({
  selector: 'app-source-tag',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'block max-w-full' },
  template: `
    <div
      class="flex w-full max-w-full items-start gap-2 rounded-md border border-border bg-card
        px-2.5 py-2"
    >
      <!--
        The number, so a passage in the answer can be pointed at rather than
        described. It sits outside the indented block so it lines up down the side
        however deep any one passage runs.
      -->
      @if (index(); as position) {
        <span
          class="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full
            bg-primary/15 text-[10px] font-semibold text-primary"
          [attr.aria-label]="'Source ' + position"
        >
          {{ position }}
        </span>
      }

      <app-icon name="file-text" [size]="12" class="mt-1 shrink-0 text-primary" />

      <div class="min-w-0 flex-1">
        @if (label(); as section) {
          <p class="truncate text-xs font-medium text-foreground">{{ section }}</p>
        }

        @if (snippetHtml(); as html) {
          <div
            class="citation-prose mt-0.5 text-xs leading-relaxed text-muted-foreground"
            [class.line-clamp-3]="!isExpanded()"
            [innerHTML]="html"
          ></div>
        }

        @if (canExpand()) {
          <button
            type="button"
            class="mt-1 text-[11px] font-medium text-primary hover:underline"
            [attr.aria-expanded]="isExpanded()"
            (click)="toggle()"
          >
            {{ isExpanded() ? 'Show less' : 'Show the whole passage' }}
          </button>
        }
      </div>
    </div>
  `,
})
export class SourceTagComponent {
  /** The citation to display. */
  readonly source = input.required<SourceReference>();

  /** Its position in the answer's reference list, from 1. Omit for none. */
  readonly index = input<number | undefined>(undefined);

  /**
   * Whether this passage names its own document.
   *
   * True by default, because a citation with no document on it is not a citation.
   * The answer card turns it off: it heads each group with the document's name, and
   * four passages from the Leave Policy each repeating "Leave Policy" says the same
   * thing four times over. A caller with no heading of its own — the administrator's
   * list of near-miss passages — leaves it on, and needs it.
   */
  readonly showDocument = input(true);

  private readonly expanded = signal(false);

  /** Whether the whole passage is showing rather than the first few lines. */
  protected readonly isExpanded = this.expanded.asReadonly();

  /**
   * What this passage is labelled with.
   *
   * With a document, `Leave Policy · Section 4.2`. Without one, just the section,
   * because the group heading above has already said which document this is and the
   * section is the only part that differs between passages of it.
   *
   * The document's own name is never repeated where the backend cites a section under
   * the document's title, which it often does: "HR Contact & Directory" as a section
   * of "HR Contact & Directory" adds nothing under a heading that already says it.
   */
  protected readonly label = computed(() => {
    const source = this.source();
    const hasSection = Boolean(source.section) && source.section !== source.document;

    if (!this.showDocument()) {
      return hasSection ? source.section : '';
    }

    return hasSection ? `${source.document} · ${source.section}` : source.document;
  });

  /** Long enough to be worth opening. Judged on length, which needs no measurement. */
  protected readonly canExpand = computed(() => this.source().snippet.length > CLAMPED_CHARS);

  /**
   * The backing passage as inline HTML.
   *
   * The snippet is a slice of a markdown policy page, so it carries that page's
   * headings and emphasis. Structure is stripped and emphasis kept, because a
   * citation is two lines of context rather than a document in miniature.
   */
  protected readonly snippetHtml = computed(() => markdownToSnippetHtml(this.source().snippet));

  protected toggle(): void {
    this.expanded.update((open) => !open);
  }
}