import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';

import { Message, SourceReference } from '../../../../core/models/message.model';
import { COPY_FEEDBACK_MS } from '../../../../shared/utils/constants';
import { markdownToHtml } from '../../../../shared/utils/markdown.util';
import { ButtonComponent } from '../../../../shared/components/button/button.component';
import { IconComponent } from '../../../../shared/components/icon/icon.component';
import { SourceTagComponent } from '../source-tag/source-tag.component';

/** One citation, with a stable key for list tracking and its place in the list. */
interface Citation extends SourceReference {
  key: string;
  /** 1-based, running across every group rather than restarting in each. */
  position: number;
}

/** The citations that came from one document, in the order they were cited. */
interface CitationGroup {
  document: string;
  citations: Citation[];
}

/** The scale the backend reports confidence on. Mirrored so the two cannot drift. */
const CONFIDENCE_MAX = 10;

/**
 * What the figure is, on hover.
 *
 * Worth saying out loud, because "Confidence: 5/10" invites the reading that the
 * answer is half wrong. It is not a probability: it is how closely the indexed
 * passages matched the question, and this corpus puts a lot of good answers in the
 * middle of the range.
 */
const CONFIDENCE_EXPLANATION =
  'How closely the indexed passages matched your question, from 1 to 10. ' +
  'It is not a probability that the answer is correct, and it reads lower than you ' +
  'might expect: a clear policy question often matches in the middle of the range.';

/**
 * A grounded answer: the answer text and its citations. Copy sits in the top
 * right corner and stays out of the way until the answer is hovered or the
 * control itself is focused, so the answer text carries the whole card.
 *
 * While the answer is streaming the card shows a caret at the end of the text, and
 * only then: the copy control is hidden, so the right padding that keeps the last
 * line clear of it is not reserved either, which is what lets the caret sit against
 * the final character rather than 64px away from it.
 */
@Component({
  selector: 'app-answer-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, IconComponent, SourceTagComponent],
  host: { class: 'group block' },
  template: `
    <div
      class="relative rounded-lg rounded-tl-sm border border-border bg-card px-5 py-4 shadow-card"
    >
      <button
        app-button
        type="button"
        variant="ghost"
        size="xs"
        class="absolute top-2 right-2 opacity-0 transition-opacity group-hover:opacity-100
          focus-visible:opacity-100"
        [style.opacity]="hasCopied() ? 1 : null"
        [hidden]="isStreaming()"
        (click)="copy()"
      >
        <app-icon [name]="hasCopied() ? 'check' : 'copy'" [size]="12" />
        {{ hasCopied() ? 'Copied' : 'Copy' }}
      </button>

      <!--
        The typing cursor is this element's is-streaming class rather than a node
        after the text: the prose is one block of innerHTML, so anything placed after
        it is a sibling of the whole answer and draws below the last line instead of
        beside the last character. The rule lives in the stylesheet, keyed on the
        last child's after pseudo-element, which puts the caret at the end of the
        final line and guarantees there is only ever one of it. Nothing about it
        touches the message.
      -->
      <div
        class="answer-prose text-sm leading-relaxed text-foreground"
        [class.is-streaming]="isStreaming()"
        [class.pr-16]="!isStreaming()"
        [innerHTML]="html()"
      ></div>

      @if (grounding(); as summary) {
        <p class="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
          <app-icon name="shield-check" [size]="12" class="shrink-0 text-success" />
          {{ summary }}
        </p>
      }

      <!--
        Rendered on the same condition as the citations and for the same reason: the
        confidence describes the finished answer and the passages behind it, so
        showing it while text is still arriving would be scoring an answer that does
        not exist yet.
      -->
      @if (confidence(); as score) {
        <p
          class="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground"
          [title]="CONFIDENCE_EXPLANATION"
        >
          <app-icon name="gauge" [size]="12" class="shrink-0 text-muted-foreground" />
          Confidence: {{ score }}/{{ CONFIDENCE_MAX }}
        </p>
      }

      @if (sourceGroups().length > 0) {
        <!--
          The references, grouped by document and numbered.

          Grouped because retrieval usually returns several passages from the same
          policy — four chunks of the Leave Policy for one question about leave — and
          as a flat list each of them repeated "Leave Policy" in full. Four rows saying
          the same thing buries the sections, which are the only part that differs.

          Numbered so a reader can point at "source 2" rather than describing it, and
          so the numbering runs down the side of the group instead of restarting in
          every document.
        -->
        <div class="mt-3 flex flex-col gap-3">
          @for (group of sourceGroups(); track group.document) {
            <div class="flex flex-col gap-1.5">
              <p class="flex items-center gap-1.5 text-xs font-medium text-foreground">
                <app-icon name="file-text" [size]="12" class="shrink-0 text-muted-foreground" />
                {{ group.document }}
              </p>

              @for (citation of group.citations; track citation.key) {
                <app-source-tag
                  [source]="citation"
                  [index]="citation.position"
                  [showDocument]="false"
                />
              }
            </div>
          }
        </div>
      }
    </div>
  `,
})
export class AnswerCardComponent {
  private readonly destroyRef = inject(DestroyRef);

