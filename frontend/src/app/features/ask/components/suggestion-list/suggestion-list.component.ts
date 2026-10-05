import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

import { ButtonComponent } from '../../../../shared/components/button/button.component';
import { IconComponent } from '../../../../shared/components/icon/icon.component';

/**
 * The starter prompts on the dashboard. Presentational: it renders the prompts
 * it is given and reports which one was chosen.
 */
@Component({
  selector: 'app-suggestion-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, IconComponent],
  host: { class: 'block' },
  template: `
    <ul class="flex w-full flex-col gap-2.5">
      @for (suggestion of suggestions(); track suggestion) {
        <li>
          <button
            app-button
            type="button"
            variant="outline"
            size="lg"
            class="h-auto w-full justify-between border-border py-3.5 text-left text-foreground
              shadow-subtle hover:bg-secondary-soft hover:text-foreground"
            (click)="chosen.emit(suggestion)"
          >
            <span class="text-sm">{{ suggestion }}</span>
            <app-icon name="arrow-up-right" [size]="16" class="shrink-0 text-muted-foreground" />
          </button>
        </li>
      }
    </ul>
  `,
})
export class SuggestionListComponent {
  /**
   * Prompts to offer. Read-only, because they come from a constant and a list
   * that cannot be reordered by accident is the safer thing to hand a component.
   */
  readonly suggestions = input.required<readonly string[]>();

  /** Emits the prompt the user chose. */
  readonly chosen = output<string>();
}
