import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, ParamMap, provideRouter } from '@angular/router';
import { BehaviorSubject } from 'rxjs';

import { ChatService } from '../../core/services/chat.service';
import { Message } from '../../core/models/message.model';
import { ResponseViewComponent } from './response-view.component';

/** A question and its answer, as the thread renders them. */
const MESSAGES: Message[] = [
  {
    id: 'm1',
    role: 'user',
    text: 'How much leave do I have?',
    status: 'answered',
    sources: [],
    documentCount: 0,
    confidence: null,
    createdAt: '2026-09-30T09:00:00Z',
  },
  {
    id: 'm2',
    role: 'assistant',
    text: 'Twenty days.',
    status: 'answered',
    sources: [],
    documentCount: 0,
    confidence: null,
    createdAt: '2026-09-30T09:00:01Z',
  },
];

/** The parts of the chat service this view reads. */
interface ChatStub {
  threadTitle: () => string;
  isResolving: () => boolean;
  isEmpty: () => boolean;
  isMissing: () => boolean;
  messages: () => Message[];
  isLoading: () => boolean;
  isPreparing: () => boolean;
  openConversation: (conversationId: string) => void;
  ask: (question: string) => void;
  retry: (messageId: string) => void;
}

describe('ResponseViewComponent', () => {
  let resolving: ReturnType<typeof signal<boolean>>;
  let empty: ReturnType<typeof signal<boolean>>;
  let missing: ReturnType<typeof signal<boolean>>;
  let messages: ReturnType<typeof signal<Message[]>>;
  let opened: string[];
  let asked: string[];
  let retried: string[];
  let chat: ChatStub;
  let fixture: ComponentFixture<ResponseViewComponent>;
  let paramMap: BehaviorSubject<ParamMap>;

  const build = async (id: string | null): Promise<void> => {
    chat = {
      threadTitle: () => 'Annual leave entitlement',
      isResolving: () => resolving(),
      isEmpty: () => empty(),
      isMissing: () => missing(),
      messages: () => messages(),
      isLoading: () => false,
      isPreparing: () => false,
      openConversation: (conversationId) => opened.push(conversationId),
      ask: (question) => asked.push(question),
      retry: (messageId) => retried.push(messageId),
    };

    paramMap = new BehaviorSubject(convertToParamMap(id === null ? {} : { id }));

    await TestBed.configureTestingModule({
      imports: [ResponseViewComponent],
      providers: [
        provideRouter([]),
        { provide: ChatService, useValue: chat },
        {
          provide: ActivatedRoute,
          useValue: { paramMap: paramMap.asObservable() },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(ResponseViewComponent);
    await fixture.whenStable();
  };

  beforeEach(() => {
    resolving = signal(false);
    empty = signal(false);
    missing = signal(false);
    messages = signal(MESSAGES);
    opened = [];
    asked = [];
    retried = [];
  });

  /** The rendered element, for what the screen is showing. */
  const element = (): HTMLElement => fixture.nativeElement as HTMLElement;

  const refresh = async (): Promise<void> => {
    fixture.detectChanges();
    await fixture.whenStable();
  };

  describe('a loaded conversation', () => {
    beforeEach(async () => {
      await build('conv-1');
    });

    it('shows the conversation title in the header', () => {
      expect(element().querySelector('app-view-header')?.textContent).toContain(
        'Annual leave entitlement',
      );
    });

    it('renders the thread and the composer', () => {
      expect(element().querySelector('app-chat-thread')).toBeTruthy();
      expect(element().querySelector('app-question-input')).toBeTruthy();
    });

    it('keeps the header and the composer outside the scrolling thread', () => {
      // The one scrollable container is the message list. Anything inside it moves
      // with the conversation; anything outside it cannot.
      const scroller = element().querySelector('[role="log"]');

      expect(scroller).toBeTruthy();
      expect(scroller?.classList.contains('overflow-y-auto')).toBe(true);
      expect(scroller?.querySelector('app-view-header')).toBeNull();
      expect(scroller?.querySelector('app-question-input')).toBeNull();
      expect(element().querySelector('app-view-header')).toBeTruthy();
      expect(element().querySelector('app-question-input')).toBeTruthy();
    });

    it('holds the scrolling thread to the space between them, so the composer stays put', () => {
      const scroller = element().querySelector('[role="log"]');

      // `flex-1` takes the height left over by the fixed header and composer, and
      // `min-h-0` lets it shrink below its content instead of pushing the composer
      // off the bottom of the page.
      expect(scroller?.classList.contains('flex-1')).toBe(true);
      expect(scroller?.classList.contains('min-h-0')).toBe(true);

      const composer = element().querySelector('app-question-input')?.parentElement?.parentElement;

      // `shrink-0` is what holds the composer at its own height while the thread
      // scrolls behind it.
      expect(composer?.classList.contains('shrink-0')).toBe(true);
    });

    it('asks a follow-up in the open conversation', async () => {
      const textarea = element().querySelector('textarea') as HTMLTextAreaElement;

      textarea.value = 'Can I carry it over?';
      textarea.dispatchEvent(new Event('input'));
      await refresh();
      element().querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
      await refresh();

      expect(asked).toEqual(['Can I carry it over?']);
    });

    it('asks a failed message again through the thread', async () => {
      messages.set([{ ...MESSAGES[1], status: 'failed', text: 'It went wrong.' }]);
      await refresh();

      element().querySelector<HTMLButtonElement>('app-answer-failed button')?.click();

      expect(retried).toEqual(['m2']);
    });

    it('opens the conversation the route names', () => {
      // The id is the conversation's own, and the view hands it to the one service
      // that decides what is open.
      expect(opened).toContain('conv-1');
    });

    it('opens the newly selected conversation when the route id changes', async () => {
      // Picking another conversation from the sidebar changes only the id, so the
      // view has to re-open on that change; otherwise the sidebar appears dead.
      opened = [];

      paramMap.next(convertToParamMap({ id: 'conv-2' }));
      await refresh();

      expect(opened).toEqual(['conv-2']);
    });
  });

  describe('the states before the thread', () => {
    beforeEach(async () => {
      resolving = signal(true);
      await build('conv-1');
    });

    it('shows a loading placeholder while a conversation is on its way', () => {
      expect(element().querySelector('[role="status"]')?.textContent).toContain('Loading');
      expect(element().querySelector('app-chat-thread')).toBeNull();
    });

    it('says it is loading rather than imitating work', () => {
      // Nothing is being read or worked out while a saved conversation is fetched, so
      // the card says the true thing. Imitating an answer in progress is what made the
      // old placeholder sit there pulsing for a wait it was not part of.
      const card = element().querySelector('app-answer-pending');

      expect(card).not.toBeNull();
      expect(card?.textContent).toContain('Loading conversation');
      expect(card?.querySelectorAll('app-skeleton').length).toBe(0);
    });

    it('hides the placeholder from assistive technology, saying it once instead', () => {
      // A screen reader announcing a stack of empty boxes, and then a live region
      // saying it again, is twice the interruption for one piece of information.
      const placeholder = element().querySelector('[aria-hidden="true"]');

      expect(placeholder).not.toBeNull();
      expect(element().querySelectorAll('[role="status"]')).toHaveLength(1);
    });

    it('does not report a conversation as missing while it is still loading', async () => {
      missing.set(true);
      await refresh();

      // Loading wins. A link that is merely on its way is not a link to nothing.
      expect(element().textContent).not.toContain('Conversation not found');
    });

    it('does not report a conversation as empty while it is still loading', async () => {
      empty.set(true);
      await refresh();

      expect(element().textContent).not.toContain('No questions yet');
    });
  });

  it('says a conversation that is gone is not found, not that it is empty', async () => {
    empty = signal(false);
    missing = signal(true);
    messages = signal([]);
    await build('gone');
    await fixture.whenStable();

    // An empty thread would read as a conversation that has lost its history, which
    // is the opposite of what a deleted link means.
    expect(element().textContent).toContain('Conversation not found');
    expect(element().textContent).not.toContain('No questions yet');
  });

  it('invites a first question in an empty conversation', async () => {
    resolving = signal(false);
    empty = signal(true);
    missing = signal(false);
    messages = signal([]);
    await build('conv-1');
    await fixture.whenStable();

    expect(element().textContent).toContain('No questions yet');
    expect(element().textContent).not.toContain('Conversation not found');
    // The composer stays: an empty conversation is exactly where a question is
    // asked, so taking it away would be taking away the only thing to do.
    expect(element().querySelector('app-question-input')).toBeTruthy();
  });

  it('follows the last active conversation when the route names none', async () => {
    await build(null);

    // `/response` with no id, which is where a question sent from the dashboard
    // lands. There is no conversation to open, so none is opened.
    expect(opened).toEqual([]);
  });
});
