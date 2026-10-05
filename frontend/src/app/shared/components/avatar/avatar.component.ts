import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/** How prominently an avatar is presented. */
export type AvatarTone = 'primary' | 'secondary' | 'muted' | 'outline';

/** Tone to utility classes. */
const TONE_CLASSES: Record<AvatarTone, string> = {
  primary: 'bg-primary text-primary-foreground',
  secondary: 'bg-secondary text-secondary-foreground',
  muted: 'bg-muted text-muted-foreground',
  outline: 'border border-white/10 bg-white/5 text-sidebar-muted',
};

/** Diameter in pixels to utility classes. */
const SIZE_CLASSES: Record<number, string> = {
  28: 'size-7 text-[10px]',
  32: 'size-8 text-xs',
  36: 'size-9 text-xs',
  40: 'size-10 text-sm',
  56: 'size-14 rounded-xl text-xl',
};

/**
 * A circular initials badge. Used for the signed-in user in the sidebar and for
 * the assistant avatar beside an answer.
 */
@Component({
  selector: 'app-avatar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class:
      'inline-flex shrink-0 items-center justify-center rounded-full font-semibold select-none',
    '[class]': 'classes()',
    // Initials alone say nothing to a screen reader, and the sidebar avatar now
    // stands without the name beside it, so the label is what names the person.
    '[attr.aria-label]': 'label()',
    '[attr.title]': 'label()',
  },
  template: '{{ initials() }}',
})
export class AvatarComponent {
  /** Initials to render, e.g. `SM`. */
  readonly initials = input.required<string>();

  /** Background and foreground treatment. */
  readonly tone = input<AvatarTone>('primary');

  /** Diameter in pixels. */
  readonly size = input(36);

  /** Accessible label; omit when the name is already adjacent. */
  readonly label = input<string | undefined>(undefined);

  /** Resolved utility classes for the current inputs. */
  protected readonly classes = computed(
    () => `${TONE_CLASSES[this.tone()]} ${SIZE_CLASSES[this.size()] ?? 'size-9 text-xs'}`,
  );
}
