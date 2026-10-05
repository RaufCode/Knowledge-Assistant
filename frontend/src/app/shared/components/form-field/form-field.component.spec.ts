import { ComponentFixture, TestBed } from '@angular/core/testing';

import { FormFieldComponent } from './form-field.component';

describe('FormFieldComponent', () => {
  let fixture: ComponentFixture<FormFieldComponent>;

  const element = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const input = (): HTMLInputElement => element().querySelector('input') as HTMLInputElement;

  const render = async (): Promise<void> => {
    fixture.detectChanges();
    await fixture.whenStable();
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [FormFieldComponent],
    }).compileComponents();
    fixture = TestBed.createComponent(FormFieldComponent);
  });

  it('links its label to the control', async () => {
    fixture.componentRef.setInput('label', 'Work email');
    await render();

    const control = input();

    expect(control).toBeTruthy();
    expect(element().querySelector('label')?.getAttribute('for')).toBe(control.id);
  });

  it('reports typing back through the model', async () => {
    await render();

    input().value = 'ama@acmetech.example';
    input().dispatchEvent(new Event('input'));

    expect(fixture.componentInstance.value()).toBe('ama@acmetech.example');
  });

  it('masks a password until the reveal control is used', async () => {
    fixture.componentRef.setInput('type', 'password');
    await render();

    const reveal = element().querySelector<HTMLButtonElement>(
      'button[aria-label="Show password"]',
    );

    expect(input().type).toBe('password');
    expect(reveal).toBeTruthy();

    reveal?.click();
    await render();

    expect(input().type).toBe('text');
    expect(element().querySelector('button[aria-label="Hide password"]')).toBeTruthy();
  });

  it('shows the error in place of the hint and points the control at it', async () => {
    fixture.componentRef.setInput('hint', 'Use your work address.');
    fixture.componentRef.setInput('error', 'Enter your work email');
    await render();

    const control = input();

    // The hint is replaced rather than joined by the error: two messages under one
    // field is ambiguous about which one the red text belongs to.
    expect(element().textContent).toContain('Enter your work email');
    expect(element().textContent).not.toContain('Use your work address.');
    expect(control.getAttribute('aria-invalid')).toBe('true');
    expect(control.getAttribute('aria-describedby')).toBe(control.id + '-error');
  });

  it('leaves a field with neither message undecorated', async () => {
    await render();

    expect(input().getAttribute('aria-invalid')).toBeNull();
    expect(input().getAttribute('aria-describedby')).toBeNull();
  });
});
