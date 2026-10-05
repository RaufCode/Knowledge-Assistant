import { ComponentFixture, TestBed } from '@angular/core/testing';
import { vi } from 'vitest';

import { DocumentDropzoneComponent } from './document-dropzone.component';

describe('DocumentDropzoneComponent', () => {
  let fixture: ComponentFixture<DocumentDropzoneComponent>;
  let accepted: File[];

  const element = (): HTMLElement => fixture.nativeElement as HTMLElement;

  const render = async (): Promise<void> => {
    fixture.detectChanges();
    await fixture.whenStable();
  };

  const drop = (file: File): void => {
    const zone = element().querySelector('div') as HTMLElement;
    const event = new Event('drop') as DragEvent;
    Object.defineProperty(event, 'dataTransfer', { value: { files: [file] } });
    zone.dispatchEvent(event);
  };

  const click = (label: string): void => {
    const button = Array.from(element().querySelectorAll<HTMLButtonElement>('button')).find(
      (candidate) => candidate.textContent?.trim() === label,
    ) as HTMLButtonElement;
    button.click();
  };

  beforeEach(async () => {
    accepted = [];

    await TestBed.configureTestingModule({
      imports: [DocumentDropzoneComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(DocumentDropzoneComponent);
    fixture.componentInstance.fileAccepted.subscribe((file) => accepted.push(file));
  });

  it('states the formats it accepts before anything is chosen', async () => {
    await render();

    expect(element().textContent).toContain('PDF, DOCX, TXT supported');
  });

  it('shows the chosen file by its own name and size', async () => {
    await render();

    drop(new File(['x'.repeat(2 * 1024 * 1024)], 'Leave Policy.pdf'));
    await render();

    expect(element().textContent).toContain('Leave Policy.pdf');
    expect(element().textContent).toContain('2.0 MB');
  });

  it('names a file it refuses rather than ignoring the drop', async () => {
    await render();

    drop(new File(['x'], 'quarterly.xlsx'));
    await render();

    // Naming it is the difference between "that did not work" and "that one did
    // not work", and silently dropping a file the person dragged in reads as a
    // broken panel.
    expect(element().querySelector('[role="alert"]')?.textContent).toContain('quarterly.xlsx');
    expect(element().textContent).toContain('PDF, DOCX or TXT');
  });

  it('reports progress as a value, not only as a coloured bar', async () => {
    await render();

    drop(new File(['x'], 'Policy.txt'));
    await render();

    click('Upload');
    fixture.detectChanges();

    const bar = element().querySelector('[role="progressbar"]');
    expect(bar?.getAttribute('aria-valuenow')).not.toBe('0');
  });

  it('hands the file over once the preview finishes, and emits nothing early', async () => {
    await render();
    vi.useFakeTimers();

    try {
      drop(new File(['x'], 'Policy.txt'));
      fixture.detectChanges();

      click('Upload');
      await vi.advanceTimersByTimeAsync(200);
      expect(accepted).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(2000);
    } finally {
      vi.useRealTimers();
    }

    expect(accepted).toHaveLength(1);
    expect(accepted[0].name).toBe('Policy.txt');
  });

  it('can be abandoned before the file is taken in', async () => {
    await render();

    drop(new File(['x'], 'Policy.txt'));
    await render();

    click('Cancel');
    await render();

    expect(element().textContent).toContain('Drag and drop your file here');
  });
});
