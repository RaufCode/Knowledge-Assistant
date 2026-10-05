import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * Three bubbles that rise and fade in sequence, which together read as something
 * working rather than something spinning.
 *
 * The three brand accents rather than one colour at three opacities. A single hue
 * fading in and out is a pulse, and a pulse is what a skeleton bar was already doing;
 * this needed to be distinguishable from that at a glance, and separate colours are
 * what make it so. At `size-1.5` they are small enough that the trio reads as one
 * mark rather than three.
 *
 * The whole class string per bubble, bound through `[class]` and nothing else.
 * Two reasons, and both have bitten: Tailwind can only generate classes it can find
 * written out in the source, so a colour assembled at runtime never exists; and a
 * static `class` attribute beside a `[class]` binding on the same element is
 * ambiguous enough that the colour can silently not apply at all.
 */
const SHAPE = 'thinking-bubble size-1.5 rounded-full motion-reduce:animate-none';

const BUBBLES: { classes: string; delay: number }[] = [
  { classes: `${SHAPE} bg-primary`, delay: 0 },
  { classes: `${SHAPE} bg-secondary`, delay: 180 },
  { classes: `${SHAPE} bg-success`, delay: 360 },
];

/**
 * The "the assistant is working" indicator.
 *
 * No spinner. A rotating arc says a fixed-length job is in progress, and the wait
 * here has no fixed length — it is however long the model thinks, which on a cold
 * backend is most of a minute. An arc that keeps going past any honest estimate is
 * the thing that makes a slow answer read as a hung one.
 *
 * Bubbles that rise and settle say the same thing without claiming to know how long
 * it will be.
 */
@Component({
  selector: 'app-loading-indicator',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'inline-flex items-center gap-2 text-sm text-muted-foreground' },
  template: `
    <span class="flex items-center gap-1" aria-hidden="true">
      @for (bubble of bubbles; track bubble.delay) {
        <span [class]="bubble.classes" [style.animation-delay.ms]="bubble.delay"></span>
      }
    </span>

    @if (label(); as text) {
      <span>{{ text }}</span>
    }
  `,
})
export class LoadingIndicatorComponent {
  /** Text shown beside the bubbles. Omit for none. */
  readonly label = input<string | undefined>('Thinking');

  /** The bubbles and the order they rise in. */
  protected readonly bubbles = BUBBLES;
}