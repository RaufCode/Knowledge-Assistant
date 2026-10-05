import { ChangeDetectionStrategy, Component, input } from '@angular/core';

import { IconComponent, type IconName } from '../../../../shared/components/icon/icon.component';

/**
 * One headline number: the figure, what it counts, and a short note underneath.
 *
 * The value is a string rather than a number so a caller can say "not indexed yet"
 * where a count would force a misleading zero. A figure that cannot be counted is
 * not the same as a count of nothing, and this is where that difference is shown.
 */
@Component({
  selector: 'app-stat-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: {
    class: 'flex flex-col gap-2 rounded-lg border border-border bg-card p-5 shadow-subtle',
  },
  template: `
    <div class="flex items-start justify-between gap-3">
      <span class="text-sm font-medium text-muted-foreground">{{ label() }}</span>
      <span
        class="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted
          text-muted-foreground"
      >
        <app-icon [name]="icon()" [size]="16" />
      </span>
    </div>

    <span class="font-headings text-2xl font-semibold text-foreground">{{ value() }}</span>
    <span class="text-xs text-muted-foreground">{{ detail() }}</span>
  `,
})
export class StatCardComponent {
  /** What the figure counts. */
  readonly label = input.required<string>();

  /** The figure itself. */
  readonly value = input.required<string>();

  /** One line of context under the figure. */
  readonly detail = input('');

  /** Icon shown in the corner. */
  readonly icon = input<IconName>('info');
}
