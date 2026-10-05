import { ComponentFixture, TestBed } from '@angular/core/testing';

import { Message } from '../../../../core/models/message.model';
import { MessageBubbleComponent } from './message-bubble.component';

/** A question as the thread renders it. */
function question(overrides: Partial<Message> = {}): Message {
  return {
    id: 'm1-user',
    role: 'user',
    text: 'How much annual leave do I get?',
    createdAt: '2026-09-30T08:00:00Z',
    status: 'answered',
    sources: [],
    documentCount: 0,
    confidence: null,
    ...overrides,
  };
}

describe('MessageBubbleComponent', () => {
  let fixture: ComponentFixture<MessageBubbleComponent>;
  let message: Message;
  let edits: { id: string; content: string }[];

  const element = (): HTMLElement => fixture.nativeElement as HTMLElement;

  const render = async (): Promise<void> => {
    fixture.detectChanges();
    await fixture.whenStable();
  };

  /** The button whose visible label matches, wherever it sits. */
  const button = (label: string): HTMLButtonElement | null =>
    Array.from(element().querySelectorAll<HTMLButtonElement>('button')).find(
      (candidate) => candidate.textContent?.trim() === label,
    ) ?? null;

  beforeEach(async () => {
    message = question();
    edits = [];

    await TestBed.configureTestingModule({
      imports: [MessageBubbleComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(MessageBubbleComponent);
    fixture.componentRef.setInput('message', message);
    fixture.componentInstance.edited.subscribe((edit) => edits.push(edit));
  });

  it('shows the question as it stands', async () => {
    await render();

    expect(element().textContent).toContain('How much annual leave do I get?');
  });

  it('opens an editor starting from what is already on screen', async () => {
    await render();

    element().querySelector<HTMLButtonElement>('button[aria-label="Edit your question"]')?.click();
    await render();

    // Starting from the existing wording rather than an empty box: this is a
    // correction, not a new question, and retyping 40 characters to fix one word is
    // how people give up on fixing it.
    const editor = element().querySelector('textarea');
    expect(editor?.value).toBe('How much annual leave do I get?');
  });

  it('says what will happen to the answer, before it happens', async () => {
    await render();
    element().querySelector<HTMLButtonElement>('button[aria-label="Edit your question"]')?.click();
    await render();

    // The answer to the old wording is about to be removed. Saying so while the
    // reader can still back out is the difference between a correction and a loss.
    expect(element().textContent).toContain('answer to the old wording is removed');
  });

  it('emits the message id with the correction, so nothing has to be guessed', async () => {
    await render();
    element().querySelector<HTMLButtonElement>('button[aria-label="Edit your question"]')?.click();
    await render();

    const editor = element().querySelector('textarea') as HTMLTextAreaElement;
    editor.value = 'How much annual leave do I accrue?';
    editor.dispatchEvent(new Event('input'));
    await render();

    button('Save and ask again')?.click();
    await render();

    expect(edits).toEqual([
      { id: 'm1-user', content: 'How much annual leave do I accrue?' },
    ]);
  });

  it('refuses to save a correction that says nothing', async () => {
    await render();
    element().querySelector<HTMLButtonElement>('button[aria-label="Edit your question"]')?.click();
    await render();

    const editor = element().querySelector('textarea') as HTMLTextAreaElement;
    editor.value = '  ';
    editor.dispatchEvent(new Event('input'));
    await render();

    // The backend's own floor is 3 characters. Sending shorter and having it refused
    // would spend a round trip on something the form could have known.
    expect(button('Save and ask again')?.disabled).toBe(true);
    expect(edits).toEqual([]);
  });

  it('refuses to save an unchanged question', async () => {
    await render();
    element().querySelector<HTMLButtonElement>('button[aria-label="Edit your question"]')?.click();
    await render();

    // Re-saving the same words would ask the same question again and throw the first
    // answer away for nothing.
    expect(button('Save and ask again')?.disabled).toBe(true);
  });

  it('discards the draft when cancelled', async () => {
    await render();
    element().querySelector<HTMLButtonElement>('button[aria-label="Edit your question"]')?.click();
    await render();

    const editor = element().querySelector('textarea') as HTMLTextAreaElement;
    editor.value = 'Something else entirely';
    editor.dispatchEvent(new Event('input'));
    await render();

    button('Cancel')?.click();
    await render();

    expect(edits).toEqual([]);
    expect(element().querySelector('textarea')).toBeNull();
    expect(element().textContent).toContain('How much annual leave do I get?');
  });

  it('offers no editor on a message that may not be edited', async () => {
    fixture.componentRef.setInput('canEdit', false);
    await render();

    // An assistant answer is generated text. Offering the control and refusing it
    // server-side would be a control that lies.
    expect(element().querySelector('button[aria-label="Edit your question"]')).toBeNull();
  });
});