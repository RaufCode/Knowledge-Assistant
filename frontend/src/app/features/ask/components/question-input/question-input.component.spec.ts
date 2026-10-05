import { ComponentFixture, TestBed } from '@angular/core/testing';

import { QuestionInputComponent } from './question-input.component';

describe('QuestionInputComponent', () => {
  let fixture: ComponentFixture<QuestionInputComponent>;
  let busy: boolean;
  let asked: string[];

  const element = (): HTMLElement => fixture.nativeElement as HTMLElement;

  const textarea = (): HTMLTextAreaElement => element().querySelector('textarea') as HTMLTextAreaElement;

  const render = async (): Promise<void> => {
    fixture.componentRef.setInput('isBusy', busy);
    fixture.detectChanges();
    await fixture.whenStable();
  };

  /** Types into the field as a user would, rather than setting the control. */
  const type = (text: string): void => {
    textarea().value = text;
    textarea().dispatchEvent(new Event('input'));
    fixture.detectChanges();
  };

  beforeEach(async () => {
    busy = false;
    asked = [];

    await TestBed.configureTestingModule({ imports: [QuestionInputComponent] }).compileComponents();
    fixture = TestBed.createComponent(QuestionInputComponent);
    fixture.componentInstance.ask.subscribe((question: string) => asked.push(question));
    await render();
  });

  it('clears the field after sending, so the next question starts clean', async () => {
    type('How much annual leave do I have?');
    element().querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
    await fixture.whenStable();

    expect(asked).toEqual(['How much annual leave do I have?']);
    expect(textarea().value).toBe('');
  });

  it('will not send a question the backend would reject', async () => {
    // The same minimum length the API enforces. Sending a two-character question
    // only to be told 422 is a wasted round trip and a visible error for a typo.
    type('Hi');
    await fixture.whenStable();

    expect(element().querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);

    type('How much leave?');
    await fixture.whenStable();

    expect(element().querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
  });

  it('will not send while a request is in flight', async () => {
    type('How much annual leave do I have?');
    busy = true;
    await render();

    // A second question sent during the first would interleave two answers in one
    // conversation, leaving the reader with two half-answers and no way to tell
    // which answered what.
    expect(element().querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
  });

  it('sends a padded question trimmed, and leaves the padding in the field', async () => {
    type('  How much annual leave do I have?  ');
    element().querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
    await fixture.whenStable();

    expect(asked).toEqual(['How much annual leave do I have?']);
  });

  it('sends on Enter, so a question needs one keystroke rather than two', async () => {
    type('How much annual leave do I have?');
    textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await fixture.whenStable();

    expect(asked).toEqual(['How much annual leave do I have?']);
  });

  it('leaves a newline to Shift+Enter, so a long question can be written in parts', async () => {
    type('How much annual leave');
    textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true }));
    await fixture.whenStable();

    // Inserting a line break is not sending. Sending on a shifted Enter would lose
    // half a question every time someone formatted it.
    expect(asked).toEqual([]);
  });
});
