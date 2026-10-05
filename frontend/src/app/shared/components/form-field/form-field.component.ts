import { ChangeDetectionStrategy, Component, computed, input, model, signal } from '@angular/core';

import { ButtonComponent } from '../button/button.component';
import { IconComponent, type IconName } from '../icon/icon.component';

/** Input types the field knows how to render. */
export type FieldType = 'text' | 'email' | 'password';

/** A stable id per field instance, used to link the label, hint and error. */
let nextFieldId = 0;

/**
 * A labelled form input with an optional leading icon, password reveal and
 * inline hint or error text. Presentational: the value is a model, so changes
 * flow back out through it.
 */
@Component({
  selector: 'app-form-field',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, IconComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-1.5">
      @if (label()) {
        <label class="text-sm font-medium text-foreground" [attr.for]="controlId">
          {{ label() }}
          @if (required()) {
            <span class="text-danger" aria-hidden="true">*</span>
          }
        </label>
      }

      <div
        class="flex h-10 items-center gap-2 rounded-md border bg-card px-3 transition-colors
          focus-within:border-primary/40
          has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2
          has-[:focus-visible]:outline-primary"
        [class]="borderClasses()"
      >
        @if (icon()) {
          <app-icon [name]="icon()!" [size]="16" class="text-muted-foreground" />
        }

        <input
          [id]="controlId"
          [type]="resolvedType()"
          class="w-full bg-transparent text-sm text-foreground focus:outline-none"
          [class]="placeholderClasses()"
          [placeholder]="placeholder()"
          [attr.autocomplete]="autocomplete()"
          [attr.aria-invalid]="error() ? true : null"
          [attr.aria-describedby]="describedBy()"
          [attr.required]="required() ? true : null"
          [value]="value()"
          (input)="onInput($event)"
        />

        @if (type() === 'password') {
          <button
            app-button
            type="button"
            variant="ghost"
            tone="light"
            size="icon-sm"
            (click)="toggleReveal()"
            [attr.aria-label]="revealed() ? 'Hide password' : 'Show password'"
          >
            <app-icon [name]="revealed() ? 'eye-off' : 'eye'" [size]="15" />
          </button>
        }
      </div>

      @if (error()) {
        <p [id]="errorId" class="text-xs text-danger">{{ error() }}</p>
      } @else if (hint()) {
        <p [id]="hintId" class="text-xs text-muted-foreground">{{ hint() }}</p>
      }
    </div>
  `,
})
export class FormFieldComponent {
  /** Current text. */
  readonly value = model('');

  /** Visible label above the control. */
  readonly label = input('');

  /** Input type: text, email or password. */
  readonly type = input<FieldType>('text');

  /** Placeholder text. */
  readonly placeholder = input('');

  /** Value of the browser autocomplete hint. */
  readonly autocomplete = input<string | undefined>(undefined);

  /** Icon shown before the text. */
  readonly icon = input<IconName | undefined>(undefined);

  /** Short guidance shown below the control. */
  readonly hint = input('');

  /** Error shown below the control, replacing the hint. */
  readonly error = input('');

  /** Marks the control as required. */
  readonly required = input(false);

  /** Generated id linking the label to the control. */
  protected readonly controlId = `field-${nextFieldId++}`;

  /** Id of the hint text. */
  protected readonly hintId = `${this.controlId}-hint`;

  /** Id of the error text. */
  protected readonly errorId = `${this.controlId}-error`;

  /**
   * Whether the placeholder is set very faint rather than the muted default.
   *
   * Off by default so the shared field keeps its current contrast, and on for the
   * signed-out screens, where a long placeholder sits under a short label and the
   * muted default competes with the value the field is asking for.
   */
  readonly faintPlaceholder = input(false);

  /** Whether a password is currently visible. */
  protected readonly revealed = signal(false);

  /** Placeholder colour, faint when asked for. */
  protected readonly placeholderClasses = computed(() =>
    this.faintPlaceholder()
      ? 'placeholder:text-muted-foreground/45'
      : 'placeholder:text-muted-foreground',
  );

  /** Border colour, reddened while an error is shown. */
  protected readonly borderClasses = computed(() =>
    this.error() ? 'border-danger' : 'border-border',
  );

  /** The type actually passed to the input, honouring the reveal toggle. */
  protected readonly resolvedType = computed(() =>
    this.type() === 'password' && this.revealed() ? 'text' : this.type(),
  );

  /** Ids the control points assistive technology at. */
  protected readonly describedBy = computed(() => {
    if (this.error()) {
      return this.errorId;
    }
    if (this.hint()) {
      return this.hintId;
    }
    return null;
  });

  /** Forwards typing to the bound model. */
  protected onInput(event: Event): void {
    this.value.set((event.target as HTMLInputElement).value);
  }

  /** Shows or hides a password. */
  protected toggleReveal(): void {
    this.revealed.update((revealed) => !revealed);
  }
}
