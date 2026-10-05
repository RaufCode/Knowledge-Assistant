import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';

import { MIN_MESSAGE_LENGTH, Message } from '../../../../core/models/message.model';
import { ButtonComponent } from '../../../../shared/components/button/button.component';
import { IconComponent } from '../../../../shared/components/icon/icon.component';

/**
 * A question the user asked, shown as a right-aligned bubble in the thread.
 *
 * Editable, because a typo in a question produces a confidently wrong answer and the
 * only way to put it right without starting a whole new conversation is to fix the
 * wording. The editor opens in place rather than in a dialog: the sentence being
 * corrected is the thing being looked at, and it should stay on screen while it is
 * being corrected.
 *
 * Only a question can be edited. An assistant answer is generated text — letting
 * somebody retype it would put words in its mouth that it never said — and the
 * backend refuses it as well, so the control is not offered here either.
 */
@Component({
  selector: 'app-message-bubble',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ButtonComponent, IconComponent],
  host: { class: 'flex justify-end' },
  template: `
    @if (isEditing()) {
      <div
        class="flex w-full max-w-[520px] flex-col gap-2 rounded-lg border border-border
          bg-card p-3"
      >
        <label class="text-xs font-medium text-foreground" [attr.for]="fieldId">
          Edit your question
        </label>

        <textarea
          #editor
          [id]="fieldId"
          [value]="draft()"
          rows="3"
          maxlength="500"
          class="w-full resize-y rounded-md border border-border bg-background px-3 py-2
            text-sm text-foreground outline-none focus:border-primary"
          (input)="onInput($event)"
        ></textarea>

        @if (isTooShort()) {
          <p class="text-xs text-danger">Ask something of at least 3 characters.</p>
        } @else {
          <p class="text-xs text-muted-foreground">
            The answer to the old wording is removed, and this is asked again.
          </p>
        }

        <div class="flex justify-end gap-2">
          <button app-button type="button" variant="ghost" size="sm" (click)="close()">
            Cancel
          </button>
          <button
            app-button
            type="button"
            size="sm"
            [disabled]="!canSave()"
            (click)="save()"
          >
            Save and ask again
          </button>
        </div>
      </div>
    } @else {
      <div class="group flex max-w-[520px] items-start gap-2">
        <div
          class="min-w-0 flex-1 rounded-lg rounded-br-sm bg-primary px-4 py-3 text-sm
            text-primary-foreground"
        >
          {{ message().text }}
        </div>

        @if (canEdit()) {
          <button
            app-button
            type="button"
            variant="ghost"
            size="icon-sm"
            class="mt-0.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100
              focus-visible:opacity-100"
            [attr.aria-label]="'Edit your question'"
            [title]="'Edit this question'"
            (click)="open()"
          >
            <app-icon name="pencil" [size]="14" />
          </button>
        }
      </div>
    }
  `,
})
export class MessageBubbleComponent {
  /** The turn to render. */
  readonly message = input.required<Message>();

  /** Whether this message may be corrected at all. */
  readonly canEdit = input(true);

  /**
   * Emits the correction: which question, and the words replacing it.
   *
   * Both, because the bubble does not know what a conversation is. It knows the text
   * it was handed and the text it now holds; turning that into "ask this again in
   * that conversation" is the thread's job, which is also the only place that knows
   * whether the correction was stored.
   */
  readonly edited = output<{ id: string; content: string }>();

  private readonly editor = viewChild<ElementRef<HTMLTextAreaElement>>('editor');

  private readonly isEditingState = signal(false);
  private readonly draftState = signal('');

  /** Whether the editor is showing. */
  protected readonly isEditing = this.isEditingState.asReadonly();

  /** The wording being typed. */
  protected readonly draft = this.draftState.asReadonly();

  /** Unique per bubble, so each label points at its own field. */
  protected readonly fieldId = `question-editor-${nextId()}`;

  /** Below the backend's own floor for a question. */
  protected readonly isTooShort = computed(
    () => this.draft().trim().length > 0 && this.draft().trim().length < MIN_MESSAGE_LENGTH,
  );

  protected readonly canSave = computed(
    () =>
      !this.isTooShort() &&
      this.draft().trim().length >= MIN_MESSAGE_LENGTH &&
      this.draft().trim() !== this.message().text.trim(),
  );

  constructor() {
    // The textarea is only in the DOM while editing, so focusing has to wait for it.
    effect(() => {
      if (this.isEditingState() && this.editor()) {
        this.editor()?.nativeElement.focus();
      }
    });
  }

  /** Opens the editor, starting from what is already on screen. */
  protected open(): void {
    if (!this.canEdit()) {
      return;
    }

    this.draftState.set(this.message().text);
    this.isEditingState.set(true);
  }

  /** Closes the editor, discarding the draft. */
  protected close(): void {
    this.isEditingState.set(false);
    this.draftState.set('');
  }

  protected onInput(event: Event): void {
    this.draftState.set((event.target as HTMLTextAreaElement).value);
  }

  /** Emits the correction. The editor closes only once the caller has taken it. */
  protected save(): void {
    const content = this.draft().trim();

    if (!this.canSave()) {
      return;
    }

    this.edited.emit({ id: this.message().id, content });
    this.close();
  }
}

/** A counter behind the generated ids, so two bubbles on a page do not collide. */
let idCounter = 0;

function nextId(): number {
  idCounter += 1;

  return idCounter;
}
