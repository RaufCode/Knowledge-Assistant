import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

import { ButtonComponent } from '../../../../shared/components/button/button.component';
import { IconComponent } from '../../../../shared/components/icon/icon.component';

/**
 * The conversation search field, in the sidebar and on the conversations page.
 *
 * Deliberately its own component rather than the shared text input: this is the
 * one field the browser kept filling with the signed-in address. A bare text
 * field reads as an identity field, so after sign-in — and again whenever the
 * list re-rendered, such as when an answer landed — the address appeared here,
 * arrived as an `input` event, and was applied as a filter matching nothing.
 * The field then only showed anything again once it was cleared by hand.
 *
 * Three things keep that from happening, because no single one of them works in
 * every browser:
 *
 * - `autocomplete="off"` with a search-specific name, so nothing about the
 *   field suggests an address belongs in it.
 * - `readonly` until focused. Fillers do not touch a readonly field, and focus
 *   is a precondition of typing anyway, so a real keystroke never notices it.
 * - One-way data flow. The text on screen is always exactly the search term the
 *   service holds — never a value the field picked up on its own — because the
 *   field owns no state of its own to diverge with.
 * - Anything containing `@` is dropped rather than emitted. No conversation
 *   title contains one — titles are natural-language summaries — while every
 *   unwanted fill observed here was an address. A filler writes the whole value
 *   at once rather than typing it, and the field is restored to the search term
 *   instead, so nothing lingers on screen either.
 */
@Component({
  selector: 'app-conversation-search',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, IconComponent],
  host: { class: 'block' },
  template: `
    <label
      class="flex h-9 items-center gap-2 rounded-md border border-border bg-card px-3
        transition-colors focus-within:border-primary/40
        has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2
        has-[:focus-visible]:outline-primary"
    >
      <app-icon name="search" [size]="15" class="text-muted-foreground" />
      <input
        #box
        type="text"
        name="conversation-search"
        autocomplete="off"
        readonly
        class="w-full bg-transparent text-sm text-foreground
          placeholder:text-muted-foreground focus:outline-none"
        [placeholder]="placeholder()"
        [value]="value()"
        [attr.aria-label]="ariaLabel()"
        (focus)="box.removeAttribute('readonly')"
        (blur)="box.setAttribute('readonly', '')"
        (input)="onInput(box)"
      />
      @if (value()) {
        <button
          app-button
          type="button"
          variant="ghost"
          tone="light"
          size="icon-sm"
          (click)="valueChange.emit('')"
        >
          <app-icon name="x" [size]="13" label="Clear search" />
        </button>
      }
    </label>
  `,
})
export class ConversationSearchComponent {
  /** Current search text, owned by the caller. */
  readonly value = input.required<string>();

  /** Emits the text as typed, or empty when the clear control is pressed. */
  readonly valueChange = output<string>();

  /** Placeholder text. */
  readonly placeholder = input('Search conversations');

  /** Accessible name of the field. */
  readonly ariaLabel = input('Search conversations');

  /**
   * Forwards typed text, dropping filler text instead.
   *
   * A filler writes an address into the field in one go; a person types it a
   * key at a time and never produces `@` on the way to a conversation title.
   * The dropped text is replaced with the search term rather than emitted, so
   * the field stays empty — and the list unfiltered — until the user fills it.
   */
  protected onInput(box: HTMLInputElement): void {
    if (box.value.includes('@')) {
      box.value = this.value();

      return;
    }

    this.valueChange.emit(box.value);
  }
}
