import { ComponentFixture, TestBed } from '@angular/core/testing';

import { AnswerPendingComponent } from './answer-pending.component';

describe('AnswerPendingComponent', () => {
  let fixture: ComponentFixture<AnswerPendingComponent>;

  const element = (): HTMLElement => fixture.nativeElement as HTMLElement;

  const render = async (): Promise<void> => {
    fixture.detectChanges();
    await fixture.whenStable();
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AnswerPendingComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(AnswerPendingComponent);
  });

  it('shows no card around the waiting state', async () => {
    await render();

    // A bordered panel is a claim that something has been produced, and for the whole
    // wait nothing had been — which made the placeholder the most finished-looking
    // thing in the thread.
    const card = element().querySelector('.rounded-lg');

    expect(card).toBeNull();
    expect(element().querySelectorAll('app-skeleton').length).toBe(0);
  });

  it('shows no spinner, because the wait has no fixed length', async () => {
    await render();

    // A rotating arc claims a bounded job. This one is however long the model thinks,
    // which on a cold backend is most of a minute, and an arc that outlasts any honest
    // estimate is what makes a slow answer read as a hung one.
    expect(element().querySelector('app-icon')).toBeNull();
  });

  it('shows three bubbles', async () => {
    await render();

    expect(element().querySelectorAll('.thinking-bubble').length).toBe(3);
  });

  it('gives the bubbles different colours, so it is not another pulse', async () => {
    await render();

    const colours = Array.from(element().querySelectorAll('.thinking-bubble')).map((node) =>
      node.className.match(/bg-\S+/)?.[0],
    );

    // Three opacities of one hue is a pulse, which is what the skeleton was already
    // doing. Separate colours are what make this distinguishable at a glance.
    expect(new Set(colours).size).toBe(3);
  });

  it('staggers them, so they read as one thing happening', async () => {
    await render();

    const delays = Array.from(element().querySelectorAll<HTMLElement>('.thinking-bubble')).map(
      (node) => node.style.animationDelay,
    );

    expect(new Set(delays).size).toBe(3);
  });

  it('says what is happening in one word', async () => {
    await render();

    // A sentence about it sits on screen for the whole wait and becomes the thing
    // being read instead of the answer.
    expect(element().textContent).toContain('Thinking');
    expect(element().textContent).not.toContain('Reading the documents');
  });

  it('lets the caller say what is actually being waited on', async () => {
    fixture.componentRef.setInput('label', 'Loading conversation');
    fixture.componentRef.setInput('announcement', 'Loading this conversation.');
    await render();

    // A fetch is not thinking, and claiming work that is not happening is its own
    // small lie.
    expect(element().textContent).toContain('Loading conversation');
  });

  it('announces itself once, rather than on every change', async () => {
    await render();

    // A live region reads out every change. A label that varied would be announced
    // over and over for as long as the answer takes.
    expect(element().querySelector('[role="status"]')).not.toBeNull();
    expect(element().querySelectorAll('.sr-only').length).toBe(1);
  });
});
