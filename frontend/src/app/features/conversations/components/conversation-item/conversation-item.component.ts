import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

import { UNTITLED_CONVERSATION, type Conversation } from '../../../../core/models/conversation.model';
import { IconComponent } from '../../../../shared/components/icon/icon.component';
import { toInitials } from '../../../../shared/utils/initials.util';
import { formatRelativeTime } from '../../../../shared/utils/relative-time.util';

/** Which surface the row is rendered on. */
export type ConversationItemAppearance = 'sidebar' | 'panel' | 'rail';

/**
 * One conversation, rendered in whichever of the three forms the current layout
 * calls for: a compact row on the sidebar, an initials chip on the collapsed
 * rail, or a full card in the conversations view.
 *
 * The row is named for the conversation and dated by when it was last active, not
 * by when it was started, because with long-lived conversations the two are
 * usually different and the one a user recognises is the one they were last in.
 */
@Component({
  selector: 'app-conversation-item',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  host: { class: 'block' },
  template: `
    @switch (appearance()) {
      @case ('rail') {
        <button
          type="button"
          class="flex size-11 items-center justify-center rounded-md border text-sm
            font-semibold transition-colors"
          [class]="railClasses()"
          [attr.aria-current]="isSelected() ? 'page' : null"
          [attr.title]="name()"
          (click)="selected.emit(conversation().id)"
        >
          {{ initials() }}
        </button>
      }
      @case ('panel') {
        <button
          type="button"
          class="flex w-full items-start gap-3 rounded-lg border p-4 text-left shadow-subtle
            transition-colors"
          [class]="panelClasses()"
          [attr.aria-current]="isSelected() ? 'page' : null"
          (click)="selected.emit(conversation().id)"
        >
          <span class="min-w-0 flex-1 text-left">
            <span class="block text-sm font-medium text-foreground">
              {{ name() }}
            </span>
            <span class="mt-1.5 block text-xs text-muted-foreground">
              {{ relativeTime() }}
            </span>
          </span>
          <app-icon
            name="arrow-up-right"
            [size]="16"
            class="mt-0.5 shrink-0 text-muted-foreground"
          />
        </button>
      }
      @default {
        <button
          type="button"
          class="flex w-full items-center rounded-md border px-3 py-2.5 text-left
            transition-colors"
          [class]="sidebarClasses()"
          [attr.aria-current]="isSelected() ? 'page' : null"
          (click)="selected.emit(conversation().id)"
        >
          <span class="min-w-0 flex-1 text-left">
            <span class="block truncate text-sm font-medium" [class]="titleClasses()">
              {{ name() }}
            </span>
          </span>
        </button>
      }
    }
  `,
})
export class ConversationItemComponent {
  /** The conversation this row represents. */
  readonly conversation = input.required<Conversation>();

  /** Surface the row is rendered on. */
  readonly appearance = input<ConversationItemAppearance>('sidebar');

  /** Highlights the row as the currently open conversation. */
  readonly isSelected = input(false);

  /** Emits the conversation id when the row is activated. */
  readonly selected = output<string>();

  /**
   * The conversation's name, falling back to a neutral label while it has none.
   *
   * A conversation with no title is one that has not been answered in yet, which
   * is not an error, so it is not shown as one.
   */
  protected readonly name = computed(() => this.conversation().title ?? UNTITLED_CONVERSATION);

  /**
   * Initials for the collapsed rail.
   *
   * Derived from the conversation's name where it has one, and left blank where it
   * does not: the rail shows initials, and an untitled conversation has no topic
   * to take them from.
   */
  protected readonly initials = computed(() => {
    const title = this.conversation().title;

    return title ? toInitials(title) : '···';
  });

  /** When the conversation was last active, as a reader would say it. */
  protected readonly relativeTime = computed(() => formatRelativeTime(this.conversation().updatedAt));

  /** Resolved classes for the collapsed-rail chip. */
  protected readonly railClasses = computed(() =>
    this.isSelected()
      ? 'border-secondary bg-white/15 text-sidebar-foreground'
      : 'border-transparent bg-white/5 text-sidebar-muted hover:bg-white/10 hover:text-sidebar-foreground',
  );

  /** Resolved classes for the sidebar row. */
  protected readonly sidebarClasses = computed(() =>
    this.isSelected()
      ? 'border-secondary/60 bg-white/10'
      : 'border-transparent hover:bg-white/10 focus-visible:bg-white/10',
  );

  /** Resolved classes for the conversations-view card. */
  protected readonly panelClasses = computed(() =>
    this.isSelected()
      ? 'border-secondary bg-secondary-soft'
      : 'border-border bg-card hover:border-primary/30 hover:bg-secondary-soft/50',
  );

  /** Resolved classes for the title, which dims when unselected on the sidebar. */
  protected readonly titleClasses = computed(() =>
    this.isSelected() ? 'text-sidebar-foreground' : 'text-sidebar-foreground/85',
  );
}
