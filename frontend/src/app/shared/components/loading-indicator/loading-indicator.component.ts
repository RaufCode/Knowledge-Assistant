import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { IconComponent } from '../icon/icon.component';

/**
 * Three dots with descending opacity and staggered delays, which together read
 * as a travelling pulse. Class strings are written out in full so Tailwind can
 * see every utility.
 */
const DOTS: string[] = [
  'size-1.5 rounded-full bg-primary opacity-100',
  'size-1.5 rounded-full bg-primary opacity-60',
  'size-1.5 rounded-full bg-primary opacity-30',
];

/**
 * The "AI is searching" indicator shown while an answer is being generated.
 * Also used wherever a list is loading for the first time.
 */
@Component({
  selector: 'app-loading-indicator',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: {
    class: 'inline-flex items-center gap-3 text-sm text-muted-foreground',
  },
  template: `
    <app-icon name="loader-2" [size]="16" class="animate-spin motion-reduce:animate-none" />
    <span>{{ label() }}</span>
    @if (showDots()) {
      <span class="flex gap-1" aria-hidden="true">
        @for (dot of dots; track $index) {
          <span
            [class]="dot"
            [style.animation-delay.ms]="$index * 160"
            class="animate-pulse motion-reduce:animate-none"
          ></span>
        }
      </span>
    }
  `,
})
export class LoadingIndicatorComponent {
  /** Text shown next to the spinner. */
  readonly label = input('AI is searching company documents');

  /** Hides the trailing dot pulse where it would be noise. */
  readonly showDots = input(true);

  /** Staggered dot styling. */
  protected readonly dots = DOTS;
}
