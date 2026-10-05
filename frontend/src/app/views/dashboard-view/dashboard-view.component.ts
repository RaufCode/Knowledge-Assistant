import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';

import { AuthService } from '../../core/services/auth.service';
import { ChatService } from '../../core/services/chat.service';
import { ConversationService } from '../../core/services/conversation.service';
import { QuestionInputComponent } from '../../features/ask/components/question-input/question-input.component';
import { SuggestionListComponent } from '../../features/ask/components/suggestion-list/suggestion-list.component';
import { ViewHeaderComponent } from '../../features/chat/components/view-header/view-header.component';
import { STARTER_QUESTIONS } from '../../shared/utils/constants';

/**
 * The landing view: a centred prompt, the starter questions, and the composer.
 * A view only assembles components and connects them to services.
 */
/**
 * The greetings, as functions of the first name.
 *
 * All of them say the same thing — ask me something — and none of them pretend to
 * know what the person wants, because it does not know that yet.
 */
const GREETINGS: ((firstName: string) => string)[] = [
  (name) => (name ? `How can I help, ${name}?` : 'How can I help?'),
  (name) => (name ? `Good to see you, ${name}. What are you looking for?` : 'Good to see you. What are you looking for?'),
  (name) => (name ? `Hello ${name} — what would you like to know?` : 'Hello — what would you like to know?'),
  (name) => (name ? `Hi ${name}. Ask me anything about the policies.` : 'Hi. Ask me anything about the policies.'),
];

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
          {{ greeting() }}
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

  /**
   * The greeting, which is one of several.
   *
   * It was a single fixed sentence, which made the assistant feel like a form rather
   * than a place somebody had arrived. Four of them, chosen once per visit rather than
   * on every change detection: a greeting that rewrote itself while the page was open
   * would read as a glitch, and picking from the clock alone would have made every
   * person in the same office be greeted identically.
   *
   * The name is woven into whichever is chosen, and the unnamed form is used while it
   * is not yet known — which is correct at every point where it is not known.
   */
  protected readonly greeting = computed(() => {
    const name = this.firstName();
    const chosen = GREETINGS[Math.floor(this.visitSeed() * GREETINGS.length) % GREETINGS.length];

    return name ? chosen(name) : chosen('');
  });

  /**
   * A number that stays put for the length of this visit.
   *
   * Fixed at construction from the clock, so the greeting is settled on arrival and
   * does not move underneath the reader afterwards.
   */
  private readonly visitSeed = signal(Math.random());

  private readonly router = inject(Router);

  constructor() {
    // This screen is a blank window, so nothing is open in it.
    //
    // Without this the service still had the most recent conversation selected from
    // the sign-in redirect, and asking a question here reused it: an employee who
    // signed in, read nothing, and typed a question had it appended to a conversation
    // from a previous session rather than starting the one they were looking at.
    //
    // Clearing it is also what keeps the sidebar honest. The highlight is drawn from
    // this same value, so a blank window with a lit row was the same disagreement
    // showing twice.
    this.conversations.startUnsaved();
  }

  private readonly conversations = inject(ConversationService);

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
