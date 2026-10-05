import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { IconComponent, type IconName } from '../icon/icon.component';

/** Whether the state is informational or signals a problem. */
export type EmptyStateTone = 'neutral' | 'danger';

/**
 * The shared "nothing here" panel, used for empty lists, no search results and
 * failed loads. Any call-to-action is projected beneath the message.
 */
@Component({
  selector: 'app-empty-state',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'flex flex-col items-center justify-center text-center' },
  template: `
    <span
      class="flex size-12 items-center justify-center rounded-full"
      [class]="iconWrapClasses()"
    >
      <app-icon [name]="icon()" [size]="22" [label]="iconLabel()" />
    </span>

    <h2 class="mt-4 text-base font-semibold text-foreground">{{ title() }}</h2>
    <p class="mt-1 max-w-sm text-sm text-muted-foreground">{{ message() }}</p>

    <div class="mt-5 flex items-center gap-2 empty:hidden">
      <ng-content />
    </div>
  `,
})
export class EmptyStateComponent {
  /** Heading of the state. */
  readonly title = input('Nothing here yet');

  /** Supporting sentence. */
  readonly message = input('');

  /** Icon shown in the circle. */
  readonly icon = input<IconName>('file-text');

  /** Accessible name of the icon; decorative by default. */
  readonly iconLabel = input<string | undefined>(undefined);

  /** Whether the state is informational or an error. */
  readonly tone = input<EmptyStateTone>('neutral');

  /** Circle colour per tone. */
  protected readonly iconWrapClasses = computed(() =>
    this.tone() === 'danger' ? 'bg-danger/10 text-danger' : 'bg-muted text-muted-foreground',
  );
}
