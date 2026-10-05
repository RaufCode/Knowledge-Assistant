import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { Message } from '../../../../core/models/message.model';
import { ChatThreadComponent } from './chat-thread.component';

/** Height of the visible part of the thread, in the units the tests scroll in. */
const VIEWPORT = 600;

/** A user message, which is all the thread needs to render both halves of a turn. */
function userMessage(id: string, text: string): Message {
  return {
    id,
    role: 'user',
    text,
    createdAt: '2026-09-30T08:00:00Z',
    status: 'answered',
    sources: [],
    documentCount: 0,
    confidence: null,
  };
}

/** An answer whose text can grow, as a streaming one does. */
function answerMessage(id: string, text: string): Message {
  return { ...userMessage(id, text), role: 'assistant', status: 'pending' };
}

/**
 * jsdom has no layout, so every scroll measurement reads zero. These stand in for
 * a viewport and a document tall enough to scroll, which is what the follow logic
 * reads.
 */
function giveScrollerGeometry(element: HTMLElement): { scrollHeight: number } {
  const geometry = { scrollHeight: 0 };

  Object.defineProperty(element, 'clientHeight', {
    configurable: true,
    get: () => VIEWPORT,
  });
  Object.defineProperty(element, 'scrollHeight', {
    configurable: true,
    get: () => geometry.scrollHeight,
  });

  return geometry;
}

