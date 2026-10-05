import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';

import { ConversationService } from '../../core/services/conversation.service';
import { LayoutService } from '../../core/services/layout.service';
import { ViewHeaderComponent } from '../../features/chat/components/view-header/view-header.component';
import { ConversationListComponent } from '../../features/conversations/components/conversation-list/conversation-list.component';
import { ConversationSearchComponent } from '../../features/conversations/components/conversation-search/conversation-search.component';
import { ConfirmDialogComponent } from '../../shared/components/confirm-dialog/confirm-dialog.component';

/**
 * Every conversation this account has, searchable and grouped by date. Opening a row
 * routes to its response view.
 *
 * Scoped to the account rather than to a browser: the backend lists a signed-in
 * person's own conversations, so this is everything they have ever started on any
 * browser, not just the one they happen to be using.
 *
 * Renaming and deleting live here as well as in the sidebar. They are the same two
 * actions on the same rows, and having them on one screen and not the other reads as
 * the feature not existing — so the rows carry them and this view handles the
 * consequences, including the confirmation a deletion needs.
 */
@Component({
  selector: 'app-conversations-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ConfirmDialogComponent,
    ConversationListComponent,
    ConversationSearchComponent,
    ViewHeaderComponent,
  ],
  host: { class: 'flex min-h-0 flex-1 flex-col' },
  template: `
    <app-view-header title="Conversations" />

    <div class="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:px-8">
      <div class="mx-auto w-full max-w-3xl">
        <div class="mb-4 max-w-md">
          <app-conversation-search
            [value]="conversations.searchTerm()"
            (valueChange)="conversations.setSearchTerm($event)"
          />
        </div>

        <app-conversation-list
          [groups]="conversations.groups()"
          [selectedId]="conversations.activeId()"
          [emptyMessage]="emptyMessage()"
          (selected)="openConversation($event)"
          (renamed)="onRenamed($event)"
          (removed)="askToDelete($event)"
        />
      </div>
    </div>

    <app-confirm-dialog
      [isOpen]="pendingDeleteId() !== null"
      icon="trash-2"
      tone="danger"
      title="Delete this conversation?"
      message="The conversation and every question and answer in it are removed. This cannot be undone."
      confirmLabel="Delete"
        tone="danger"
      (confirmed)="confirmDelete()"
      (cancelled)="pendingDeleteId.set(null)"
    />
  `,
})
export class ConversationsViewComponent {
  /** The conversation list, search term and grouping. */
  protected readonly conversations = inject(ConversationService);

  private readonly router = inject(Router);
  private readonly layout = inject(LayoutService);

  /** The conversation a delete confirmation is about, or null when there is none. */
  protected readonly pendingDeleteId = signal<string | null>(null);

  /** Explains an empty list, distinguishing "none yet" from "no matches". */
  protected readonly emptyMessage = computed(() => {
    if (this.conversations.hasNoResults()) {
      return 'No conversations match your search.';
    }

    return this.conversations.isLoading()
      ? 'Loading your conversations...'
      : 'You have not started any conversations yet.';
  });

  /** Opens a conversation, showing its whole thread. */
  protected openConversation(conversationId: string): void {
    this.layout.closeAfterNavigation();
    void this.router.navigate(['/response', conversationId]);
  }

  /** Names a conversation from its row. */
  protected onRenamed(change: { id: string; title: string }): void {
    this.conversations.renameConversation(change.id, change.title);
  }

  /**
   * Asks before deleting.
   *
   * A conversation and everything said in it cannot be recovered, and the row this is
   * reached from is one click from opening it — so a deletion that happened on the
   * same click would be one mis-click from gone.
   */
  protected askToDelete(conversationId: string): void {
    this.pendingDeleteId.set(conversationId);
  }

  /** Deletes the conversation the confirmation is about. */
  protected confirmDelete(): void {
    const conversationId = this.pendingDeleteId();
    this.pendingDeleteId.set(null);

    if (conversationId !== null) {
      this.conversations.deleteConversation(conversationId);
    }
  }
}