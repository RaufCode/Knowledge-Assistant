import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { API_BASE_URL } from '../api.config';
import { ChatStreamEventDto } from '../models/api.model';
import { AuthServiceStub, provideAuthStub } from '../testing/auth-service.stub';
import { ChatService } from './chat.service';
import { ConversationService } from './conversation.service';
import { IdentityService } from './identity.service';

/** A citation as the backend sends one. */
const SOURCE = {
  document: 'Leave Policy',
  section: 'Section 4.2',
  snippet: 'Annual leave accrues monthly at 1.67 days per month.',
  score: 0.82,
};

/** One request the streaming stub was asked to make. */
interface StreamRequest {
  url: string;
  body: { client_id: string; content: string };
}

/** The wire shape of a conversation list response, as the refresh test serves it. */
interface ConversationListPayload {
  conversations: { id: string; title: string | null; updated_at: string }[];
}

/**
 * Lets the pending microtasks run.
 *
 * The stream is read through `fetch`, so an answer reaches the service a few
 * ticks after the test pushes it rather than in the same turn. Every assertion
 * made after answering goes through here.
 */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }

  await new Promise((resolve) => setTimeout(resolve, 0));
};

describe('ChatService', () => {
  let chat: ChatService;
  let conversations: ConversationService;
  let http: HttpTestingController;

  /** The client id this suite sends, read from the one place that mints it. */
  let clientId: string;

  /** Every request made to the streaming endpoint, oldest first. */
  let streamRequests: StreamRequest[] = [];

  /** The live stream, so a test can push events and close it. */
  let pushEvent: (event: ChatStreamEventDto) => void = () => undefined;
  let closeStream: () => void = () => undefined;

  /** The URL the list is fetched from, which names the client. */
  const listUrl = (): string => `${API_BASE_URL}/api/conversations`;

  /** The list a restored browser has, reused where a refresh is served. */
  const RESTORED_LIST: ConversationListPayload = {
    conversations: [
      { id: 'conv-1', title: 'Annual leave', updated_at: '2026-09-30T09:00:00' },
      { id: 'conv-2', title: 'Expenses', updated_at: '2026-09-28T09:00:00' },
    ],
  };

  /**
   * Replaces `fetch` with a stub that serves the messages endpoint.
   *
   * The real endpoint sends server-sent events over a chunked body, so the stub
   * exposes the same shape: a response whose body the test writes to and closes.
   * That is what lets a test assert that the answer is on screen before the stream
   * has finished, which is the whole point of streaming.
   */
  beforeEach(() => {
    streamRequests = [];

    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      streamRequests.push({ url, body: JSON.parse(String(init?.body)) });

      return new Promise<Response>((resolve) => {
        const encoder = new TextEncoder();
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const body = new ReadableStream<Uint8Array>({
          start(streamController) {
            controller = streamController;
          },
        });

        pushEvent = (event) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        };
        closeStream = () => controller.close();

        resolve(new Response(body, { status: 200 }));
      });
    });

    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        // Conversations only load behind a session, so these tests need one. Signed
        // in as an employee: this suite is about asking questions, and an employee
        // is the role that can.
        provideAuthStub(),
      ],
    });

    TestBed.inject(AuthServiceStub).setRole('employee');

    // Injecting the chat service constructs the conversation service, which
    // fetches this browser's list. The client id has to be read first, because
    // that request is already on its way by the time anything can be flushed.
    clientId = TestBed.inject(IdentityService).clientId();
    chat = TestBed.inject(ChatService);
    conversations = TestBed.inject(ConversationService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    vi.unstubAllGlobals();
  });

  /**
   * Answers the initial list load with a browser that already has conversations,
   * and loads the first one's thread.
   */
  const givenRestoredConversations = (): void => {
    http.expectOne(listUrl()).flush(RESTORED_LIST);

    http.expectOne(`${API_BASE_URL}/api/conversations/conv-1`).flush({
      id: 'conv-1',
      title: 'Annual leave',
      messages: [
        {
          id: 'm1',
          role: 'user',
          content: 'How much leave do I have?',
          sources: null,
          created_at: '2026-09-30T09:00:00',
        },
        {
          id: 'm2',
          role: 'assistant',
          content: 'Twenty days.',
          sources: [SOURCE],
          created_at: '2026-09-30T09:00:01',
        },
      ],
    });
  };

  /**
   * Answers the list re-read that follows a completed answer, when the test does
   * not care what the corrected list contains.
   */
  const flushSummaryRefresh = (payload: ConversationListPayload = RESTORED_LIST): void => {
    http.expectOne(listUrl()).flush(payload);
  };

  /**
   * Answers the initial list load for a browser with nothing yet, and the one
   * conversation created so a question has somewhere to go.
   */
  const givenFreshClient = (): void => {
    http.expectOne(listUrl()).flush({ conversations: [] });
    http.expectOne(`${API_BASE_URL}/api/conversations`).flush({
      id: 'conv-new',
      title: null,
      created_at: '2026-09-30T09:00:00',
    });
  };

  /** Pushes a finished answer and closes the stream. */
  const streamAnswer = async (
    answer: string,
    answered = true,
    sources: unknown[] = [],
    status = answered ? 'answered' : 'not-found',
    confidence: number | null = null,
  ): Promise<void> => {
    pushEvent({
      type: 'done',
      answer,
      answered,
      status,
      confidence,
      sources: sources as never,
    });
    closeStream();
    await settle();
  };

  /** The messages of the open conversation, oldest first. */
  const messages = () => chat.messages();

  describe('the thread it restores', () => {
    it('opens the most recent conversation rather than an empty one', () => {
      givenRestoredConversations();

      // The list is the backend's, ordered by when each conversation was last
      // active, and a reload is not a reason to start a new one.
      expect(chat.activeConversationId()).toBe('conv-1');
      expect(chat.hasMessages()).toBe(true);
      expect(chat.threadTitle()).toBe('Annual leave');
    });

    it('creates nothing on a first visit, because nothing has been asked', () => {
      http.expectOne(listUrl()).flush({ conversations: [] });

      // The whole point of the empty-list case: there is no question, so there is no
      // conversation. A create here is how an untitled row ends up in the sidebar
      // before anybody has typed.
      http.expectNone(`${API_BASE_URL}/api/conversations`);

      // The first visit lands on an empty thread, which is a conversation waiting for
      // its first question — not an error, and not a missing conversation.
      expect(chat.isEmpty()).toBe(true);
      expect(chat.activeConversationId()).toBeNull();
      expect(chat.hasMessages()).toBe(false);
    });

    it('stays resolving while the list is on its way', () => {
      expect(chat.isResolving()).toBe(true);

      http.expectOne(listUrl()).flush({ conversations: [] });

      expect(chat.isResolving()).toBe(false);
    });

    it('leaves the sidebar empty on a first visit, so there is no empty row in it', () => {
      http.expectOne(listUrl()).flush({ conversations: [] });

      // Not an entry reading "New conversation": the list is empty because there is
      // nothing to list.
      expect(conversations.conversations()).toEqual([]);
      expect(conversations.hasConversations()).toBe(false);
    });
  });

  describe('asking', () => {
    it('records the question and a pending answer before the request goes out', () => {
      givenRestoredConversations();

      chat.ask('Can I carry it over?');

      // Shown straight away rather than after a round trip that can take a minute.
      expect(messages().map((message) => message.role)).toEqual([
        'user',
        'assistant',
        'user',
        'assistant',
      ]);
      expect(messages().at(-2)?.text).toBe('Can I carry it over?');
      expect(messages().at(-1)?.status).toBe('pending');
      expect(chat.isLoading()).toBe(true);

      // The list is re-read once the answer lands, so the completed stream here is
      // only what the request itself asked for.
      expect(streamRequests).toEqual([
        {
          url: `${API_BASE_URL}/api/conversations/conv-1/messages`,
          body: { client_id: clientId, content: 'Can I carry it over?' },
        },
      ]);
    });

    it('waits for a conversation instead of dropping a question asked on arrival', async () => {
      // Nothing flushed yet: the list is still in flight, so there is no
      // conversation to add a message to.
      chat.ask('How much annual leave do I have?');

      expect(streamRequests).toEqual([]);
      expect(messages()).toEqual([]);

      givenFreshClient();
      await settle();

      // The question asked before the app knew which conversation it was being
      // added to is asked now, rather than silently lost. This is the first thing
      // anyone does on a first visit, so losing it loses the first question.
      expect(streamRequests.map((request) => request.body.content)).toEqual([
        'How much annual leave do I have?',
      ]);
      expect(messages().at(-2)?.text).toBe('How much annual leave do I have?');
    });

    it('sends a follow-up to the conversation it belongs to', () => {
      givenRestoredConversations();

      chat.ask('Can I carry it over?');

      // The same conversation, not a new one. This is the single decision that
      // makes a follow-up a follow-up.
      expect(chat.activeConversationId()).toBe('conv-1');
      expect(streamRequests[0].url).toBe(`${API_BASE_URL}/api/conversations/conv-1/messages`);
      // And no request for a conversation is made, because sending never creates
      // one.
      http.expectNone(`${API_BASE_URL}/api/conversations`);
    });

    it('keeps the restored messages and adds to them', () => {
      givenRestoredConversations();

      chat.ask('Can I carry it over?');

      // The earlier exchange is the backend's, and the new one is local, in the
      // same thread, in order.
      expect(
        messages()
          .slice(0, 2)
          .map((message) => message.id),
      ).toEqual(['m1', 'm2']);
    });

    it('ignores a question with no words in it', () => {
      givenRestoredConversations();

      chat.ask('   ');

      expect(streamRequests).toEqual([]);
      expect(messages()).toHaveLength(2);
    });
  });

  describe('streaming an answer', () => {
    it('writes the answer out as it arrives, before the stream ends', async () => {
      givenRestoredConversations();

      chat.ask('Can I carry it over?');
      pushEvent({ type: 'status', stage: 'writing' });
      pushEvent({ type: 'delta', text: 'Yes, ' });
      pushEvent({ type: 'delta', text: 'up to five days.' });
      await settle();

      // The question is already in the thread with a growing answer behind it.
      expect(messages().at(-1)?.text).toBe('Yes, up to five days.');
      expect(chat.isLoading()).toBe(true);
    });

    it('shows that the answer is being written, and stops doing so at the first words', async () => {
      givenRestoredConversations();

      chat.ask('Can I carry it over?');

      // The model works before its first word. Without this the thread would sit
      // on a spinner for all of it.
      expect(chat.isPreparing()).toBe(false);

      pushEvent({ type: 'status', stage: 'writing' });
      await settle();
      expect(chat.isPreparing()).toBe(true);

      // First words supersede it: the answer is now visibly arriving.
      pushEvent({ type: 'delta', text: 'Yes' });
      await settle();
      expect(chat.isPreparing()).toBe(false);
    });

    it('settles the message on the closing event, which is the authority', async () => {
      givenRestoredConversations();

      chat.ask('Can I carry it over?');
      pushEvent({ type: 'delta', text: 'Yes' });
      await streamAnswer('Yes, up to five days.', true, [SOURCE]);
      flushSummaryRefresh();

      const answer = messages().at(-1);

      expect(answer?.text).toBe('Yes, up to five days.');
      expect(answer?.status).toBe('answered');
      // Citations arrive with the finished answer, never before it, so the
      // citation block is never shown beside a half-written answer.
      expect(answer?.sources).toEqual([SOURCE]);
      expect(answer?.documentCount).toBe(1);
      expect(chat.isLoading()).toBe(false);
      expect(chat.isPreparing()).toBe(false);
    });

    it('treats an unanswered question as a gap in the corpus, not a failure', async () => {
      givenRestoredConversations();

      chat.ask('What is the wifi password?');
      await streamAnswer('I could not find that in the documents.', false);
      flushSummaryRefresh();

      // "Not in the documents" is a confident statement about the corpus, and there
      // is nothing to retry about it.
      expect(messages().at(-1)?.status).toBe('not-found');
      expect(chat.isLoading()).toBe(false);
    });

    it('fails the message when the stream ends without a closing event', async () => {
      givenRestoredConversations();

      chat.ask('Can I carry it over?');
      pushEvent({ type: 'delta', text: 'Yes, up to' });
      closeStream();
      await settle();

      // A connection dropped part way through has produced no answer at all.
      // Reporting that as "not found in the documents" would blame the corpus for
      // a dropped connection, and there would be nothing left to retry.
      expect(messages().at(-1)?.status).toBe('failed');
      expect(messages().at(-1)?.text).toContain('interrupted');
      expect(chat.isLoading()).toBe(false);
    });

    it('fails the message when the stream says the assistant failed', async () => {
      givenRestoredConversations();

      chat.ask('Can I carry it over?');
      pushEvent({
        type: 'error',
        detail: 'The assistant is temporarily unavailable. Please try again.',
      });
      closeStream();
      await settle();

      // The backend cannot answer with a status once the stream has opened, so the
      // failure travels as an event and reads the same way on screen.
      expect(messages().at(-1)?.status).toBe('failed');
      expect(messages().at(-1)?.text).toBe(
        'The assistant is temporarily unavailable. Please try again.',
      );
    });

    it('names the conversation from the title event, in the list and the header', async () => {
      http.expectOne(listUrl()).flush({
        conversations: [{ id: 'conv-1', title: null, updated_at: '2026-09-30T09:00:00' }],
      });
      http.expectOne(`${API_BASE_URL}/api/conversations/conv-1`).flush({
        id: 'conv-1',
        title: null,
        messages: [],
      });

      chat.ask('How much annual leave do I have?');
      pushEvent({
        type: 'done',
        answer: 'Twenty days.',
        answered: true,
        status: 'answered',
        confidence: null,
        sources: [],
      });
      pushEvent({ type: 'title', title: 'Annual leave allowance' });
      closeStream();
      await settle();

      // The completion also re-reads the list, which now carries the title the
      // backend stored.
      flushSummaryRefresh({
        conversations: [
          { id: 'conv-1', title: 'Annual leave allowance', updated_at: '2026-09-30T09:30:00' },
        ],
      });

      // The title arrives after the answer, because naming is a second model call
      // that runs beside the first answer rather than in front of it. It is applied
      // wherever the conversation is named, so the sidebar and the header agree.
      expect(chat.threadTitle()).toBe('Annual leave allowance');
      expect(conversations.conversations()[0].title).toBe('Annual leave allowance');
    });

    it('re-reads the list once an answer lands, so the conversation moves up it', async () => {
      givenRestoredConversations();

      chat.ask('Can I carry it over?');
      await streamAnswer('Yes, up to five days.');

      // Answering stamps the conversation as active, and the list is ordered by
      // that. Left alone, a conversation answered now would stay at the bottom of
      // the sidebar until the next reload.
      http.expectOne(listUrl()).flush({
        conversations: [
          { id: 'conv-1', title: 'Annual leave', updated_at: '2026-09-30T09:30:00' },
          { id: 'conv-2', title: 'Expenses', updated_at: '2026-09-28T09:00:00' },
        ],
      });

      expect(conversations.conversations()[0].id).toBe('conv-1');
    });
  });

  describe('retrying', () => {
    /** Puts a failed exchange at the end of the open thread. */
    const givenFailedExchange = async (): Promise<string> => {
      givenRestoredConversations();

      chat.ask('Can I carry it over?');
      pushEvent({ type: 'error', detail: 'The assistant is temporarily unavailable.' });
      closeStream();
      await settle();

      return messages().at(-1)?.id ?? '';
    };

    it('asks the question again in place of the failure, not under it', async () => {
      const failedId = await givenFailedExchange();

      chat.retry(failedId);

      // A second copy of the question under a failure that is being retried would
      // leave the reader looking at a card for something already asked again. The
      // retried exchange takes the same place in the thread.
      expect(messages().map((message) => message.role)).toEqual([
        'user',
        'assistant',
        'user',
        'assistant',
      ]);
      expect(messages().at(-2)?.text).toBe('Can I carry it over?');
      expect(messages().at(-1)?.status).toBe('pending');
      expect(streamRequests.map((request) => request.body.content)).toEqual([
        'Can I carry it over?',
        'Can I carry it over?',
      ]);
    });

    it('leaves the rest of the thread alone', async () => {
      const failedId = await givenFailedExchange();

      chat.retry(failedId);

      // The restored exchange is still the first thing in the thread.
      expect(
        messages()
          .slice(0, 2)
          .map((message) => message.id),
      ).toEqual(['m1', 'm2']);
    });

    it('does nothing while a question is already in flight', async () => {
      const failedId = await givenFailedExchange();

      chat.ask('Something else');
      const before = messages().length;

      chat.retry(failedId);

      // One answer at a time. A second request would interleave two streams into
      // one thread and leave the reader with two half-answers.
      expect(messages()).toHaveLength(before);
      expect(streamRequests).toHaveLength(2);
    });

    it('ignores a message that is not in the open thread', () => {
      givenRestoredConversations();

      chat.retry('not-a-message');

      expect(streamRequests).toEqual([]);
    });

    it('asks a question that is not the one above a message', async () => {
      http.expectOne(listUrl()).flush({
        conversations: [{ id: 'conv-1', title: 'Leave', updated_at: '2026-09-30T09:00:00' }],
      });
      http.expectOne(`${API_BASE_URL}/api/conversations/conv-1`).flush({
        id: 'conv-1',
        title: 'Leave',
        messages: [
          {
            id: 'm1',
            role: 'user',
            content: 'First?',
            sources: null,
            created_at: '2026-09-30T09:00:00',
          },
          {
            id: 'm2',
            role: 'assistant',
            content: 'Yes.',
            sources: [],
            created_at: '2026-09-30T09:00:01',
          },
          {
            id: 'm3',
            role: 'user',
            content: 'Second?',
            sources: null,
            created_at: '2026-09-30T09:00:02',
          },
          {
            id: 'm4',
            role: 'assistant',
            content: 'No.',
            sources: [],
            created_at: '2026-09-30T09:00:03',
          },
        ],
      });

      chat.retry('m4');

      // The question is the message before it, which is the relationship the
      // backend stores as well, so this holds for a thread it sent.
      expect(streamRequests.map((request) => request.body.content)).toEqual(['Second?']);
    });
  });

  describe('confidence', () => {
    it('carries the figure from the closing event onto the answer', async () => {
      givenRestoredConversations();

      chat.ask('How much annual leave do I get?');
      await streamAnswer('1.75 days per month.', true, [], 'answered', 5);
      flushSummaryRefresh();

      // The field exists so a reader can see how well the question matched the
      // documents. If it is dropped anywhere between the stream and the card it is
      // null in the answer and nothing says why.
      expect(messages().at(-1)?.confidence).toBe(5);
    });

    it('leaves it null for a reply that was not built from passages', async () => {
      givenRestoredConversations();

      chat.ask('hello');
      await streamAnswer("Hello! I'm the assistant.", true, [], 'greeting', null);
      flushSummaryRefresh();

      // Not zero. A greeting cites nothing, so there is nothing to have been
      // confident about and a low number would read as a poor answer.
      expect(messages().at(-1)?.confidence).toBeNull();
    });

    it('reads it back off a reloaded thread, so both paths agree', async () => {
      givenRestoredConversations();

      chat.openConversation('conv-1');
      http.expectOne(`${API_BASE_URL}/api/conversations/conv-1`).flush({
        id: 'conv-1',
        title: 'Leave',
        messages: [
          {
            id: 'm2',
            role: 'assistant',
            content: 'Twenty days.',
            sources: [{ document: 'Leave Policy', section: 'S', snippet: 'x', score: 0.5 }],
            status: 'answered',
            confidence: 5,
            created_at: '2026-09-30T09:00:01',
          },
        ],
      });

      // A conversation reopened tomorrow must show the same figure as the one
      // watched being answered, or the number is only ever true once.
      expect(messages().at(-1)?.confidence).toBe(5);
    });
  });


  describe('starting and opening conversations', () => {
    it('creates nothing when a new conversation is started, only empties the thread', () => {
      givenRestoredConversations();

      chat.startNewConversation();

      // No request at all. An unsaved conversation has no id to persist and no row to
      // list; the id is taken when a question is actually sent into it.
      http.expectNone(`${API_BASE_URL}/api/conversations`);

      // The conversation it left behind stays in the sidebar. That is the whole
      // point of conversations outliving the question that started them.
      expect(conversations.conversations().map((item) => item.id)).toEqual(['conv-1', 'conv-2']);
      expect(chat.activeConversationId()).toBeNull();
      expect(chat.isEmpty()).toBe(true);
      expect(chat.hasMessages()).toBe(false);
    });

    it('creates the conversation on the first question, and only then', () => {
      http.expectOne(listUrl()).flush({ conversations: [] });

      chat.ask('How much leave do I have?');

      // The one moment a conversation comes into being: a question has been sent.
      const created = http.expectOne(`${API_BASE_URL}/api/conversations`);

      expect(created.request.body).toEqual({ client_id: clientId });
      created.flush({ id: 'conv-new', title: null, created_at: '2026-09-30T10:00:00' });

      expect(chat.activeConversationId()).toBe('conv-new');
      expect(chat.hasMessages()).toBe(true);
    });

    it('reuses the one conversation for every follow-up question', () => {
      http.expectOne(listUrl()).flush({ conversations: [] });

      chat.ask('First question?');
      http
        .expectOne(`${API_BASE_URL}/api/conversations`)
        .flush({ id: 'conv-new', title: null, created_at: '2026-09-30T10:00:00' });

      // One conversation, not one per question: this is what makes a follow-up a
      // follow-up rather than the start of a second thread.
      chat.ask('Second question?');

      http.expectNone(`${API_BASE_URL}/api/conversations`);
      expect(chat.activeConversationId()).toBe('conv-new');
    });

    it('sends a question into the conversation the person opened, not a new one', () => {
      givenRestoredConversations();

      conversations.openConversation('conv-2');
      http
        .expectOne(`${API_BASE_URL}/api/conversations/conv-2`)
        .flush({
          id: 'conv-2',
          title: 'VPN setup',
          messages: [{ id: 'm9', role: 'user', content: 'How do I connect?', sources: null, created_at: '2026-09-29T09:00:00' }],
        });

      chat.ask('And on a phone?');

      // The whole of "existing conversations keep working": an opened conversation is
      // the one the next question goes into.
      http.expectNone(`${API_BASE_URL}/api/conversations`);
      expect(streamRequests.map((request) => request.url)).toContain(
        `${API_BASE_URL}/api/conversations/conv-2/messages`,
      );
    });

    it('keeps the new conversation out of the sidebar until it has something in it', () => {
      http.expectOne(listUrl()).flush({ conversations: [] });

      chat.ask('How much leave do I have?');

      http
        .expectOne(`${API_BASE_URL}/api/conversations`)
        .flush({ id: 'conv-new', title: null, created_at: '2026-09-30T10:00:00' });

      // An id is not a conversation. Listing it now would put an untitled row in the
      // sidebar for as long as the answer took to arrive.
      expect(conversations.conversations()).toEqual([]);
    });

    it('opens an existing conversation and loads its thread', () => {
      givenRestoredConversations();

      chat.openConversation('conv-2');

      const request = http.expectOne(
        `${API_BASE_URL}/api/conversations/conv-2`,
      );

      expect(request.request.method).toBe('GET');
      request.flush({
        id: 'conv-2',
        title: 'Expenses',
        messages: [
          {
            id: 'e1',
            role: 'user',
            content: 'Mileage?',
            sources: null,
            created_at: '2026-09-28T09:00:00',
          },
          {
            id: 'e2',
            role: 'assistant',
            content: 'Forty pence.',
            sources: [],
            created_at: '2026-09-28T09:00:01',
          },
        ],
      });

      expect(chat.activeConversationId()).toBe('conv-2');
      expect(messages().map((message) => message.id)).toEqual(['e1', 'e2']);
    });

    it('keeps a conversation the route opened before the list arrived', () => {
      // A refresh on /response/:id opens the named conversation as soon as the id
      // is known, which can be before the sidebar's list has come back. The list
      // must not then replace it with the most recent one, which is a different
      // conversation and would read as the refresh having lost the thread.
      chat.openConversation('conv-2');

      http.expectOne(`${API_BASE_URL}/api/conversations/conv-2`).flush({
        id: 'conv-2',
        title: 'Expenses',
        messages: [
          {
            id: 'e1',
            role: 'user',
            content: 'Mileage?',
            sources: null,
            created_at: '2026-09-28T09:00:00',
          },
        ],
      });

      http.expectOne(listUrl()).flush(RESTORED_LIST);

      expect(chat.activeConversationId()).toBe('conv-2');
      expect(messages().map((message) => message.id)).toEqual(['e1']);
    });

    it('reports a conversation that is not there as missing rather than empty', () => {
      givenRestoredConversations();

      chat.openConversation('gone');
      http
        .expectOne(`${API_BASE_URL}/api/conversations/gone`)
        .flush({ detail: 'Not Found' }, { status: 404, statusText: 'Not Found' });

      // It leaves the list, which is the list's own recovery, and the open
      // conversation is reported as gone. An empty thread would read as a
      // conversation that lost its history, which is the opposite of what happened.
      expect(conversations.conversations().map((item) => item.id)).toEqual(['conv-1', 'conv-2']);
      expect(chat.isMissing()).toBe(true);
    });

    it('discards a thread that arrives for a conversation the user has left', () => {
      givenRestoredConversations();

      chat.openConversation('conv-2');
      const slow = http.expectOne(`${API_BASE_URL}/api/conversations/conv-2`);

      // Switched again before the thread arrived, so this one now belongs to a
      // conversation the user has already left.
      chat.openConversation('conv-1');
      http.expectOne(`${API_BASE_URL}/api/conversations/conv-1`).flush({
        id: 'conv-1',
        title: 'Annual leave',
        messages: [
          {
            id: 'm1',
            role: 'user',
            content: 'How much leave do I have?',
            sources: null,
            created_at: '2026-09-30T09:00:00',
          },
        ],
      });

      slow.flush({
        id: 'conv-2',
        title: 'Expenses',
        messages: [
          {
            id: 'e1',
            role: 'user',
            content: 'Mileage?',
            sources: null,
            created_at: '2026-09-28T09:00:00',
          },
        ],
      });

      expect(chat.activeConversationId()).toBe('conv-1');
      expect(messages().map((message) => message.id)).toEqual(['m1']);
    });
  });
});
