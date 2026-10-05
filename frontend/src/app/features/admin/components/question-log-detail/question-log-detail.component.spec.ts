import { ComponentFixture, TestBed } from '@angular/core/testing';

import { type QuestionLog } from '../../../../core/models/question-log.model';
import { QuestionLogDetailComponent } from './question-log-detail.component';

describe('QuestionLogDetailComponent', () => {
  let fixture: ComponentFixture<QuestionLogDetailComponent>;
  let closed: number;

  const element = (): HTMLElement => fixture.nativeElement as HTMLElement;

  const SOURCE = {
    document: 'Employee Handbook 2026',
    section: 'Section 4.2',
    snippet: 'Full-time employees are entitled to twenty-five (25) working days of leave.',
    score: 0.81,
  };

  const log = (overrides: Partial<QuestionLog> = {}): QuestionLog => ({
    id: 'q-1',
    question: 'How many annual leave days do I get?',
    askedBy: 'Ama Konadu',
    askedByInitials: 'AK',
    createdAt: new Date().toISOString(),
    outcome: 'answered',
    answer: 'Twenty-five days a year, accruing monthly.',
    sources: [SOURCE],
    durationMs: 2400,
    ...overrides,
  });

  const render = async (): Promise<void> => {
    fixture.detectChanges();
    await fixture.whenStable();
  };

  beforeEach(async () => {
    closed = 0;

    await TestBed.configureTestingModule({
      imports: [QuestionLogDetailComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(QuestionLogDetailComponent);
    fixture.componentInstance.closed.subscribe(() => closed++);
  });

  it('shows the whole question, which the list truncates', async () => {
    fixture.componentRef.setInput('log', log());
    await render();

    expect(element().textContent).toContain('How many annual leave days do I get?');
  });

  it('shows the answer the asker was given', async () => {
    fixture.componentRef.setInput('log', log());
    await render();

    expect(element().textContent).toContain('Twenty-five days a year, accruing monthly.');
    expect(element().textContent).toContain('Answer given');
  });

  it('keeps a miss distinct from a request that failed', async () => {
    // A not-found still produced an answer: the assistant explaining that the
    // corpus has nothing. Reading it as an error would send an administrator
    // looking in the wrong place.
    fixture.componentRef.setInput(
      'log',
      log({ outcome: 'not-found', answer: 'I could not find anything about leave balances.' }),
    );
    await render();

    expect(element().textContent).toContain('I could not find anything about leave balances.');
    expect(element().textContent).not.toContain('No answer was produced');
  });

  it('says plainly when nothing was ever produced', async () => {
    fixture.componentRef.setInput('log', log({ outcome: 'failed', answer: null, sources: [] }));
    await render();

    expect(element().textContent).toContain('No answer was produced');
    expect(element().textContent).toContain('says nothing about the documents');
  });

  it('calls near-misses the closest passages rather than sources', async () => {
    // They were retrieved and then rejected. Labelling them sources would claim
    // they backed an answer that was never written.
    fixture.componentRef.setInput('log', log({ outcome: 'not-found' }));
    await render();

    expect(element().textContent).toContain('Closest passages');

    // Each passage names its own document here, because this list has no group
    // heading above it. Turning that off — as the answer card does, where the heading
    // carries the document — would leave an administrator unable to tell which policy
    // a passage came from.
    expect(element().textContent).toContain('Employee Handbook 2026');
  });

  it('says an empty retrieval is empty rather than implying a gap', async () => {
    fixture.componentRef.setInput('log', log({ sources: [] }));
    await render();

    expect(element().textContent).toContain('Nothing was retrieved for this question');
  });

  it('states the review actions it cannot do instead of offering dead buttons', async () => {
    fixture.componentRef.setInput('log', log());
    await render();

    expect(element().textContent).toContain('not connected yet');

    const labels = Array.from(element().querySelectorAll('button')).map((button) =>
      button.textContent?.trim(),
    );
    expect(labels).not.toContain('Mark reviewed');
  });

  it('emits closed so the list can drop its selection', async () => {
    fixture.componentRef.setInput('log', log());
    await render();

    (element().querySelector('button[aria-label="Close question log"]') as HTMLButtonElement).click();
    await render();

    expect(closed).toBe(1);
  });
});
