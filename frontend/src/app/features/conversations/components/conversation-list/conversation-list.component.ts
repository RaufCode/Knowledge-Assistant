import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

import { ConversationGroup } from '../../../../core/services/conversation.service';
import { ConversationItemComponent } from '../conversation-item/conversation-item.component';

/**
 * Conversations grouped under date headings. Purely presentational: the filtering
 * and grouping are done in `ConversationService`.
 */
@Component({
  selector: 'app-conversation-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ConversationItemComponent],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6">
      @for (group of groups(); track group.bucket) {
        <section>
          <h2 class="mb-2 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {{ group.bucket }}
          </h2>
          <ul class="flex flex-col gap-2">
            @for (conversation of group.conversations; track conversation.id) {
              <li>
                <app-conversation-item
                  appearance="panel"
                  [conversation]="conversation"
                  [isSelected]="conversation.id === selectedId()"
                  (selected)="selected.emit($event)"
                />
              </li>
            }
          </ul>
        </section>
      } @empty {
        <p
          class="rounded-lg border border-dashed border-border bg-card px-4 py-8 text-center
            text-sm text-muted-foreground"
        >
          {{ emptyMessage() }}
        </p>
      }
    </div>
  `,
})
export class ConversationListComponent {
  /** Date-grouped conversations to render. */
  readonly groups = input.required<ConversationGroup[]>();

  /** Highlights the currently open conversation. */
  readonly selectedId = input<string | null>(null);

  /** Message shown when there is nothing to list. */
  readonly emptyMessage = input('No conversations match your search.');

  /** Emits the conversation id when a row is activated. */
  readonly selected = output<string>();
}