describe('ChatThreadComponent', () => {
  let messages: ReturnType<typeof signal<Message[]>>;
  let fixture: ComponentFixture<ChatThreadComponent>;
  let scroller: HTMLElement;
  let geometry: { scrollHeight: number };

  /** Renders the current messages and lets the follow effect run. */
  const render = async (): Promise<void> => {
    fixture.componentRef.setInput('messages', messages());
    fixture.detectChanges();
    await fixture.whenStable();
  };

  /**
   * Puts the reader at `top` in a document `height` tall, as a scroll would.
   *
   * The height is set and the event dispatched together, so the component reads a
   * self-consistent position rather than one measured against a document that
   * changed underneath it.
   */
  const scrollTo = (height: number, top: number): void => {
    geometry.scrollHeight = height;
    scroller.scrollTop = top;
    scroller.dispatchEvent(new Event('scroll'));
    fixture.detectChanges();
  };

  /** Where the reader is after the document grows under them, with no scroll. */
  const grow = (height: number): void => {
    geometry.scrollHeight = height;
  };

  /** Grows the answer's text, as one delta of a stream does. */
  const streamMoreAnswerText = (text: string): void => {
    messages.update((list) => [list[0], { ...list[1], text }]);
  };

  beforeEach(async () => {
    messages = signal([userMessage('0-user', 'How much leave?'), answerMessage('0-assistant', '')]);

    await TestBed.configureTestingModule({ imports: [ChatThreadComponent] }).compileComponents();

    fixture = TestBed.createComponent(ChatThreadComponent);
    fixture.componentRef.setInput('messages', messages());
    fixture.detectChanges();
    await fixture.whenStable();

    scroller = (fixture.nativeElement as HTMLElement).querySelector('[role="log"]') as HTMLElement;
    geometry = giveScrollerGeometry(scroller);
  });

  it('offers no edit on a question that has already been answered', async () => {
    // Editing rewrites the question and sends it again as a new turn, so on an
    // answered question it offered to contradict the answer already on screen — and
    // that answer stayed put underneath, so the thread read as though the new question
    // had been asked before it.
    messages.set([userMessage('u1', 'How much leave?'), answerMessage('a1', 'Up to 21 days.')]);
    await render();

    const element = (): HTMLElement => fixture.nativeElement as HTMLElement;

    expect(element().querySelector('button[aria-label="Edit your question"]')).toBeNull();
  });

  it('still offers the edit on a question with no answer after it yet', async () => {
    // Nothing to contradict, so the correction is still worth offering.
    messages.set([userMessage('u1', 'How much leave?')]);
    await render();

    const element = (): HTMLElement => fixture.nativeElement as HTMLElement;

    expect(element().querySelector('button[aria-label="Edit your question"]')).not.toBeNull();
  });

  it('edits the newest of several turns without touching the older ones', async () => {
    messages.set([
      userMessage('u1', 'First question'),
      answerMessage('a1', 'An answer'),
      userMessage('u2', 'Second question'),
    ]);
    await render();

    const element = (): HTMLElement => fixture.nativeElement as HTMLElement;

    // The one with nothing after it. The first has an answer under it and offers
    // nothing at all, so exactly one edit is available across the thread.
    expect(element().querySelectorAll('button[aria-label="Edit your question"]').length).toBe(1);
  });

  it('is the scrollable area, and it is the one that grows', () => {
    // `flex-1` fills what the header and composer leave, `min-h-0` lets it shrink
    // below its content rather than growing the page, and `overflow-y-auto` turns
    // the overflow into a scroll here instead of on the document.
    expect(scroller.classList.contains('overflow-y-auto')).toBe(true);
    expect(scroller.classList.contains('flex-1')).toBe(true);
    expect(scroller.classList.contains('min-h-0')).toBe(true);
  });

  it('follows the answer as it streams in', async () => {
    scrollTo(1200, 1200 - VIEWPORT);
    grow(1600);
    streamMoreAnswerText('Full-time staff ');
    await render();

    // A delta grows the text inside a message already on screen, so the message
    // count never moves. Watching the count would leave the thread parked for the
    // whole of the answer, which is the thing streaming is for.
    expect(scroller.scrollTop).toBe(1600);

    grow(2400);
    streamMoreAnswerText('Full-time staff accrue 25 days.');
    await render();

    expect(scroller.scrollTop).toBe(2400);
  });

  it('follows a new turn that arrives', async () => {
    scrollTo(1200, 1200 - VIEWPORT);
    grow(3600);

    messages.update((list) => [
      ...list,
      userMessage('1-user', 'And carryover?'),
      answerMessage('1-assistant', ''),
    ]);
    await render();

    expect(scroller.scrollTop).toBe(3600);
  });

  it('leaves the reader where they are once they have scrolled up', async () => {
    scrollTo(3600, 1200);
    expect(scroller.scrollTop).toBe(1200);

    grow(4800);
    streamMoreAnswerText('A much longer answer ');
    await render();

    // Being dragged back to the bottom mid-answer takes away the line they were
    // reading. Following stops the moment they scroll up, not when the answer ends.
    expect(scroller.scrollTop).toBe(1200);
  });

  it('follows again once the reader is back at the bottom', async () => {
    scrollTo(3600, 1200);
    grow(4800);
    streamMoreAnswerText('A much longer answer ');
    await render();
    expect(scroller.scrollTop).toBe(1200);

    // Scrolling back down is the reader saying they want the newest lines again.
    scrollTo(4800, 4800 - VIEWPORT);
    await render();

    expect(scroller.scrollTop).toBe(4800);
  });

  it('ignores a scroll position a few pixels short of the bottom', async () => {
    scrollTo(3600, 3600 - VIEWPORT + 8);
    grow(4000);
    streamMoreAnswerText('More answer. ');
    await render();

    // Content grows between one render and the next, so a reader at the bottom can
    // end up a pixel off it without having scrolled away. Reading that as leaving
    // would stop the thread for the rest of the answer.
    expect(scroller.scrollTop).toBe(4000);
  });

  it('returns to the newest content when a new turn is asked after scrolling up', async () => {
    scrollTo(3600, 1200);
    expect(scroller.scrollTop).toBe(1200);

    grow(4200);
    messages.update((list) => [
      ...list,
      userMessage('1-user', 'And carryover?'),
      answerMessage('1-assistant', ''),
    ]);
    await render();

    // Asking a question means waiting for its answer. Following is only suspended
    // while they are reading something already written.
    expect(scroller.scrollTop).toBe(4200);
  });
  describe('drawing the four outcomes that cite nothing', () => {
    /**
     * A refusal, a greeting and a gap all arrive with no citations, so they can only
     * be told apart by the outcome the backend recorded. These assert each draws its
     * own card rather than falling through to the ordinary answer one.
     */
    const draw = async (status: Message['status'], text: string): Promise<void> => {
      messages.set([
        userMessage('1-user', 'A question'),
        { ...answerMessage('1-assistant', text), status },
      ]);
      await render();
    };

    const element = (): HTMLElement => fixture.nativeElement as HTMLElement;

    it('draws a refusal as withheld rather than as a failed search', async () => {
      await draw('restricted', "This question involves confidential information.");

      // "Not found in company documents" would claim the gap is in the documents,
      // when the answer was withheld on purpose and rephrasing will not help.
      expect(element().textContent).toContain('Not shared');
      expect(element().textContent).not.toContain('Not found in company documents');
    });

    it('draws a gap in the corpus as not found', async () => {
      await draw('not-found', "I couldn't find that in the company documents.");

      expect(element().textContent).toContain('Not found in company documents');
    });

    it('draws a greeting as an ordinary answer, because that is what it is', async () => {
      await draw('greeting', "Hello! I'm the assistant.");

      expect(element().querySelector('app-answer-restricted')).toBeNull();
      expect(element().querySelector('app-answer-not-found')).toBeNull();
      expect(element().querySelector('.answer-prose')?.textContent).toContain("Hello!");
    });
  });
});
