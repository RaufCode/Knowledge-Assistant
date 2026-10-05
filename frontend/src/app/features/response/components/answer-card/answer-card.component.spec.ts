import { ComponentFixture, TestBed } from '@angular/core/testing';

import { Message, SourceReference } from '../../../../core/models/message.model';
import { AnswerCardComponent } from './answer-card.component';

/** One citation, as the backend returns it. */
const SOURCE: SourceReference = {
  document: 'Leave Policy',
  section: 'Section 4.2',
  snippet: 'Full-time staff accrue 25 days of annual leave.',
  score: 0.91,
};

/** A grounded answer with citations, which is what a finished turn looks like. */
function answeredMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: '0-assistant',
    role: 'assistant',
    text: 'You accrue 25 days of annual leave.',
    createdAt: '2026-09-30T08:00:00Z',
    status: 'answered',
    sources: [SOURCE],
    documentCount: 1,
    ...overrides,
  };
}

describe('AnswerCardComponent', () => {
  let fixture: ComponentFixture<AnswerCardComponent>;
  let message: Message;
  let streaming: boolean;

  const element = (): HTMLElement => fixture.nativeElement as HTMLElement;

  const render = async (): Promise<void> => {
    fixture.componentRef.setInput('message', message);
    fixture.componentRef.setInput('isStreaming', streaming);
    fixture.detectChanges();
    await fixture.whenStable();
  };

  beforeEach(async () => {
    message = answeredMessage();
    streaming = false;

    await TestBed.configureTestingModule({ imports: [AnswerCardComponent] }).compileComponents();
    fixture = TestBed.createComponent(AnswerCardComponent);
  });

  describe('citations', () => {
    it('are shown on a finished answer', async () => {
      await render();

      expect(element().querySelectorAll('app-source-tag').length).toBe(1);
      expect(element().textContent).toContain('Grounded in 1 document');
    });

    it('are withheld while the answer is still arriving', async () => {
      // A stream that leads with its citations shows a list that the answer below
      // it may contradict. A half-written answer has no citations to show, and
      // claiming otherwise is a claim the app would have to take back.
      message = answeredMessage({ text: 'You accrue 25', status: 'pending' });
      streaming = true;
      await render();

      expect(element().querySelectorAll('app-source-tag').length).toBe(0);
      expect(element().textContent).not.toContain('Grounded in');
    });

    it('appear once the answer finishes, without the message changing', async () => {
      // The same turn, streamed and then closed. Only `isStreaming` moves, so a
      // citation list cannot depend on the answer being re-delivered to show up.
      message = answeredMessage({ text: 'You accrue 25', status: 'pending' });
      streaming = true;
      await render();
      expect(element().querySelectorAll('app-source-tag').length).toBe(0);

      message = answeredMessage();
      streaming = false;
      await render();

      expect(element().querySelectorAll('app-source-tag').length).toBe(1);
    });

    it('key repeats of the same document apart so neither is dropped', async () => {
      // One heavily cited policy is legitimate. Angular's track-by would collide
      // these on document and section alone and render one of the two.
      message = answeredMessage({
        sources: [SOURCE, { ...SOURCE, snippet: 'Carryover is capped at five days.' }],
        documentCount: 1,
      });
      await render();

      const tags = element().querySelectorAll('app-source-tag');
      expect(tags.length).toBe(2);
      expect(tags[0].textContent).not.toBe(tags[1].textContent);
    });

    it('show nothing for an answer with no sources', async () => {
      message = answeredMessage({ sources: [], documentCount: 0, status: 'not-found' });
      await render();

      expect(element().querySelectorAll('app-source-tag').length).toBe(0);
      expect(element().textContent).not.toContain('Grounded in');
    });
  });

  it('hides the copy control while the answer is still being written', async () => {
    streaming = true;
    await render();

    // Copying mid-stream copies half an answer, which is worse than not offering it.
    const copy = element().querySelector<HTMLButtonElement>('button[type="button"]');
    expect(copy?.hidden).toBe(true);
  });

  it('reports how many distinct documents the answer rests on', async () => {
    message = answeredMessage({
      sources: [SOURCE, { ...SOURCE, document: 'Carryover Policy' }],
      documentCount: 2,
    });
    await render();

    expect(element().textContent).toContain('Grounded in 2 documents');
  });

  describe('while the answer is streaming', () => {
    const prose = (): HTMLElement =>
      element().querySelector('.answer-prose') as HTMLElement;

    beforeEach(async () => {
      message = answeredMessage({ status: 'pending', text: 'You accrue 25 days', sources: [] });
      streaming = true;
      await render();
    });

    it('marks the text rather than adding a node beside it', () => {
      // A node after the prose would be a sibling of the whole answer and draw below
      // the last line, which is the bug this replaced.
      expect(prose().classList.contains('is-streaming')).toBe(true);
      expect(element().querySelector('.answer-prose ~ span')).toBeNull();
    });

    it('keeps the cursor out of the message itself', () => {
      // It is generated content keyed off the text, so it cannot be part of what is
      // stored, copied, or re-rendered as the finished answer.
      expect(message.text).not.toContain('|');
      expect(prose().textContent).not.toContain('|');
      expect(prose().innerHTML).not.toContain('|');
    });

    it('does not reserve the room the copy control needs, which is hidden anyway', () => {
      // Otherwise the cursor trails the text by 64px on the last line.
      expect(element().querySelector('button[aria-label], button')?.hasAttribute('hidden')).toBe(
        true,
      );
      expect(prose().classList.contains('pr-16')).toBe(false);
    });

    it('drops the cursor entirely once streaming stops', async () => {
      streaming = false;
      await render();

      expect(prose().classList.contains('is-streaming')).toBe(false);
      expect(prose().textContent).not.toContain('|');
    });
  });
});
