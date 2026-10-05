import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Router } from '@angular/router';

import { AuthService } from '../../core/services/auth.service';
import { ChatService } from '../../core/services/chat.service';
import { QuestionInputComponent } from '../../features/ask/components/question-input/question-input.component';
import { SuggestionListComponent } from '../../features/ask/components/suggestion-list/suggestion-list.component';
import { ViewHeaderComponent } from '../../features/chat/components/view-header/view-header.component';
import { STARTER_QUESTIONS } from '../../shared/utils/constants';

/**
 * The landing view: a centred prompt, the starter questions, and the composer.
 * A view only assembles components and connects them to services.
 */
@Component({
  selector: 'app-dashboard-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [QuestionInputComponent, SuggestionListComponent, ViewHeaderComponent],
  host: { class: 'flex min-h-0 flex-1 flex-col' },
  template: `
    <!-- The header carries only the sidebar toggle; the design's hero has no title. -->
    <app-view-header />

    <div class="scrollbar-thin flex min-h-0 flex-1 flex-col items-center justify-center px-4 py-8">
      <div class="flex w-full max-w-2xl flex-col items-center">
        <!--
          The first name, not the full name. This is the first thing on the screen and
          it is the only place in the app that greets, so it is the only place the
          greeting has to be right.
        -->
        <h2 class="text-center font-headings text-2xl font-semibold text-foreground">
          How can I help{{ firstName() ? ', ' + firstName() : '' }}?
        </h2>

        <div class="mt-6 w-full max-w-[520px]">
          <app-suggestion-list [suggestions]="starterQuestions" (chosen)="onAsk($event)" />
        </div>

        <div class="mt-8 w-full max-w-[640px]">
          <app-question-input [isBusy]="chat.isLoading()" (ask)="onAsk($event)" />
        </div>
      </div>
    </div>
  `,
})
export class DashboardViewComponent {
  /** Current conversation state, including the loading flag for the composer. */
  protected readonly chat = inject(ChatService);

  /** Who is signed in, which is what the greeting names. */
  private readonly auth = inject(AuthService);

  /** Starter prompts, which are product copy rather than data from the backend. */
  protected readonly starterQuestions = STARTER_QUESTIONS;

  /**
   * The signed-in person's first name, or nothing.
   *
   * Empty rather than the whole name, and empty rather than a placeholder: before the
   * session resolves the greeting is simply "How can I help?", which is correct at
   * every point where the name is not yet known.
   */
  protected readonly firstName = computed(() => this.auth.user()?.name.trim().split(/\s+/)[0] ?? '');

  private readonly router = inject(Router);

  /**
   * Asks a question and routes to the response view.
   *
   * The route carries no id: `/response` follows the newest turn, so the question
   * just sent is the one that opens. That also means the view does not have to
   * wait for the request to start before it can navigate.
   */
  protected onAsk(question: string): void {
    this.chat.ask(question);

    void this.router.navigate(['/response']);
  }
}
