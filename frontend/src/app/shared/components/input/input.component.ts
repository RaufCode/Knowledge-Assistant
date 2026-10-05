import { ChangeDetectionStrategy, Component, computed, input, model } from '@angular/core';
import { ButtonComponent } from '../button/button.component';
import { IconComponent, type IconName } from '../icon/icon.component';

/** Which surface the field sits on. */
export type InputTone = 'sidebar' | 'panel';

/** Field, text and icon classes per tone. */
const TONE_CLASSES: Record<InputTone, { field: string; text: string; icon: string }> = {
  sidebar: {
    field: 'bg-white/10 focus-within:bg-white/15',
    text: 'text-sidebar-foreground placeholder:text-sidebar-muted',
    icon: 'text-sidebar-muted',
  },
  panel: {
    field: 'border border-border bg-card focus-within:border-primary/40',
    text: 'text-foreground placeholder:text-muted-foreground',
    icon: 'text-muted-foreground',
  },
};

/**
 * A single-line text field with a leading icon and a clear control, used for
 * searching conversations. Presentational: the value is a model, so changes
 * flow back out through it.
 *
 * Autofill is switched off with a search-specific name: a bare text field reads
 * to the browser as an identity field, so it filled this box with the signed-in
 * address on load — and every fill arrived as an `input` event, which the search
 * faithfully applied as a filter matching nothing.
 */
@Component({
  selector: 'app-input',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, IconComponent],
  host: { class: 'block' },
  template: `
    <label
      class="flex h-9 items-center gap-2 rounded-md px-3 transition-colors
        has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2
        has-[:focus-visible]:outline-primary"
      [class]="fieldClasses()"
    >
      <app-icon [name]="icon()" [size]="15" [label]="iconLabel()" [class]="iconClasses()" />
      <input
        type="text"
        name="conversation-search"
        autocomplete="off"
        class="w-full bg-transparent text-sm focus:outline-none"
        [class]="textClasses()"
        [placeholder]="placeholder()"
        [value]="value()"
        [attr.aria-label]="ariaLabel()"
        (input)="onInput($event)"
      />
      @if (value()) {
        <button
          app-button
          type="button"
          variant="ghost"
          [tone]="tone() === 'sidebar' ? 'dark' : 'light'"
          size="icon-sm"
          (click)="clear()"
        >
          <app-icon name="x" [size]="13" label="Clear search" />
        </button>
      }
    </label>
  `,
})
export class InputComponent {
  /** Current text. */
  readonly value = model('');

  /** Placeholder text. */
  readonly placeholder = input('Search');

  /** Accessible name of the field. */
  readonly ariaLabel = input('Search');

  /** Icon shown before the text. */
  readonly icon = input<IconName>('search');

  /** Accessible name of the leading icon. */
  readonly iconLabel = input<string | undefined>(undefined);

  /** Surface the field sits on. */
  readonly tone = input<InputTone>('panel');

  /** Resolved classes for the field wrapper. */
  protected readonly fieldClasses = computed(() => TONE_CLASSES[this.tone()].field);

  /** Resolved classes for the text. */
  protected readonly textClasses = computed(() => TONE_CLASSES[this.tone()].text);

  /** Resolved classes for the leading icon. */
  protected readonly iconClasses = computed(() => TONE_CLASSES[this.tone()].icon);

  /** Forwards typing to the bound model. */
  protected onInput(event: Event): void {
    this.value.set((event.target as HTMLInputElement).value);
  }

  /** Empties the field. */
  protected clear(): void {
    this.value.set('');
  }
}
