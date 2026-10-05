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
    confidence: 9,
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

    it('groups citations by document and numbers them once across the whole list', async () => {
      message = answeredMessage({
        sources: [
          SOURCE,
          { ...SOURCE, section: 'Section 4.3', snippet: 'Carryover is capped at five days.' },
          { ...SOURCE, document: 'HR Directory', section: 'Contacts', snippet: 'HR is listed here.' },
        ],
        documentCount: 2,
      });
      await render();

      // One heading per document rather than the document's name on every passage.
      const headings = Array.from(element().querySelectorAll('p')).filter((node) =>
        node.textContent?.trim() === 'Leave Policy' || node.textContent?.trim() === 'HR Directory',
      );
      expect(headings.length).toBe(2);

      // And the numbering runs 1, 2, 3 rather than restarting inside each document,
      // so "source 3" names one thing.
      const positions = Array.from(element().querySelectorAll('[aria-label^="Source "]')).map(
        (node) => node.getAttribute('aria-label'),
      );
      expect(positions).toEqual(['Source 1', 'Source 2', 'Source 3']);
    });

    it('names the document once and the section on each passage', async () => {
      message = answeredMessage({
        sources: [SOURCE, { ...SOURCE, section: 'Section 4.3', snippet: 'Another passage.' }],
        documentCount: 1,
      });
      await render();

      const labels = Array.from(element().querySelectorAll('p')).map((n) => n.textContent?.trim());

      // The document's name is the group heading, said once. Each passage says only
      // its section, which is the part that actually differs between them.
      expect(labels).toContain('Leave Policy');
      expect(labels).toContain('Section 4.2');
      expect(labels).toContain('Section 4.3');
      expect(labels.filter((label) => label === 'Leave Policy').length).toBe(1);
      expect(labels).not.toContain('Leave Policy · Section 4.2');
    });

    it('offers the whole passage when the excerpt is clipped', async () => {
      message = answeredMessage({
        sources: [{ ...SOURCE, snippet: 'A'.repeat(300) }],
        documentCount: 1,
      });
      await render();

      // Three lines is right for a reference list and useless for a passage that
      // answers the question in its fourth line.
      const toggle = Array.from(element().querySelectorAll('button')).find(
        (node) => node.textContent?.trim() === 'Show the whole passage',
      );
      expect(toggle).toBeTruthy();

      (toggle as HTMLButtonElement).click();
      await render();

      expect(
        Array.from(element().querySelectorAll('button')).some(
          (node) => node.textContent?.trim() === 'Show less',
        ),
      ).toBe(true);
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

  describe('confidence', () => {
    it('shows the figure beside the citations once the answer has finished', async () => {
      message = answeredMessage({ confidence: 7 });
      await render();

      expect(element().textContent).toContain('Confidence: 7/10');
    });

    it('shows nothing while the answer is still being written', async () => {
      // It scores the finished answer and the passages behind it. Mid-stream there
      // is no finished answer, and a number would be scoring text that does not exist.
      message = answeredMessage({ status: 'pending', confidence: 7 });
      streaming = true;
      await render();

      expect(element().textContent).not.toContain('Confidence');
    });

    it('shows nothing for an answer that cites nothing', async () => {
      // A greeting, a refusal and a gap in the corpus all carry no figure. Rendering
      // a low one would read as a poor answer rather than as the absence of one.
      message = answeredMessage({ sources: [], documentCount: 0, confidence: null });
      await render();

      expect(element().textContent).not.toContain('Confidence');
    });

    it('says what the figure is, because it is not a probability', async () => {
      message = answeredMessage({ confidence: 5 });
      await render();

      const line = Array.from(element().querySelectorAll('p')).find((node) =>
        node.textContent?.includes('Confidence'),
      );

      // "Confidence: 5/10" invites the reading that the answer is half wrong.
      expect(line?.getAttribute('title')).toContain('not a probability');
    });
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
