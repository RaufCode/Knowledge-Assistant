import { ChangeDetectionStrategy, Component } from '@angular/core';

/**
 * One placeholder bar, for a skeleton that is shaped like the thing it stands in for.
 *
 * A single primitive rather than a set of purpose-made skeletons, because a skeleton
 * that is not the shape of its real counterpart makes the page jump when the real
 * thing replaces it, and a shape lives in the markup of the thing being replaced —
 * not in a shared library that would have to be told about every new card.
 *
 * Sized entirely by the caller's utilities, so `class="h-3 w-2/5"` is the whole API.
 *
 * Hidden from assistive technology. The screen that owns the skeleton is expected to
 * say what is loading in a live region, once, rather than having a screen reader
 * announce a pile of empty boxes.
 */
@Component({
  selector: 'app-skeleton',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'block shrink-0 animate-pulse rounded bg-muted motion-reduce:animate-none',
  },
  template: '',
})
export class SkeletonComponent {}