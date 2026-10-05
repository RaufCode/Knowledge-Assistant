import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/** Visual weight of a button. */
export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'subtle' | 'danger';

/** Physical size of a button. */
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg' | 'icon' | 'icon-sm' | 'rail';

/** Surface the button sits on, which decides its resting and hover colour. */
export type ButtonTone = 'light' | 'brand' | 'dark';

/**
 * Utility classes per variant. `ghost` and `outline` carry no text colour: the
 * tone supplies it, so a call site can never end up with two competing
 * `text-*` utilities where the winner depends on stylesheet order.
 */
const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-primary-foreground hover:bg-primary/90 active:bg-primary',
  secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
  outline: 'border border-border bg-card',
  ghost: '',
  subtle: 'border border-primary/25 bg-card text-primary hover:bg-secondary-soft',
  // Reserved for an action that cannot be undone, such as deleting a document.
  danger: 'bg-danger text-white hover:bg-danger/90 active:bg-danger',
};

/** Text and hover colour for the variants that have no fill of their own. */
const TONE_CLASSES: Record<ButtonTone, string> = {
  light: 'text-muted-foreground hover:bg-muted hover:text-foreground',
  // For a control that is the only way in or out of a panel: it carries the
  // brand colour at rest rather than fading into the surface it sits on.
  brand: 'text-primary hover:bg-muted hover:text-primary',
  dark: 'text-sidebar-muted hover:bg-white/10 hover:text-sidebar-foreground',
};

/** Variants whose colour comes from the tone. */
const TONE_AWARE_VARIANTS: ButtonVariant[] = ['ghost', 'outline'];

/** Utility classes per size. */
const SIZE_CLASSES: Record<ButtonSize, string> = {
  xs: 'gap-1 px-1.5 py-0.5 text-xs',
  sm: 'gap-2 px-3 py-2 text-xs',
  md: 'gap-2 px-3 py-2 text-sm',
  lg: 'gap-2 px-4 py-2.5 text-sm',
  icon: 'size-10',
  // A compact square for a control that sits inside another field, such as the
  // clear button on a search box, where the default icon size is taller than the
  // field and stretches it when the control appears.
  'icon-sm': 'size-6',
  rail: 'size-11',
};

/** Rounded corners are tighter on the small sizes, as in the design. */
const RADIUS_CLASSES: Record<ButtonSize, string> = {
  xs: 'rounded-sm',
  sm: 'rounded-sm',
  md: 'rounded-md',
  lg: 'rounded-md',
  icon: 'rounded-md',
  'icon-sm': 'rounded-md',
  rail: 'rounded-md',
};

/**
 * The application's only button, applied as an attribute so the element stays
 * a real `<button>` and keeps native focus, keyboard and disabled behaviour.
 *
 * ```html
 * <button app-button variant="primary" size="lg" [fullWidth]="true">Ask</button>
 * ```
 */
@Component({
  selector: 'button[app-button], a[app-button]',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class:
      'inline-flex cursor-pointer items-center justify-center font-medium whitespace-nowrap ' +
      'transition-colors disabled:pointer-events-none disabled:opacity-50',
    '[class]': 'classes()',
  },
  // The host element is a real button or link, so the component only adds
  // styling and re-projects whatever the caller put inside it.
  template: '<ng-content />',
})
export class ButtonComponent {
  /** Visual weight. */
  readonly variant = input<ButtonVariant>('primary');

  /** Physical size. */
  readonly size = input<ButtonSize>('md');

  /** Surface the button sits on: a light page or the dark sidebar. */
  readonly tone = input<ButtonTone>('light');

  /** Stretches the button to the width of its container. */
  readonly fullWidth = input(false);

  /** Right-aligns content instead of centring it, for list rows. */
  readonly alignStart = input(false);

  /** Resolved utility classes for the current inputs. */
  protected readonly classes = computed(() =>
    [
      VARIANT_CLASSES[this.variant()],
      TONE_AWARE_VARIANTS.includes(this.variant()) ? TONE_CLASSES[this.tone()] : '',
      SIZE_CLASSES[this.size()],
      RADIUS_CLASSES[this.size()],
      this.fullWidth() ? 'w-full' : '',
      this.alignStart() ? 'justify-start text-left' : 'text-center',
    ]
      .filter(Boolean)
      .join(' '),
  );
}
