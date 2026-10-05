import { ChangeDetectionStrategy, Component, input } from '@angular/core';

import { Message } from '../../../../core/models/message.model';

/**
 * A question the user asked, shown as a right-aligned bubble in the thread.
 */
@Component({
  selector: 'app-message-bubble',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex justify-end' },
  template: `
    <div
      class="max-w-[520px] rounded-lg rounded-br-sm bg-primary px-4 py-3 text-sm
        text-primary-foreground"
    >
      {{ message().text }}
    </div>
  `,
})
export class MessageBubbleComponent {
  /** The turn to render. */
  readonly message = input.required<Message>();
}
