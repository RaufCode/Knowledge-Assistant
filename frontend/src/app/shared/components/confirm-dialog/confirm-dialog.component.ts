import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  input,
  model,
  output,
  viewChild,
} from '@angular/core';

import { ButtonComponent } from '../button/button.component';
import { IconComponent, type IconName } from '../icon/icon.component';

/** Whether confirming is a routine or a destructive action. */
export type ConfirmTone = 'primary' | 'danger';

/**
 * The application's confirmation modal, used before an action that cannot be
 * undone, such as signing out or deleting a document.
 *
 * It is a native `<dialog>` so the browser supplies the focus trap and the
 * Escape key; the component only mirrors the open state in both directions.
 */
@Component({
  selector: 'app-confirm-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, IconComponent],
  template: `
    <dialog
      #dialog
      class="m-auto w-[min(100%-2rem,26rem)] rounded-xl border border-border bg-card p-0
        text-foreground shadow-raised [&::backdrop]:bg-foreground/40"
      aria-labelledby="confirm-dialog-title"
      (cancel)="onCancel($event)"
      (close)="onClose()"
    >
      <div class="flex flex-col gap-5 p-6">
        <div class="flex items-start gap-3">
          <span
            class="flex size-10 shrink-0 items-center justify-center rounded-full"
            [class]="iconWrapClasses()"
          >
            <app-icon [name]="icon()" [size]="18" />
          </span>
          <div class="flex flex-col gap-1">
            <h2 id="confirm-dialog-title" class="text-base font-semibold text-foreground">
              {{ title() }}
            </h2>
            <p class="text-sm text-muted-foreground">{{ message() }}</p>
          </div>
        </div>

        <div class="flex justify-end gap-2">
          <button app-button type="button" variant="outline" (click)="cancel()">
            {{ cancelLabel() }}
          </button>
          <button app-button type="button" [variant]="confirmVariant()" (click)="confirm()">
            {{ confirmLabel() }}
          </button>
        </div>
      </div>
    </dialog>
  `,
})
export class ConfirmDialogComponent {
  /** Two-way open state, so a parent can show and dismiss the dialog. */
  readonly isOpen = model(false);

  /** Dialog heading. */
  readonly title = input('Are you sure?');

  /** Supporting sentence under the heading. */
  readonly message = input('');

  /** Label of the confirming button. */
  readonly confirmLabel = input('Confirm');

  /** Label of the dismissing button. */
  readonly cancelLabel = input('Cancel');

  /** Whether confirming is routine or destructive. */
  readonly tone = input<ConfirmTone>('primary');

  /** Icon shown beside the heading. */
  readonly icon = input<IconName>('alert-triangle');

  /** Emitted once the user confirms. */
  readonly confirmed = output<void>();

  /** Emitted once the user dismisses. */
  readonly cancelled = output<void>();

  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('dialog');

  /** Confirming colour: a routine action uses the brand, a destructive one red. */
  protected readonly confirmVariant = computed(() =>
    this.tone() === 'danger' ? 'danger' : 'primary',
  );

  /** Colour of the icon circle per tone. */
  protected readonly iconWrapClasses = computed(() =>
    this.tone() === 'danger' ? 'bg-danger/10 text-danger' : 'bg-secondary-soft text-secondary',
  );

  constructor() {
    // The open state is the single source of truth; the native dialog follows
    // it. `showModal` is absent during server rendering, where there is no
    // top layer to move the dialog into.
    effect(() => {
      const open = this.isOpen();
      const element = this.dialog()?.nativeElement;
      if (!element || typeof element.showModal !== 'function') {
        return;
      }
      if (open && !element.open) {
        element.showModal();
      } else if (!open && element.open) {
        element.close();
      }
    });
  }

  /** Confirms and closes. */
  protected confirm(): void {
    this.isOpen.set(false);
    this.confirmed.emit();
  }

  /** Dismisses and closes. */
  protected cancel(): void {
    this.isOpen.set(false);
    this.cancelled.emit();
  }

  /** Intercepts Escape so the model stays in step with the dialog. */
  protected onCancel(event: Event): void {
    event.preventDefault();
    this.cancel();
  }

  /** Keeps the model closed if the dialog is dismissed another way. */
  protected onClose(): void {
    if (this.isOpen()) {
      this.isOpen.set(false);
    }
  }
}
