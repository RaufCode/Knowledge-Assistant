import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { ViewHeaderComponent } from './view-header.component';

@Component({
  selector: 'app-test-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ViewHeaderComponent],
  template: `<app-view-header title="Annual leave entitlement" />`,
})
class TestHostComponent {}

describe('ViewHeaderComponent', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [TestHostComponent] }).compileComponents();
  });

  it('should let the breakpoint pick the glyph rather than reading the viewport', async () => {
    const fixture = TestBed.createComponent(TestHostComponent);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    const wrappers = element.querySelectorAll('button > span');

    // Both glyphs ship and CSS reveals one per breakpoint. Computing the icon
    // from the measured viewport meant phones painted the panel glyph first and
    // swapped it once hydration caught up.
    expect(wrappers.length).toBe(2);
    expect(wrappers[0].classList).toContain('lg:hidden');
    expect(wrappers[0].querySelector('app-icon')).toBeTruthy();
    expect(wrappers[1].classList).toContain('hidden');
    expect(wrappers[1].classList).toContain('lg:flex');
    expect(wrappers[1].querySelector('app-icon')).toBeTruthy();

    // The visibility utility must sit on a wrapper, never on `app-icon`: the
    // icon sets `inline-flex` on its own host and would win on stylesheet order,
    // leaving both glyphs drawn.
    for (const icon of element.querySelectorAll('app-icon')) {
      expect(icon.classList).not.toContain('hidden');
      expect(icon.classList).not.toContain('lg:hidden');
      expect(icon.classList).not.toContain('lg:block');
    }
  });

  it('should show the three line menu as the mobile glyph', async () => {
    const fixture = TestBed.createComponent(TestHostComponent);
    await fixture.whenStable();
    const menu = (fixture.nativeElement as HTMLElement).querySelector('app-icon[name="menu"] svg');

    expect(menu?.querySelector('path')?.getAttribute('d')).toBe('M4 6h16M4 12h16M4 18h16');
  });

  it('should name the product below lg and show the view title from lg up', async () => {
    const fixture = TestBed.createComponent(TestHostComponent);
    await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    const productName = element.querySelector('span');
    const title = element.querySelector('h1');

    expect(productName?.textContent).toContain('Knowledge Assistant');
    expect(productName?.classList).toContain('lg:hidden');
    expect(title?.textContent?.trim()).toBe('Annual leave entitlement');
    expect(title?.classList).toContain('hidden');
    expect(title?.classList).toContain('lg:block');
  });

  it('should send the toggle to the trailing edge on small screens', async () => {
    const fixture = TestBed.createComponent(TestHostComponent);
    await fixture.whenStable();
    const toggle = (fixture.nativeElement as HTMLElement).querySelector('button');

    // `ml-auto` parks it opposite the product name; from lg it returns to the
    // leading edge, beside the sidebar it controls.
    expect(toggle?.classList).toContain('ml-auto');
    expect(toggle?.classList).toContain('lg:absolute');
    expect(toggle?.classList).toContain('lg:left-6');
  });
});
