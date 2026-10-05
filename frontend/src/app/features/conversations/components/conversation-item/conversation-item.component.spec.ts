import { ComponentFixture, TestBed } from '@angular/core/testing';

import type { Conversation } from '../../../../core/models/conversation.model';
import { ConversationItemComponent } from './conversation-item.component';

/** A conversation as the sidebar lists it. */
function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv-1',
    title: 'Annual leave',
    updatedAt: '2026-09-30T08:00:00Z',
    ...overrides,
  };
}

describe('ConversationItemComponent', () => {
  let fixture: ComponentFixture<ConversationItemComponent>;
  let item: Conversation;
  let renames: { id: string; title: string }[];
  let removals: string[];

  const element = (): HTMLElement => fixture.nativeElement as HTMLElement;

  const render = async (): Promise<void> => {
    fixture.detectChanges();
    await fixture.whenStable();
  };

  /**
   * A button by its accessible name.
   *
   * By `aria-label` rather than by text: these controls are icons, and the label is
   * what makes the destructive one nameable rather than a bare bin. Matching on text
   * would find nothing and every assertion here would pass vacuously.
   */
  const button = (label: string): HTMLButtonElement | null =>
    Array.from(element().querySelectorAll<HTMLButtonElement>('button')).find(
      (candidate) =>
        candidate.getAttribute('aria-label')?.startsWith(label) ||
        candidate.textContent?.trim() === label,
    ) ?? null;

  beforeEach(async () => {
    item = conversation();
    renames = [];
    removals = [];

    await TestBed.configureTestingModule({
      imports: [ConversationItemComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(ConversationItemComponent);
    fixture.componentRef.setInput('appearance', 'sidebar');
    fixture.componentRef.setInput('conversation', item);
    fixture.componentInstance.renamed.subscribe((change) => renames.push(change));
    fixture.componentInstance.removed.subscribe((id) => removals.push(id));
  });

  it('shows an ellipsis on the row, and keeps the actions behind it', async () => {
    await render();

    // One control on the row, and the row itself full width. Two icon buttons beside
    // it meant the clickable title stopped short of the column's padding, so the row
    // read as narrower than the button above it.
    const ellipsis = element().querySelector('button[aria-label^="Actions for"]');
    expect(ellipsis).not.toBeNull();

    // Nothing destructive until the menu is opened.
    expect(button('Rename')).toBeNull();
    expect(button('Delete')).toBeNull();
  });

  it('reveals the ellipsis only on hover or keyboard focus', async () => {
    await render();

    // Focus as well as hover, because a control that exists only on hover cannot be
    // reached by tabbing at all.
    const ellipsis = element().querySelector('button[aria-label^="Actions for"]');
    expect(ellipsis?.className).toContain('opacity-0');
    expect(ellipsis?.className).toContain('group-hover:opacity-100');
    expect(ellipsis?.className).toContain('focus-visible:opacity-100');
  });

  it('reserves the ellipsis its corner so a long title truncates beside it', async () => {
    await render();

    const row = element().querySelector('button[aria-current], button.group-hover\:opacity-100')
      ?? element().querySelector('div.group > button');

    // Without the reservation a long title runs underneath the control.
    expect(row?.className).toContain('pr-9');
  });

  it('opens the edit and delete card on the ellipsis', async () => {
    await render();

    element().querySelector<HTMLButtonElement>('button[aria-label^="Actions for"]')?.click();
    await render();

    expect(button('Rename')).not.toBeNull();
    expect(button('Delete')).not.toBeNull();
  });

  it('does not open the conversation when the ellipsis is used', async () => {
    await render();

    const opened: string[] = [];
    fixture.componentInstance.selected.subscribe((id) => opened.push(id));

    // The ellipsis overlaps the row rather than sitting inside it, so without this
    // the menu would open over a conversation that had also been opened.
    element().querySelector<HTMLButtonElement>('button[aria-label^="Actions for"]')?.click();
    await render();

    expect(opened).toEqual([]);
  });

  it('closes the card when the page is clicked', async () => {
    await render();

    element().querySelector<HTMLButtonElement>('button[aria-label^="Actions for"]')?.click();
    await render();

    element().querySelector<HTMLButtonElement>('button[aria-label="Close"]')?.click();
    await render();

    expect(button('Rename')).toBeNull();
  });

  it('asks rather than deleting, because a row is one click from opening', async () => {
    await render();

    element().querySelector<HTMLButtonElement>('button[aria-label^="Actions for"]')?.click();
    await render();
    button('Delete')?.click();
    await render();

    // It emits and lets the parent confirm. Deleting here would lose a conversation
    // and everything in it on the same click that opened it.
    expect(removals).toEqual(['conv-1']);
  });

  it('edits the name in place, starting from the one it has', async () => {
    await render();

    element().querySelector<HTMLButtonElement>('button[aria-label^="Actions for"]')?.click();
    await render();
    button('Rename')?.click();
    await render();

    const input = element().querySelector('input') as HTMLInputElement;
    expect(input.value).toBe('Annual leave');
  });

  it('emits the new name for that conversation', async () => {
    await render();

    element().querySelector<HTMLButtonElement>('button[aria-label^="Actions for"]')?.click();
    await render();
    button('Rename')?.click();
    await render();

    const input = element().querySelector('input') as HTMLInputElement;
    input.value = 'Leave and carryover';
    input.dispatchEvent(new Event('input'));
    await render();

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await render();

    expect(renames).toEqual([{ id: 'conv-1', title: 'Leave and carryover' }]);
    expect(element().querySelector('input')).toBeNull();
  });

  it('refuses an empty name rather than sending one', async () => {
    await render();

    element().querySelector<HTMLButtonElement>('button[aria-label^="Actions for"]')?.click();
    await render();
    button('Rename')?.click();
    await render();

    const input = element().querySelector('input') as HTMLInputElement;
    input.value = '   ';
    input.dispatchEvent(new Event('input'));
    await render();

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await render();

    // A conversation with no name is what one looks like before it has been
    // answered, not something to save deliberately.
    expect(renames).toEqual([]);
  });

  it('closes the editor without renaming when cancelled', async () => {
    await render();

    element().querySelector<HTMLButtonElement>('button[aria-label^="Actions for"]')?.click();
    await render();
    button('Rename')?.click();
    await render();

    const input = element().querySelector('input') as HTMLInputElement;
    input.value = 'Something else';
    input.dispatchEvent(new Event('input'));
    await render();

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await render();

    expect(renames).toEqual([]);
    expect(element().querySelector('input')).toBeNull();
  });

  it('offers the same actions on the conversations view as in the sidebar', async () => {
    fixture.componentRef.setInput('appearance', 'panel');
    await render();

    // A feature that depends on which screen you are on reads as a feature that does
    // not exist. Both surfaces render the same row, so both get both actions.
    element().querySelector<HTMLButtonElement>('button[aria-label^="Actions for"]')?.click();
    await render();

    expect(button('Rename')).not.toBeNull();
    expect(button('Delete')).not.toBeNull();

    button('Delete')?.click();
    await render();

    expect(removals).toEqual(['conv-1']);
  });

  it('offers no actions on the collapsed rail', async () => {
    fixture.componentRef.setInput('appearance', 'rail');
    await render();

    // The rail is an initials chip with room for one target; an ellipsis beside it
    // would leave no room for the chip.
    expect(element().querySelector('button[aria-label^="Actions for"]')).toBeNull();
  });
});
