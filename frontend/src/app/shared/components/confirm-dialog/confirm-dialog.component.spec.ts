import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ConfirmDialogComponent } from './confirm-dialog.component';

describe('ConfirmDialogComponent', () => {
  let fixture: ComponentFixture<ConfirmDialogComponent>;
  let confirmed: number;
  let cancelled: number;

  const element = (): HTMLElement => fixture.nativeElement as HTMLElement;

  /** The dialog's own buttons, in the order they are declared. */
  const buttons = (): HTMLButtonElement[] =>
    Array.from(element().querySelectorAll<HTMLButtonElement>('dialog button'));

  const render = async (): Promise<void> => {
    fixture.detectChanges();
    await fixture.whenStable();
  };

  beforeEach(async () => {
    confirmed = 0;
    cancelled = 0;

    await TestBed.configureTestingModule({
      imports: [ConfirmDialogComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(ConfirmDialogComponent);
    fixture.componentInstance.confirmed.subscribe(() => confirmed++);
    fixture.componentInstance.cancelled.subscribe(() => cancelled++);
  });

  it('renders a dialog labelled by its heading', async () => {
    fixture.componentRef.setInput('title', 'Delete this document?');
    await render();

    const dialog = element().querySelector('dialog');

    expect(dialog).toBeTruthy();
    expect(dialog?.getAttribute('aria-labelledby')).toBe('confirm-dialog-title');
    expect(element().querySelector('#confirm-dialog-title')?.textContent).toContain(
      'Delete this document?',
    );
  });

  it('confirms and closes', async () => {
    fixture.componentRef.setInput('confirmLabel', 'Delete');
    await render();

    const [, confirm] = buttons();
    confirm.click();

    expect(confirmed).toBe(1);
    expect(cancelled).toBe(0);
    expect(fixture.componentInstance.isOpen()).toBe(false);
  });

  it('cancels without confirming, and closes', async () => {
    await render();

    const [cancel] = buttons();
    cancel.click();

    expect(cancelled).toBe(1);
    expect(confirmed).toBe(0);
    expect(fixture.componentInstance.isOpen()).toBe(false);
  });

  it('uses the danger colour only for a destructive confirmation', async () => {
    await render();
    const [routineCancel] = buttons();
    // The classes are read out before the tone changes: the same button element is
    // reused, so holding a reference and inspecting it afterwards would only ever
    // show the final state.
    const routineConfirmClasses = buttons()[1].className;
    const routineCancelClasses = routineCancel.className;

    fixture.componentRef.setInput('tone', 'danger');
    await render();

    // Both variants resolve to a filled button, so the colour is what separates a
    // routine confirmation from an irreversible one.
    expect(routineConfirmClasses).not.toContain('bg-danger');
    expect(buttons()[1].className).toContain('bg-danger');
    expect(buttons()[0].className).toBe(routineCancelClasses);
  });

  it('keeps the model in step when the browser closes it with Escape', async () => {
    fixture.componentInstance.isOpen.set(true);
    await render();

    // Escape fires `cancel` before the dialog closes. The handler stops the
    // browser's own close so the model decides, which is what keeps a dismissal
    // from looking like a confirmation.
    const dialog = element().querySelector('dialog') as HTMLDialogElement;
    dialog.dispatchEvent(new Event('cancel', { cancelable: true }));

    expect(cancelled).toBe(1);
    expect(confirmed).toBe(0);
    expect(fixture.componentInstance.isOpen()).toBe(false);
  });
});
