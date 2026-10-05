import { TestBed } from '@angular/core/testing';

import { LayoutService } from './layout.service';
import { DESKTOP_BREAKPOINT, SIDEBAR_PREFERENCE_KEY } from '../../shared/utils/constants';

describe('LayoutService', () => {
  let layout: LayoutService;

  /** Resizes the window and lets the service's render hook pick it up. */
  const resizeTo = (width: number): void => {
    Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
    window.dispatchEvent(new Event('resize'));
    TestBed.tick();
  };

  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(window, 'innerWidth', { value: DESKTOP_BREAKPOINT, configurable: true });
    layout = TestBed.inject(LayoutService);
    TestBed.tick();
  });

  afterEach(() => localStorage.clear());

  describe('on desktop', () => {
    beforeEach(() => resizeTo(1440));

    it('shows the sidebar as a column and offsets the content', () => {
      expect(layout.isDesktop()).toBe(true);
      expect(layout.mode()).toBe('expanded');
      expect(layout.isRail()).toBe(false);
      expect(layout.isBackdropVisible()).toBe(false);
    });

    it('collapses to the rail and remembers the choice', () => {
      layout.toggleSidebar();
      TestBed.tick();

      expect(layout.mode()).toBe('rail');
      expect(layout.isRail()).toBe(true);
      expect(localStorage.getItem(SIDEBAR_PREFERENCE_KEY)).toBe('true');

      layout.toggleSidebar();
      expect(layout.mode()).toBe('expanded');
      expect(localStorage.getItem(SIDEBAR_PREFERENCE_KEY)).toBe('false');
    });

    it('restores a stored collapse preference on the next visit', () => {
      localStorage.setItem(SIDEBAR_PREFERENCE_KEY, 'true');
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({});

      const restored = TestBed.inject(LayoutService);
      TestBed.tick();

      expect(restored.mode()).toBe('rail');
    });

    it('never shows a backdrop, and navigation does not close the column', () => {
      layout.toggleSidebar();
      layout.closeAfterNavigation();

      expect(layout.mode()).toBe('rail');
      expect(layout.isBackdropVisible()).toBe(false);
    });
  });

  describe('below the desktop breakpoint', () => {
    // Phones and tablets share one layout: an off-canvas drawer behind a
    // hamburger, with no rail and no reserved content offset.
    it.each([390, 834, 1000])('hides the sidebar at %ipx until it is opened', (width) => {
      resizeTo(width);

      expect(layout.isCompact()).toBe(true);
      expect(layout.isDesktop()).toBe(false);
      expect(layout.mode()).toBe('hidden');
      expect(layout.isSidebarVisible()).toBe(false);
      expect(layout.isRail()).toBe(false);
      expect(layout.toggleLabel()).toBe('Open sidebar');
    });

    it('opens as a drawer over the content', () => {
      resizeTo(834);
      layout.toggleSidebar();
      TestBed.tick();

      expect(layout.mode()).toBe('expanded');
      expect(layout.isBackdropVisible()).toBe(true);
      expect(layout.toggleLabel()).toBe('Collapse sidebar');

      layout.closeSidebar();
      expect(layout.mode()).toBe('hidden');
    });
  });

  describe('on mobile', () => {
    beforeEach(() => resizeTo(390));

    it('hides the sidebar off canvas until it is opened', () => {
      expect(layout.isCompact()).toBe(true);
      expect(layout.mode()).toBe('hidden');
      expect(layout.isSidebarVisible()).toBe(false);
      expect(layout.toggleLabel()).toBe('Open sidebar');
    });

    it('opens as a drawer over the content and closes on Escape', () => {
      layout.toggleSidebar();
      TestBed.tick();

      expect(layout.mode()).toBe('expanded');
      expect(layout.isBackdropVisible()).toBe(true);
      expect(layout.isRail()).toBe(false);

      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      TestBed.tick();

      expect(layout.mode()).toBe('hidden');
      expect(layout.isBackdropVisible()).toBe(false);
    });

    it('closes the drawer after navigating', () => {
      layout.openSidebar();
      layout.closeAfterNavigation();

      expect(layout.mode()).toBe('hidden');
    });
  });
});
