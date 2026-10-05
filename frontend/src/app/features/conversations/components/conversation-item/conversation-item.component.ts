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
    <!--
      The rail is an initials chip with room for one target, so it gets the bare
      button and nothing else. Everything else is a row with its own actions, on both
      surfaces — a conversation can be renamed or deleted from the conversations view
      as well as the sidebar, and having that depend on which screen you happen to be
      on is the kind of thing people read as the feature not existing.
    -->
    @if (appearance() === 'rail') {
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
    } @else {
      <!--
        The row is the full width of the column, and its title runs to the edge.

        It used to be a flex-1 button with two icon buttons beside it, which meant the
        clickable area stopped short of the sidebar's own padding — the row felt
        narrower than the New Conversation button above it, because it was. Now the
        title covers everything and the controls sit over the end of it.

        The right padding reserves the ellipsis's corner, so a long title truncates
        beside the control rather than running underneath it.
      -->
      <div class="group relative">
        @if (isRenaming()) {
          <input
            #rename
            type="text"
            class="w-full rounded-md border border-primary bg-card px-3 py-2.5 text-sm
              text-foreground outline-none"
            [value]="draft()"
            maxlength="120"
            [attr.aria-label]="'New name for this conversation'"
            (input)="onDraft($event)"
            (keydown.enter)="saveRename()"
            (keydown.escape)="cancelRename()"
            (blur)="cancelRename()"
          />
        } @else {
          @if (appearance() === 'panel') {
            <button
              type="button"
              class="flex w-full items-start gap-3 rounded-lg border p-4 pr-9 text-left
                shadow-subtle transition-colors"
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
            </button>
          } @else {
            <button
              type="button"
              class="w-full rounded-md border px-3 py-2.5 pr-9 text-left transition-colors"
              [class]="sidebarClasses()"
              [attr.aria-current]="isSelected() ? 'page' : null"
              (click)="selected.emit(conversation().id)"
            >
              <span class="block truncate text-sm font-medium" [class]="titleClasses()">
                {{ name() }}
              </span>
            </button>
          }

          <!--
            The ellipsis sits over the end of the row rather than beside it, so the
            row itself can be the full width. It opens the two actions rather than
            performing them: a delete one click from opening the conversation is a
            delete one mis-click from gone, and renaming deserves a field rather than
            an immediate commit.
          -->
          <button
            type="button"
            class="absolute right-1 top-1/2 -translate-y-1/2 rounded-md p-1.5
              transition-opacity"
            [class]="actionsClasses()"
            [attr.aria-label]="'Actions for ' + name()"
            [attr.aria-expanded]="isMenuOpen()"
            (click)="toggleMenu($event)"
          >
            <app-icon name="more-horizontal" [size]="16" />
          </button>

          @if (isMenuOpen()) {
            <!--
              Over the list rather than in it, so the rows underneath do not shift as
              it opens. The catcher covers the page, so a click anywhere else closes
              it — including well outside the sidebar.
            -->
            <button
              type="button"
              class="fixed inset-0 z-10 cursor-default"
              aria-label="Close"
              tabindex="-1"
              (click)="closeMenu()"
            ></button>

            <div
              class="absolute right-0 top-full z-20 mt-1 w-44 overflow-hidden rounded-lg
                border border-border bg-card py-1 shadow-raised"
            >
              <button
                type="button"
                class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm
                  text-foreground hover:bg-muted"
                (click)="beginRename()"
              >
                <app-icon name="pencil" [size]="14" class="shrink-0" />
                Rename
              </button>

              <button
                type="button"
                class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm
                  text-danger hover:bg-danger/10"
                (click)="removed.emit(conversation().id)"
              >
                <app-icon name="trash-2" [size]="14" class="shrink-0" />
                Delete
              </button>
            </div>
          }
        }
      </div>
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

  /** Emits the id and the new name when a conversation is renamed. */
  readonly renamed = output<{ id: string; title: string }>();

  /** Emits the id of a conversation to delete. The parent confirms it first. */
  readonly removed = output<string>();

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

  private readonly menuOpen = signal(false);
  private readonly renaming = signal(false);
  private readonly draftState = signal('');

  private readonly rename = viewChild<ElementRef<HTMLInputElement>>('rename');

  /** Whether the row's action menu is showing. */
  protected readonly isMenuOpen = this.menuOpen.asReadonly();

  /** Whether the row is being renamed in place. */
  protected readonly isRenaming = this.renaming.asReadonly();

  /** The name being typed. */
  protected readonly draft = this.draftState.asReadonly();

  constructor() {
    // The input only exists while renaming, so focusing it has to wait for the DOM.
    effect(() => {
      if (this.renaming() && this.rename()) {
        this.rename()?.nativeElement.focus();
        this.rename()?.nativeElement.select();
      }
    });
  }

  /**
   * Opens or closes the menu.
   *
   * `stopPropagation` because the ellipsis overlaps the row rather than sitting
   * inside it, and a click that also reached the row would open the conversation
   * behind the menu that was being opened over it.
   */
  protected toggleMenu(event: Event): void {
    event.stopPropagation();
    this.menuOpen.update((open) => !open);
  }

  protected closeMenu(): void {
    this.menuOpen.set(false);
  }

  /** Switches the row into its editor, starting from the name it has. */
  protected beginRename(): void {
    this.closeMenu();
    this.draftState.set(this.conversation().title ?? '');
    this.renaming.set(true);
  }

  /**
   * Asks for a deletion rather than performing one.
   *
   * The parent confirms it, because a conversation and everything said in it cannot
   * be recovered and this is one click from opening it. Stopping the row from opening
   * for the same reason.
   */
  protected onDelete(): void {
    this.removed.emit(this.conversation().id);
  }

  protected cancelRename(): void {
    this.renaming.set(false);
    this.draftState.set('');
  }

  /**
   * Emits the new name, or closes the editor when nothing was typed.
   *
   * An empty name is not a conversation with no name — that is what a conversation
   * looks like before it has been answered — so it is refused rather than sent.
   */
  protected saveRename(): void {
    const title = this.draftState().trim();

    if (!title) {
      this.cancelRename();

      return;
    }

    this.renaming.set(false);
    this.renamed.emit({ id: this.conversation().id, title });
  }

  protected onDraft(event: Event): void {
    this.draftState.set((event.target as HTMLInputElement).value);
  }

  /** When the conversation was last active, as a reader would say it. */
  protected readonly relativeTime = computed(() => formatRelativeTime(this.conversation().updatedAt));

  /**
   * The actions button's own colours, per surface.
   *
   * Needed because the row is on a dark sidebar in one appearance and on a light
   * card in the other, and a muted colour that reads on one is invisible on the
   * other. Resolved here rather than written into the class list for the same reason.
   */
  protected readonly actionsClasses = computed(() =>
    this.appearance() === 'panel'
      ? 'text-muted-foreground hover:bg-muted hover:text-foreground opacity-0 ' +
        'group-hover:opacity-100 focus-visible:opacity-100'
      : 'text-sidebar-muted hover:bg-white/10 hover:text-sidebar-foreground opacity-0 ' +
        'group-hover:opacity-100 focus-visible:opacity-100',
  );

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
