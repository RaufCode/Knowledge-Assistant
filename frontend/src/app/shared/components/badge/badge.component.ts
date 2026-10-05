import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/** Meaning the badge carries, which decides its colour. */
export type BadgeTone = 'neutral' | 'brand' | 'info' | 'success' | 'warning' | 'danger';

/** Colour classes per tone, all drawn from the shared palette. */
const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: 'bg-muted text-muted-foreground',
  brand: 'bg-secondary-soft text-secondary',
  info: 'bg-primary/10 text-primary',
  success: 'bg-success/10 text-success',
  warning: 'bg-warning/10 text-warning',
  danger: 'bg-danger/10 text-danger',
};

/**
 * A small status pill, used for document states, question outcomes and roles.
 */
@Component({
  selector: 'app-badge',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
    '[class]': 'classes()',
  },
  template: '<ng-content />',
})
export class BadgeComponent {
  /** Colour and meaning. */
  readonly tone = input<BadgeTone>('neutral');

  /** Resolved colour classes. */
  protected readonly classes = computed(() => TONE_CLASSES[this.tone()]);
}
