import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/** Surface the mark sits on, which decides its wordmark colours. */
export type BrandLogoTone = 'sidebar' | 'light';

/** Wordmark colours per surface. */
const WORDMARK_CLASSES: Record<BrandLogoTone, { name: string; qualifier: string }> = {
  sidebar: { name: 'text-sidebar-foreground', qualifier: 'text-sidebar-muted' },
  light: { name: 'text-primary', qualifier: 'text-secondary' },
};

/**
 * The product mark: an initials tile plus the two-line product name.
 */
@Component({
  selector: 'app-brand-logo',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex items-center gap-3' },
  template: `
    @if (showMark()) {
      <div
        class="flex shrink-0 items-center justify-center rounded-md bg-primary font-headings
          font-bold text-primary-foreground"
        [class]="sizeClasses()"
      >
        {{ mark() }}
      </div>
    }
    @if (showWordmark()) {
      <div class="flex min-w-0 flex-col leading-none" [class]="wordmarkAlignClasses()">
        <span class="truncate font-headings" [class]="nameClasses()">
          {{ productName() }}
        </span>
        <span class="truncate font-headings tracking-wide" [class]="qualifierClasses()">
          {{ productQualifier() }}
        </span>
      </div>
    }
  `,
})
export class BrandLogoComponent {
  /** Initials shown in the mark tile. */
  readonly mark = input('IK');

  /** First line of the wordmark. */
  readonly productName = input('Internal Knowledge');

  /** Second line of the wordmark. */
  readonly productQualifier = input('Assistant');

  /** Hides the wordmark, leaving the mark tile alone (icon rail). */
  readonly showWordmark = input(true);

  /** Hides the mark tile, leaving the wordmark alone (signed-out screens). */
  readonly showMark = input(true);

  /** Surface the mark sits on: the dark sidebar or a light page. */
  readonly tone = input<BrandLogoTone>('sidebar');

  /**
   * Centres the two wordmark lines against each other.
   *
   * On the signed-out screens the mark tile is gone, so the wordmark is the whole
   * logo and its lines are centred to match. Left alone it would sit flush against
   * the tile's edge, which is what the sidebar wants and not what these want.
   */
  readonly centered = input(false);

  /**
   * Sets the wordmark larger and heavier, for where it is the only logo on screen.
   *
   * The signed-out screens have no sidebar and no mark tile, so the wordmark is the
   * entire identity there and reads as an afterthought at the sidebar's compact
   * size. `text-xl` beats the size, and dropping the semibold weight on the first
   * line lets it be bold where it stands alone while leaving the sidebar as it is.
   */
  readonly prominent = input(false);

  /** Resolved utility classes for the mark tile. */
  protected sizeClasses(): string {
    return 'w-9 h-9 text-sm';
  }

  /** Alignment of the two wordmark lines, centred when asked for. */
  protected readonly wordmarkAlignClasses = computed(() =>
    this.centered() ? 'items-center text-center' : 'items-start text-left',
  );

  /**
   * Colour, size and weight of the first wordmark line.
   *
   * Size and weight travel together rather than as separate class bindings, because
   * they change as a pair: the sidebar's compact line is semibold, and where the
   * wordmark stands alone as the whole identity it is larger and bold.
   */
  protected readonly nameClasses = computed(() =>
    [
      WORDMARK_CLASSES[this.tone()].name,
      this.prominent() ? 'text-xl font-bold' : 'text-sm font-semibold',
    ].join(' '),
  );

  /** Colour, size and weight of the second wordmark line. */
  protected readonly qualifierClasses = computed(() =>
    [
      WORDMARK_CLASSES[this.tone()].qualifier,
      this.prominent() ? 'text-xl font-medium' : 'text-sm font-light',
    ].join(' '),
  );
}
