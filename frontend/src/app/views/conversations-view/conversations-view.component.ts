import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Router } from '@angular/router';

import { ConversationService } from '../../core/services/conversation.service';
import { LayoutService } from '../../core/services/layout.service';
import { ViewHeaderComponent } from '../../features/chat/components/view-header/view-header.component';
import { ConversationListComponent } from '../../features/conversations/components/conversation-list/conversation-list.component';
import { InputComponent } from '../../shared/components/input/input.component';

/**
 * Every conversation this browser has, searchable and grouped by date. Opening a
 * row routes to its response view.
 *
 * Scoped to the client id rather than to anything with a lifetime: the backend
 * keeps a client's conversations for as long as it has them, so this list is
 * everything this browser has ever started, not just the current session's.
 */
@Component({
  selector: 'app-conversations-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ConversationListComponent, InputComponent, ViewHeaderComponent],
  host: { class: 'flex min-h-0 flex-1 flex-col' },
  template: `
    <app-view-header title="Conversations" />

    <div class="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:px-8">
      <div class="mx-auto w-full max-w-3xl">
        <div class="mb-4 max-w-md">
          <app-input
            [value]="conversations.searchTerm()"
            (valueChange)="conversations.setSearchTerm($event)"
            placeholder="Search conversations"
            ariaLabel="Search conversations"
          />
        </div>

        <app-conversation-list
          [groups]="conversations.groups()"
          [selectedId]="conversations.activeId()"
          [emptyMessage]="emptyMessage()"
          (selected)="openConversation($event)"
        />
      </div>
    </div>
  `,
})
export class ConversationsViewComponent {
  /** The conversation list, search term and grouping. */
  protected readonly conversations = inject(ConversationService);

  private readonly router = inject(Router);
  private readonly layout = inject(LayoutService);

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
}
