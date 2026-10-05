import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { SourceReference } from '../../../../core/models/message.model';
import { IconComponent } from '../../../../shared/components/icon/icon.component';
import { markdownToSnippetHtml } from '../../../../shared/utils/markdown.util';

/**
 * The citation under an answer: which document and section it came from, and the
 * passage that backs it.
 *
 * There is no "view document" control, and that is deliberate rather than
 * unfinished. The backend serves no document bodies, so there is nothing to open
 * and a control that navigated nowhere would be a promise the app cannot keep.
 * The passage travels with the answer, so the citation is checkable as it stands.
 *
 * `score` is deliberately not rendered either: the API documents neither its
 * range nor its unit, so turning it into a percentage would be a guess presented
 * as a measurement.
 */
@Component({
  selector: 'app-source-tag',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'block max-w-full' },
  template: `
    <div
      class="flex w-full max-w-full items-start gap-1.5 rounded-md bg-secondary-soft px-2 py-1.5"
    >
      <app-icon name="file-text" [size]="12" class="mt-0.5 shrink-0 text-primary" />

      <div class="min-w-0 flex-1">
        <p class="truncate text-xs font-medium text-foreground" [title]="source().document">
          {{ label() }}
        </p>

        @if (snippetHtml(); as html) {
          <div
            class="citation-prose mt-0.5 line-clamp-3 text-xs leading-relaxed
              text-muted-foreground"
            [innerHTML]="html"
          ></div>
        }
      </div>
    </div>
  `,
})
export class SourceTagComponent {
  /** The citation to display. */
  readonly source = input.required<SourceReference>();

  /**
   * `Leave Policy · Section 4.2`, or just the document when the two are the same.
   *
   * The backend often cites a section under the document's own title, so the
   * naive join renders as `HR Contact & Directory · HR Contact & Directory` and
   * says nothing twice over.
   */
  protected readonly label = computed(() => {
    const source = this.source();

    if (!source.section || source.section === source.document) {
      return source.document;
    }

    return `${source.document} · ${source.section}`;
  });

  /**
   * The backing passage as inline HTML.
   *
   * The snippet is a slice of a markdown policy page, so it carries that page's
   * headings and emphasis. Structure is stripped and emphasis kept, because a
   * citation is two lines of context rather than a document in miniature.
   */
  protected readonly snippetHtml = computed(() => markdownToSnippetHtml(this.source().snippet));
}
