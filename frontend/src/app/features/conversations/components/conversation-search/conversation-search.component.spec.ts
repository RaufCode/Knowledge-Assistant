import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ConversationSearchComponent } from './conversation-search.component';

describe('ConversationSearchComponent', () => {
  let fixture: ComponentFixture<ConversationSearchComponent>;

  const element = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const box = (): HTMLInputElement =>
    element().querySelector('input') as HTMLInputElement;

  const render = async (value = ''): Promise<void> => {
    fixture.componentRef.setInput('value', value);
    fixture.detectChanges();
    await fixture.whenStable();
  };

  /** Types into the field the way a browser fill does: the whole value at once. */
  const fill = (text: string): void => {
    box().value = text;
    box().dispatchEvent(new Event('input'));
    fixture.detectChanges();
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ConversationSearchComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(ConversationSearchComponent);
  });

  it('shows the search term it is given, and nothing else', async () => {
    await render();

    expect(box().value).toBe('');
    expect(box().placeholder).toBe('Search conversations');
  });

  it('emits text as it is typed', async () => {
    await render();

    const emitted: string[] = [];
    fixture.componentInstance.valueChange.subscribe((text) => emitted.push(text));

    fill('leave');

    expect(emitted).toEqual(['leave']);
  });

  it('drops an address rather than filtering by it', async () => {
    await render();

    const emitted: string[] = [];
    fixture.componentInstance.valueChange.subscribe((text) => emitted.push(text));

    // What a filler writes: the signed-in address, all at once. No conversation
    // title contains one, so this can only ever be unwanted — and emitting it
    // would filter the list down to nothing until cleared by hand.
    fill('me@acmetech.example');

    expect(emitted).toEqual([]);
    // Restored to the search term rather than left showing the fill.
    expect(box().value).toBe('');
  });

  it('emits empty when the clear control is pressed', async () => {
    await render('leave');

    const emitted: string[] = [];
    fixture.componentInstance.valueChange.subscribe((text) => emitted.push(text));

    (element().querySelector('button') as HTMLButtonElement).click();

    expect(emitted).toEqual(['']);
  });
});
