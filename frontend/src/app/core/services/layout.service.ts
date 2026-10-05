import {
  DestroyRef,
  Injectable,
  PLATFORM_ID,
  afterNextRender,
  computed,
  inject,
  signal,
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';

import {
  INITIAL_VIEWPORT_WIDTH,
  DESKTOP_BREAKPOINT,
  SIDEBAR_PREFERENCE_KEY,
} from '../../shared/utils/constants';

/** How the sidebar is currently presented at the active breakpoint. */
export type SidebarMode = 'expanded' | 'rail' | 'hidden';

/**
 * Owns responsive shell state: the viewport bucket, whether the sidebar is
 * collapsed on desktop, and whether the overlay drawer is open on smaller
 * screens. Kept in one place so the shell, the sidebar and the header toggle
 * never disagree about what is on screen.
 *
 * Breakpoints:
 * - below `lg` the sidebar is a drawer, hidden until the hamburger opens it
 * - `lg` and up  it is a permanent column, collapsible to the icon rail
 *
 * Nothing that depends on the viewport is decided by the width alone: the shell
 * and the header let the `lg` media query place everything on the first paint,
 * and this service only carries the choices a media query cannot hold, namely
 * whether the drawer is open and whether the column is collapsed.
 */
@Injectable({ providedIn: 'root' })
export class LayoutService {
  private readonly destroyRef = inject(DestroyRef);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  private readonly viewportWidthState = signal(INITIAL_VIEWPORT_WIDTH);
  private readonly collapsedState = signal(false);
  private readonly drawerOpenState = signal(false);

  /** Raw viewport width, tracked so breakpoint changes drive the layout. */
  readonly viewportWidth = this.viewportWidthState.asReadonly();

  /** True below `lg`, where the sidebar is an off-canvas drawer. */
  readonly isCompact = computed(() => this.viewportWidthState() < DESKTOP_BREAKPOINT);

  /** True from `lg` up, where the sidebar is a resizable column. */
  readonly isDesktop = computed(() => !this.isCompact());

  /** True when the sidebar's overlay drawer is open. */
  readonly isDrawerOpen = this.drawerOpenState.asReadonly();

  /** True when the drawer is open and should sit above a dimmed backdrop. */
  readonly isBackdropVisible = computed(() => this.drawerOpenState() && this.isCompact());

  /** How the sidebar is presented right now. */
  readonly mode = computed<SidebarMode>(() => {
    if (this.isCompact()) {
      return this.drawerOpenState() ? 'expanded' : 'hidden';
    }

    return this.collapsedState() ? 'rail' : 'expanded';
  });

  /** True while the sidebar is on screen in any form. */
  readonly isSidebarVisible = computed(() => this.mode() !== 'hidden');

  /** True when only the icon rail is shown. */
  readonly isRail = computed(() => this.mode() === 'rail');

  /**
   * Toggles the sidebar: the overlay drawer on small screens, the column on
   * large ones.
   */
  toggleSidebar(): void {
    if (this.isDesktop()) {
      this.setCollapsed(!this.collapsedState());
      return;
    }

    this.drawerOpenState.update((open) => !open);
  }

  /** Opens the sidebar in whichever form the current breakpoint uses. */
  openSidebar(): void {
    if (this.isDesktop()) {
      this.setCollapsed(false);
      return;
    }

    this.drawerOpenState.set(true);
  }

  /** Closes the sidebar, dismissing the overlay drawer on small screens. */
  closeSidebar(): void {
    this.drawerOpenState.set(false);
  }

  /** Closes the drawer after navigation so it never covers the new screen. */
  closeAfterNavigation(): void {
    if (!this.isDesktop()) {
      this.drawerOpenState.set(false);
    }
  }

  /**
   * Label for the control that toggles the sidebar.
   *
   * All three states name the same object, the sidebar. "Open menu" described the
   * glyph rather than the thing it reveals, and screen reader users tabbing the
   * header were offered a different control on each pass through it.
   */
  readonly toggleLabel = computed(() => {
    switch (this.mode()) {
      case 'expanded':
        return 'Collapse sidebar';
      case 'rail':
        return 'Expand sidebar';
      case 'hidden':
        return 'Open sidebar';
    }
  });

  constructor() {
    // The viewport only exists in the browser. Until it does, the shell renders
    // the compact drawer layout, which the `lg` media query promotes to the
    // column layout, so the first paint is right on both without waiting for
    // hydration to correct it.
    if (!this.isBrowser) {
      return;
    }

    afterNextRender(() => {
      this.viewportWidthState.set(window.innerWidth);
      this.collapsedState.set(this.readStoredPreference());

      const onResize = (): void => this.viewportWidthState.set(window.innerWidth);
      const onKeydown = (event: KeyboardEvent): void => {
        if (event.key === 'Escape') {
          this.closeSidebar();
        }
      };

      window.addEventListener('resize', onResize, { passive: true });
      window.addEventListener('keydown', onKeydown);
      this.destroyRef.onDestroy(() => {
        window.removeEventListener('resize', onResize);
        window.removeEventListener('keydown', onKeydown);
      });
    });
  }

  /** Persists the desktop collapse preference across visits. */
  private setCollapsed(collapsed: boolean): void {
    this.collapsedState.set(collapsed);

    if (this.isBrowser) {
      try {
        localStorage.setItem(SIDEBAR_PREFERENCE_KEY, String(collapsed));
      } catch {
        // Private browsing modes can reject storage; the preference is not
        // important enough to surface an error for.
      }
    }
  }

  /** Reads the stored desktop collapse preference, defaulting to expanded. */
  private readStoredPreference(): boolean {
    try {
      return localStorage.getItem(SIDEBAR_PREFERENCE_KEY) === 'true';
    } catch {
      return false;
    }
  }
}