  /** The scale the figure is reported on. */
  protected readonly CONFIDENCE_MAX = CONFIDENCE_MAX;

  /** Hover text for the confidence line. */
  protected readonly CONFIDENCE_EXPLANATION = CONFIDENCE_EXPLANATION;

  /** The answer turn to render. */
  readonly message = input.required<Message>();

  /**
   * True while the answer is still arriving.
   *
   * Suppresses the copy control, which would otherwise copy a half-written answer,
   * and shows a caret so it is visible that the text is still being written.
   */
  readonly isStreaming = input(false);

  /**
   * The answer, converted from markdown.
   *
   * Bound as HTML so bold labels, lists and tables render as themselves instead
   * of showing their markers. The conversion escapes the source before emitting
   * any tag, and Angular still sanitizes the bound string, so nothing the
   * assistant returns can introduce markup of its own.
   */
  protected readonly html = computed(() => markdownToHtml(this.message().text));

  /** True for a moment after the answer text is copied. */
  protected readonly hasCopied = signal(false);

  /**
   * The answer's citations, each with a stable list key.
   *
   * Two citations of the same section are keyed apart by their position, because
   * the backend returns no id and the same document and section can legitimately
   * be cited twice with different passages.
   *
   * Nothing is cited while the answer is still arriving. Citations belong to the
   * finished answer and are rendered last, from the stream's closing event: the
   * text can still be replaced by a refusal that is grounded in nothing, and a
   * citation list sitting above an answer that turns into one is a claim the app
   * would have to take back.
   */
  protected readonly citations = computed<Citation[]>(() =>
    this.isStreaming()
      ? []
      : this.message().sources.map((source, index) => ({
          ...source,
          key: `${source.document}-${source.section}-${index}`,
          position: index + 1,
        })),
  );

  /**
   * The citations, grouped by the document they came from.
   *
   * Group order is first appearance, so the document that contributed the opening of
   * the answer leads. Within a group the retrieval order is kept, which is the order
   * the passages were strongest in.
   */
  protected readonly sourceGroups = computed<CitationGroup[]>(() => {
    const groups = new Map<string, Citation[]>();

    for (const citation of this.citations()) {
      const existing = groups.get(citation.document);
      groups.set(citation.document, existing ? [...existing, citation] : [citation]);
    }

    return Array.from(groups, ([document, citations]) => ({ document, citations }));
  });

  /**
   * `Grounded in 4 documents`, counted from the answer's own citations.
   *
   * Distinct documents rather than citations, so one heavily quoted policy is not
   * reported as several. Null when nothing was cited, which is the case the
   * not-found card already covers, and while the answer is still streaming.
   */
  protected readonly grounding = computed(() => {
    const count = this.isStreaming() ? 0 : this.message().documentCount;

    if (count === 0) {
      return null;
    }

    return `Grounded in ${count} ${count === 1 ? 'document' : 'documents'}`;
  });

  /**
   * The confidence figure, or nothing while the answer is still arriving.
   *
   * Null for a greeting, a refusal and a gap in the corpus, none of which were built
   * from passages — there is nothing there to have been confident about, and a
   * number would imply otherwise.
   */
  protected readonly confidence = computed(() =>
    this.isStreaming() ? null : this.message().confidence,
  );

  private copyTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    this.destroyRef.onDestroy(() => clearTimeout(this.copyTimer));
  }

  /** Copies the answer text. Stays silent if clipboard access is denied. */
  protected async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.message().text);
      this.flagCopied();
    } catch {
      // Clipboard access can be denied; the answer is still selectable.
    }
  }

  /** Briefly shows the copied state, then restores the label. */
  private flagCopied(): void {
    this.hasCopied.set(true);
    clearTimeout(this.copyTimer);
    this.copyTimer = setTimeout(() => this.hasCopied.set(false), COPY_FEEDBACK_MS);
  }
}
