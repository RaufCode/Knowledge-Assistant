import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  effect,
  input,
  model,
  output,
  viewChild,
} from '@angular/core';

import { ButtonComponent } from '../button/button.component';
import { IconComponent, type IconName } from '../icon/icon.component';

/**
 * A panel that sits over the page, for a task that is done and dismissed rather than
 * navigated to and back from.
 *
 * A native `<dialog>` opened with `showModal`, so the browser supplies the top layer,
 * the focus trap, the inert page behind it and the Escape key. Only the open state is
 * mirrored here; everything else is the platform's, which is why there is no focus
 * bookkeeping to get wrong.
 *
 * The backdrop is a dismissal. A click outside the panel closes it, because a modal
 * that traps somebody until they find its close button is a modal that has trapped
 * somebody. The trick is that a click on the backdrop is reported as a click on the
 * `<dialog>` element itself while a click on the panel is reported as a click on the
 * panel, so comparing the two targets is what distinguishes them — no overlay element
 * is needed, and no listener on the document.
 */
@Component({
  selector: 'app-modal',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, IconComponent],
  template: `
    <dialog
      #dialog
      class="m-auto w-[min(100%-2rem,32rem)] rounded-xl border border-border bg-card p-0
        text-foreground shadow-raised backdrop:bg-foreground/40"
      [attr.aria-labelledby]="titleId"
      (click)="onBackdropClick($event)"
      (cancel)="onCancel($event)"
      (close)="onNativeClose()"
    >
      <div class="flex max-h-[85dvh] flex-col">
        <div class="flex items-start gap-3 p-6 pb-4">
          @if (icon(); as shown) {
            <span
              class="flex size-10 shrink-0 items-center justify-center rounded-full
                bg-secondary-soft text-secondary"
            >
              <app-icon [name]="shown" [size]="18" />
            </span>
          }

          <div class="min-w-0 flex-1">
            <h2 [id]="titleId" class="font-headings text-base font-semibold text-foreground">
              {{ title() }}
            </h2>
            @if (message()) {
              <p class="mt-1 text-sm text-muted-foreground">{{ message() }}</p>
            }
          </div>

          <button
            app-button
            type="button"
            variant="ghost"
            tone="light"
            size="icon-sm"
            class="-mt-1 -mr-1 shrink-0"
            aria-label="Close"
            (click)="close()"
          >
            <app-icon name="x" [size]="16" />
          </button>
        </div>

        <!--
          Vertical padding on a scroll container, which normally would not want any.

          A focused field draws its ring with an outline that sits two pixels outside
          the field, and this element clips: anything past its padding box is cut off.
          With no vertical padding the first and last fields sat against the edges of
          the scroll area, so the ring on the field nearest an edge lost the part that
          made it visible — the border stopped short and looked like a rendering fault
          rather than a focus.

          A focused control must be visibly focused, so this is not decoration.
        -->
        <div class="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-6 py-1">
          <ng-content />
        </div>

        <div class="p-6 pt-4">
          <ng-content select="[modalFooter]" />
        </div>
      </div>
    </dialog>
  `,
})
export class ModalComponent {
  /** Two-way open state, so a parent can show and dismiss the panel. */
  readonly isOpen = model(false);

  /** Panel heading. */
  readonly title = input('');

  /** Supporting sentence under the heading. */
  readonly message = input('');

  /** Icon shown beside the heading; omit for none. */
  readonly icon = input<IconName | undefined>(undefined);

  /** Emitted once the panel has been dismissed, by any route. */
  readonly closed = output<void>();

  /**
   * The heading's id, used to label the dialog.
   *
   * Derived from the component's own identity rather than passed in, so two modals on
   * one page cannot end up sharing an id and leaving the second one unlabelled.
   */
  protected readonly titleId = `modal-title-${nextId()}`;

  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('dialog');

  constructor() {
    // The open state is the single source of truth; the native dialog follows it.
    // `showModal` is absent during a server render, where there is no top layer to
    // move the dialog into.
    effect(() => {
      const open = this.isOpen();
      const element = this.dialog()?.nativeElement;

      if (!element || typeof element.showModal !== 'function') {
        return;
      }

      if (open && !element.open) {
        element.showModal();

        return;
      }

      if (!open && element.open) {
        element.close();
      }
    });
  }

  /** Closes the panel and reports it. */
  close(): void {
    this.isOpen.set(false);
    this.closed.emit();
  }

  /**
   * Closes when the click landed on the backdrop rather than the panel.
   *
   * A click on the backdrop is delivered to the `<dialog>` itself; a click inside is
   * delivered to whatever was clicked. Comparing against the element's own box is what
   * separates them without an overlay div that would swallow the panel's own clicks.
   */
  protected onBackdropClick(event: MouseEvent): void {
    const element = event.target as HTMLElement;

    if (element.tagName !== 'DIALOG') {
      return;
    }

    this.close();
  }

  /** Escape, intercepted so the model stays in step with the dialog. */
  protected onCancel(event: Event): void {
    event.preventDefault();
    this.close();
  }

  /** Keeps the model closed if the dialog was dismissed another way. */
  protected onNativeClose(): void {
    if (this.isOpen()) {
      this.isOpen.set(false);
    }

    this.closed.emit();
  }
}

/** A counter behind the generated ids, so two panels on a page do not collide. */
let idCounter = 0;

function nextId(): number {
  idCounter += 1;

  return idCounter;
}