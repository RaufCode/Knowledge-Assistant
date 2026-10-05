import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { API_BASE_URL } from '../api.config';
import type { Conversation, ConversationThread } from '../models/conversation.model';
import { ApiError, ApiService } from './api.service';

/** A citation exactly as the backend sends one. */
const SOURCE = {
  document: 'Leave Policy',
  section: 'Section 4.2',
  snippet: 'Annual leave accrues monthly at 1.67 days per month.',
  score: 0.82,
};

/** The client id this suite sends, standing in for the one in local storage. */
const CLIENT = 'ika-test-client-0001';

describe('ApiService', () => {
  let api: ApiService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });

    api = TestBed.inject(ApiService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    vi.unstubAllGlobals();
  });

  describe('endpoint shapes', () => {
    it('opens a conversation by posting the client id', () => {
      let created: { id: string; title: string | null; created_at: string } | undefined;

      api.createConversation(CLIENT).subscribe((response) => (created = response));

      const request = http.expectOne(`${API_BASE_URL}/api/conversations`);

      expect(request.request.method).toBe('POST');
      // The backend's field names are snake_case and are not the frontend's to
      // change, so the body is asserted on the wire rather than on a renamed copy.
      expect(request.request.body).toEqual({ client_id: CLIENT });
      request.flush({ id: 'conv-1', title: null, created_at: '2026-09-30T09:00:00' });
      expect(created?.id).toBe('conv-1');
    });

    it('lists conversations for a client, naming it in the query', () => {
      let conversations: Conversation[] = [];

      api.getConversations(CLIENT).subscribe((value) => (conversations = value));

      const request = http.expectOne(`${API_BASE_URL}/api/conversations?client_id=${CLIENT}`);

      expect(request.request.method).toBe('GET');
      request.flush({
        conversations: [
          { id: 'conv-1', title: 'Leave', updated_at: '2026-09-30T09:00:00' },
          { id: 'conv-2', title: null, updated_at: '2026-09-29T09:00:00' },
        ],
      });

      expect(conversations.map((conversation) => conversation.id)).toEqual(['conv-1', 'conv-2']);
    });

    it('reads one conversation with its messages and names the client in the query', () => {
      let thread: ConversationThread | undefined;

      api.getConversation('conv-1', CLIENT).subscribe((value) => (thread = value));

      const request = http.expectOne(`${API_BASE_URL}/api/conversations/conv-1?client_id=${CLIENT}`);

      expect(request.request.method).toBe('GET');
      request.flush({
        id: 'conv-1',
        title: 'Leave',
        messages: [
          { id: 'm1', role: 'user', content: 'How much leave?', sources: null, created_at: '2026-09-30T09:00:00' },
          { id: 'm2', role: 'assistant', content: 'Twenty days.', sources: [SOURCE], created_at: '2026-09-30T09:00:01' },
        ],
      });

      expect(thread?.title).toBe('Leave');
      expect(thread?.messages.map((message) => message.text)).toEqual([
        'How much leave?',
        'Twenty days.',
      ]);
    });

    it('reads each stored outcome back as itself', async () => {
      let thread: ConversationThread | undefined;

      api.getConversation('conv-1', CLIENT).subscribe((value) => (thread = value));

      // Four replies that all cite nothing. Only the recorded outcome tells a
      // greeting from a refusal from a genuine gap, so a thread reopened tomorrow
      // draws the same cards it did while it was being answered.
      http.expectOne(`${API_BASE_URL}/api/conversations/conv-1?client_id=${CLIENT}`).flush({
        id: 'conv-1',
        title: null,
        messages: [
          { id: 'm1', role: 'user', content: 'Hello', sources: null, status: null, confidence: null, created_at: '2026-09-30T09:00:00' },
          { id: 'm2', role: 'assistant', content: "Hello! I'm the assistant.", sources: null, status: 'greeting', confidence: null, created_at: '2026-09-30T09:00:01' },
          { id: 'm3', role: 'assistant', content: 'Confidential.', sources: null, status: 'restricted', confidence: null, created_at: '2026-09-30T09:00:02' },
          { id: 'm4', role: 'assistant', content: "I couldn't find that.", sources: null, status: 'not-found', confidence: null, created_at: '2026-09-30T09:00:03' },
        ],
      });

      expect(thread?.messages.map((message) => message.status)).toEqual([
        'answered',
        'greeting',
        'restricted',
        'not-found',
      ]);
    });

    it('reads the confidence the backend derived from the citations', async () => {
      let thread: ConversationThread | undefined;

      api.getConversation('conv-1', CLIENT).subscribe((value) => (thread = value));

      http.expectOne(`${API_BASE_URL}/api/conversations/conv-1?client_id=${CLIENT}`).flush({
        id: 'conv-1',
        title: null,
        messages: [
          {
            id: 'm1',
            role: 'assistant',
            content: 'Twenty days.',
            sources: [SOURCE],
            status: 'answered',
            confidence: 8,
            created_at: '2026-09-30T09:00:00',
          },
        ],
      });

      expect(thread?.messages[0].confidence).toBe(8);
    });

    it('reads a row stored before outcomes were recorded as before', async () => {
      let thread: ConversationThread | undefined;

      api.getConversation('conv-1', CLIENT).subscribe((value) => (thread = value));

      // No status on the row. The citations are all the evidence there is, so an
      // ungrounded answer falls back to the not-found card and a grounded one to the
      // answer card. These threads are old, and this is the best that can be said
      // about them.
      http.expectOne(`${API_BASE_URL}/api/conversations/conv-1?client_id=${CLIENT}`).flush({
        id: 'conv-1',
        title: null,
        messages: [
          { id: 'm1', role: 'assistant', content: 'Twenty days.', sources: [SOURCE], created_at: '2026-09-30T09:00:00' },
          { id: 'm2', role: 'assistant', content: "I couldn't find that.", sources: null, created_at: '2026-09-30T09:00:01' },
        ],
      });

      expect(thread?.messages.map((message) => message.status)).toEqual(['answered', 'not-found']);
    });

    it('escapes both the conversation id and the client id', () => {
      api.getConversation('a/b?c', CLIENT).subscribe();

      http
        .expectOne(`${API_BASE_URL}/api/conversations/a%2Fb%3Fc?client_id=${CLIENT}`)
        .flush({ id: 'a/b?c', title: null, messages: [] });
    });

    it('renames with a PATCH carrying the new title', () => {
      let completed = false;

      api.renameConversation('conv-1', CLIENT, 'Leave rules').subscribe(() => (completed = true));

      const request = http.expectOne(`${API_BASE_URL}/api/conversations/conv-1`);

      expect(request.request.method).toBe('PATCH');
      expect(request.request.body).toEqual({ client_id: CLIENT, title: 'Leave rules' });
      request.flush(null);
      // Nothing useful comes back, so the service returns nothing rather than a
      // response a caller would have to know to ignore.
      expect(completed).toBe(true);
    });

    it('deletes with the client id in the query, since a DELETE has no body worth reading', () => {
      api.deleteConversation('conv-1', CLIENT).subscribe();

      const request = http.expectOne(`${API_BASE_URL}/api/conversations/conv-1?client_id=${CLIENT}`);

      expect(request.request.method).toBe('DELETE');
      request.flush(null);
    });
  });

  describe('mapping', () => {
    it('keeps an unnamed conversation null rather than inventing a name for it', () => {
      let conversations: Conversation[] = [];

      api.getConversations(CLIENT).subscribe((value) => (conversations = value));
      http.expectOne(`${API_BASE_URL}/api/conversations?client_id=${CLIENT}`).flush({
        conversations: [{ id: 'conv-1', title: null, updated_at: '2026-09-30T09:00:00' }],
      });

      // Null is what lets the sidebar tell "not yet named" from a real title, and
      // that is a decision made where the conversation is shown, not here.
      expect(conversations[0].title).toBeNull();
    });

    it('reads timestamps as UTC, so ordering does not shift with the browser offset', () => {
      let conversations: Conversation[] = [];

      api.getConversations(CLIENT).subscribe((value) => (conversations = value));
      http.expectOne(`${API_BASE_URL}/api/conversations?client_id=${CLIENT}`).flush({
        conversations: [{ id: 'conv-1', title: 'Leave', updated_at: '2026-09-30T09:00:00' }],
      });

      expect(conversations[0].updatedAt).toBe('2026-09-30T09:00:00Z');
      expect(new Date(conversations[0].updatedAt).getTime()).toBe(
        Date.parse('2026-09-30T09:00:00Z'),
      );
    });

    it('leaves a timestamp that already carries an offset alone', () => {
      let conversations: Conversation[] = [];

      api.getConversations(CLIENT).subscribe((value) => (conversations = value));
      http.expectOne(`${API_BASE_URL}/api/conversations?client_id=${CLIENT}`).flush({
        conversations: [{ id: 'conv-1', title: null, updated_at: '2026-09-30T09:00:00+02:00' }],
      });

      // Appending another designator would make the value unparseable, so the
      // check has to distinguish "no designator" from "a designator is present".
      expect(conversations[0].updatedAt).toBe('2026-09-30T09:00:00+02:00');
    });

    it('maps a stored message as finished, since only a local one can be pending', () => {
      let thread: ConversationThread | undefined;

      api.getConversation('conv-1', CLIENT).subscribe((value) => (thread = value));
      http.expectOne(`${API_BASE_URL}/api/conversations/conv-1?client_id=${CLIENT}`).flush({
        id: 'conv-1',
        title: null,
        messages: [
          { id: 'm1', role: 'user', content: 'Leave?', sources: null, created_at: '2026-09-30T09:00:00' },
          { id: 'm2', role: 'assistant', content: 'Twenty days.', sources: [SOURCE], created_at: '2026-09-30T09:00:01' },
        ],
      });

      const [question, answer] = thread?.messages ?? [];

      // A message that came from the backend has been written down. Pending and
      // failed belong to an answer being streamed in this browser.
      expect(question?.status).toBe('answered');
      expect(answer?.status).toBe('answered');
      // A question cites nothing, and null becomes an empty list so no consumer
      // has to check.
      expect(question?.sources).toEqual([]);
      expect(answer?.sources).toEqual([SOURCE]);
      // The count of distinct documents is derived from the passages it is
      // rendered from, so it cannot fall out of step with them.
      expect(answer?.documentCount).toBe(1);
    });

    it('derives the document count from distinct documents, not from citations', () => {
      let thread: ConversationThread | undefined;

      api.getConversation('conv-1', CLIENT).subscribe((value) => (thread = value));
      http.expectOne(`${API_BASE_URL}/api/conversations/conv-1?client_id=${CLIENT}`).flush({
        id: 'conv-1',
        title: null,
        messages: [
          { id: 'm1', role: 'user', content: 'Leave?', sources: null, created_at: '2026-09-30T09:00:00' },
          {
            id: 'm2',
            role: 'assistant',
            content: 'It depends.',
            sources: [SOURCE, { ...SOURCE, section: 'Section 9' }, { ...SOURCE, document: 'Staff Handbook' }],
            created_at: '2026-09-30T09:00:01',
          },
        ],
      });

      // Two passages from the leave policy are one document, not two.
      expect(thread?.messages[1].documentCount).toBe(2);
    });

    it('tolerates a message with no sources field rather than crashing on it', () => {
      let thread: ConversationThread | undefined;

      api.getConversation('conv-1', CLIENT).subscribe((value) => (thread = value));
      http.expectOne(`${API_BASE_URL}/api/conversations/conv-1?client_id=${CLIENT}`).flush({
        id: 'conv-1',
        title: null,
        messages: [{ id: 'm1', role: 'user', content: 'Leave?', created_at: '2026-09-30T09:00:00' }],
      });

      expect(thread?.messages[0].sources).toEqual([]);
    });
  });

  describe('failures', () => {
    it('marks a 5xx as transient so the thread can offer a retry', () => {
      let error: ApiError | undefined;

      api
        .getConversation('conv-1', CLIENT)
        .subscribe({ error: (value: ApiError) => (error = value) });

      http
        .expectOne(`${API_BASE_URL}/api/conversations/conv-1?client_id=${CLIENT}`)
        .flush('Internal Server Error', { status: 500, statusText: 'Server Error' });

      expect(error).toBeInstanceOf(ApiError);
      expect(error?.isTransient).toBe(true);
      expect(error?.status).toBe(500);
    });

    it('marks a 404 as permanent, since a missing conversation cannot be retried into being there', () => {
      let error: ApiError | undefined;

      api.getConversation('gone', CLIENT).subscribe({ error: (value: ApiError) => (error = value) });

      http
        .expectOne(`${API_BASE_URL}/api/conversations/gone?client_id=${CLIENT}`)
        .flush('Not Found', { status: 404, statusText: 'Not Found' });

      expect(error?.isTransient).toBe(false);
      expect(error?.status).toBe(404);
      // Said in the model's own terms, because the sidebar offers to go back to
      // the list rather than retry this request.
      expect(error?.message).toContain('no longer available');
    });

    it("passes the backend's own wording through for a rejected message", async () => {
      let error: ApiError | undefined;

      // Two characters is below the API's minimum, which it answers with a 422.
      // The stream is read with `fetch` rather than `HttpClient`, so a refusal
      // before the stream opens is stubbed at the same place the stream itself is.
      vi.stubGlobal('fetch', () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              detail: [
                {
                  loc: ['body', 'content'],
                  msg: 'String should have at least 3 characters',
                  type: 'string_too_short',
                },
              ],
            }),
            { status: 422, headers: { 'Content-Type': 'application/json' } },
          ),
        ),
      );

      api
        .sendMessage('conv-1', CLIENT, 'Hi')
        .subscribe({ error: (value: ApiError) => (error = value) });
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(error?.message).toBe('String should have at least 3 characters');
      expect(error?.isTransient).toBe(false);
    });

    it('reports a network failure as transient and without a status', () => {
      let error: ApiError | undefined;

      api
        .getConversations(CLIENT)
        .subscribe({ error: (value: ApiError) => (error = value) });

      http
        .expectOne(`${API_BASE_URL}/api/conversations?client_id=${CLIENT}`)
        .error(new ProgressEvent('error'), { status: 0 });

      expect(error?.status).toBe(0);
      expect(error?.isTransient).toBe(true);
      expect(error?.message).toContain('Could not get a response from the assistant');
    });

    it('does not retry a message request, because a retry would post the message twice', async () => {
      let calls = 0;
      let failures = 0;

      vi.stubGlobal('fetch', () => {
        calls += 1;

        return Promise.resolve(new Response('boom', { status: 500 }));
      });

      api
        .sendMessage('conv-1', CLIENT, 'Leave?')
        .subscribe({ error: () => (failures += 1) });
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));

      // One attempt, one failure. Sending a message again by itself would leave the
      // same question in the conversation twice, which is the user's to clean up.
      expect(calls).toBe(1);
      expect(failures).toBe(1);
    });
  });

  describe('streaming', () => {
    /** Writes one raw text chunk into the open stream, as a network read would. */
    let pushChunk: (text: string) => void = () => undefined;

    /** Ends the stream. */
    let closeChunk: () => void = () => undefined;

    /** The signal of the request the stub was asked to serve. */
    let signal: AbortSignal | undefined = undefined;

    /**
     * Serves the messages endpoint as a chunked body.
     *
     * `HttpClient` is no help here: it buffers a response and delivers it whole,
     * so the stub exposes a raw body the test writes to directly, splitting
     * wherever it likes the way a real chunked response does.
     */
    const givenStreamingEndpoint = (): void => {
      signal = undefined;

      vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
        signal = init.signal ?? undefined;

        return new Promise<Response>((resolve) => {
          const encoder = new TextEncoder();
          let controller!: ReadableStreamDefaultController<Uint8Array>;

          pushChunk = (text) => controller.enqueue(encoder.encode(text));
          closeChunk = () => controller.close();

          resolve(
            new Response(
              new ReadableStream<Uint8Array>({
                start(streamController) {
                  controller = streamController;
                },
              }),
              { status: 200 },
            ),
          );
        });
      });
    };

    /** One server-sent event as it goes over the wire. */
    const frame = (event: Record<string, unknown>): string =>
      `data: ${JSON.stringify(event)}\n\n`;

    /** Lets the read loop drain what was just written. */
    const settle = async (): Promise<void> => {
      for (let i = 0; i < 5; i += 1) {
        await Promise.resolve();
      }

      await new Promise((resolve) => setTimeout(resolve, 0));
    };

    beforeEach(givenStreamingEndpoint);

    afterEach(() => vi.unstubAllGlobals());

    it('posts the client id and the message to the conversation', async () => {
      const calls: unknown[] = [];

      vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
        calls.push({ url, method: init.method, body: JSON.parse(String(init.body)) });

        return Promise.resolve(new Response('', { status: 200 }));
      });

      api.sendMessage('conv-1', CLIENT, 'How much annual leave do I have?').subscribe();
      await settle();

      expect(calls).toEqual([
        {
          url: `${API_BASE_URL}/api/conversations/conv-1/messages`,
          method: 'POST',
          body: { client_id: CLIENT, content: 'How much annual leave do I have?' },
        },
      ]);
    });

    it('emits each event as its frame arrives, before the stream ends', async () => {
      const received: unknown[] = [];

      api.sendMessage('conv-1', CLIENT, 'How much leave?').subscribe((event) => received.push(event));
      await settle();

      pushChunk(frame({ type: 'status', stage: 'writing' }));
      await settle();

      // The answer is nowhere near started, but the client is already being told
      // what is happening, which is what keeps a long first token from looking
      // like a hang.
      expect(received).toEqual([{ type: 'status', stage: 'writing' }]);

      pushChunk(frame({ type: 'delta', text: 'Twenty ' }));
      await settle();

      expect(received).toEqual([
        { type: 'status', stage: 'writing' },
        { type: 'delta', text: 'Twenty ' },
      ]);

      pushChunk(frame({ type: 'delta', text: 'days.' }));
      await settle();
      pushChunk(frame({ type: 'done', answer: 'Twenty days.', answered: true, sources: [] }));
      closeChunk();
      await settle();

      expect(received).toEqual([
        { type: 'status', stage: 'writing' },
        { type: 'delta', text: 'Twenty ' },
        { type: 'delta', text: 'days.' },
        { type: 'done', answer: 'Twenty days.', answered: true, sources: [] },
      ]);
    });

    it('passes a title frame through, since naming happens beside the first answer', async () => {
      const received: unknown[] = [];

      api.sendMessage('conv-1', CLIENT, 'How much leave?').subscribe((event) => received.push(event));
      await settle();

      pushChunk(frame({ type: 'done', answer: 'Twenty days.', answered: true, sources: [] }));
      pushChunk(frame({ type: 'title', title: 'Annual leave allowance' }));
      closeChunk();
      await settle();

      // After `done`, because the title is generated in parallel with the answer
      // and the answer is what finishes first.
      expect(received).toEqual([
        { type: 'done', answer: 'Twenty days.', answered: true, sources: [] },
        { type: 'title', title: 'Annual leave allowance' },
      ]);
    });

    it('reassembles a frame that arrives split across two chunks', async () => {
      const received: unknown[] = [];
      const whole = frame({ type: 'delta', text: 'Twenty days.' });
      const split = Math.floor(whole.length / 2);

      api.sendMessage('conv-1', CLIENT, 'How much leave?').subscribe((event) => received.push(event));
      await settle();

      // Half a frame first. Emitting that would hand over a truncated event.
      pushChunk(whole.slice(0, split));
      await settle();

      expect(received).toEqual([]);

      pushChunk(whole.slice(split));
      await settle();

      expect(received).toEqual([{ type: 'delta', text: 'Twenty days.' }]);
    });

    it('ignores keep-alive comments, which are not events', async () => {
      const received: unknown[] = [];

      api.sendMessage('conv-1', CLIENT, 'How much leave?').subscribe((event) => received.push(event));
      await settle();

      pushChunk(': keep-alive\n\n');
      pushChunk(frame({ type: 'delta', text: 'Yes.' }));
      await settle();

      expect(received).toEqual([{ type: 'delta', text: 'Yes.' }]);
    });

    it('fails with the backend status when the stream is refused', async () => {
      let failure: ApiError | undefined;

      vi.stubGlobal('fetch', () =>
        Promise.resolve(new Response(null, { status: 422, statusText: 'Unprocessable' })),
      );

      api
        .sendMessage('conv-1', CLIENT, 'Hi')
        .subscribe({ error: (error: ApiError) => (failure = error) });
      await settle();

      expect(failure?.status).toBe(422);
    });

    it('reports a refused conversation as missing rather than as a failed question', async () => {
      let failure: ApiError | undefined;

      // A conversation belonging to another client is a 404 the backend answers
      // before the stream opens, so the body is ordinary JSON.
      vi.stubGlobal('fetch', () =>
        Promise.resolve(
          new Response(JSON.stringify({ detail: 'Not Found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
      );

      api
        .sendMessage('someone-elses', CLIENT, 'How much leave?')
        .subscribe({ error: (error: ApiError) => (failure = error) });
      await settle();

      expect(failure?.status).toBe(404);
      expect(failure?.isTransient).toBe(false);
    });

    it('stops reading when the subscription is torn down', async () => {
      const received: unknown[] = [];
      const subscription = api
        .sendMessage('conv-1', CLIENT, 'How much leave?')
        .subscribe((event) => received.push(event));

      await settle();
      subscription.unsubscribe();

      expect(signal?.aborted).toBe(true);

      // A delta that arrives after the user moved on must not reach a view that
      // has already re-rendered around a different question.
      pushChunk(frame({ type: 'delta', text: 'Too late.' }));
      await settle();

      expect(received).toEqual([]);
    });
  });
});
