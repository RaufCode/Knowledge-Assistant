import { ChangeDetectionStrategy, Component } from '@angular/core';

import { SkeletonComponent } from '../../../../shared/components/skeleton/skeleton.component';

/**
 * The placeholder shown while an answer is still being retrieved.
 *
 * A skeleton rather than a spinner, and deliberately not the assistant avatar. A
 * first answer can take most of a minute on the free backend tier, and a spinning
 * avatar beside a caption reads as "something small is happening" for that whole
 * minute. Skeleton bars shaped like the answer card that is about to arrive instead
 * show what is coming and hold their layout, so nothing jumps when the real card
 * replaces them.
 *
 * Every measurement here is taken from `AnswerCardComponent` — the same padding, the
 * same `rounded-tl-sm` corner, a prose line at `text-sm leading-relaxed`, then the
 * grounding line and the citation rows. A skeleton is only worth having if it is the
 * shape of what replaces it, and a bar that is 40% wide where the real card has no
 * such bar is the skeleton actively lying about the layout.
 */
@Component({
  selector: 'app-answer-pending',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [SkeletonComponent],
  host: { class: 'block' },
  template: `
    <div
      class="rounded-lg rounded-tl-sm border border-border bg-card px-5 py-4 shadow-card"
      aria-hidden="true"
    >
      <!--
        The prose block. Three lines because that is how long the answers here tend to
        be, and a card that is 40% shorter than the one replacing it moves the page.
      -->
      <app-skeleton class="h-3.5 w-full" />
      <app-skeleton class="mt-2 h-3.5 w-11/12" />
      <app-skeleton class="mt-2 h-3.5 w-3/5" />

      <!--
        The grounding line, which answers carry below the prose. It sits at the same
        distance as the real one so the citations below it do not move up when the
        answer replaces this.
      -->
      <div class="mt-2.5 flex items-center gap-1.5">
        <span class="size-3 shrink-0 rounded-full bg-success/30"></span>
        <app-skeleton class="h-2.5 w-36" />
      </div>

      <!--
        Citation rows, at the real row's height: a two-line snippet is what a cited
        source actually shows, and a single-line placeholder would collapse the gap
        the citations leave behind them.
      -->
      <div class="mt-3 flex flex-col gap-2">
        <div class="flex items-start gap-1.5 rounded-md bg-secondary-soft px-2 py-1.5">
          <span class="mt-0.5 size-3 shrink-0 rounded bg-primary/30"></span>
          <div class="min-w-0 flex-1">
            <app-skeleton class="h-2.5 w-1/3" />
            <app-skeleton class="mt-1.5 h-2 w-full" />
            <app-skeleton class="mt-1.5 h-2 w-2/3" />
          </div>
        </div>

        <div class="flex items-start gap-1.5 rounded-md bg-secondary-soft px-2 py-1.5">
          <span class="mt-0.5 size-3 shrink-0 rounded bg-primary/30"></span>
          <div class="min-w-0 flex-1">
            <app-skeleton class="h-2.5 w-1/4" />
            <app-skeleton class="mt-1.5 h-2 w-5/6" />
          </div>
        </div>
      </div>
    </div>

    <span class="sr-only">Searching the company documents.</span>
  `,
})
export class AnswerPendingComponent {}