import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterRenderEffect,
  computed,
  inject,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import {
  ActivatedRouteSnapshot,
  NavigationEnd,
  NavigationError,
  NavigationSkipped,
  Router,
  RouterOutlet,
} from '@angular/router';
import { filter, scan, startWith } from 'rxjs';

import { ChatSidebarComponent } from './features/chat/components/chat-sidebar/chat-sidebar.component';
import { AuthService } from './core/services/auth.service';
import { LayoutService } from './core/services/layout.service';

/** Marked in the tab once a stale-bundle reload has been attempted. */
const STALE_BUNDLE_RELOAD_KEY = 'ika.reloadedForStaleBundle';

/**
 * Whether a failed navigation means the running code is older than its chunks.
 *
 * Deploys replace the hashed chunk files, so a tab opened before one that only
 * navigates after it fetches files that no longer exist — and the server answers
 * those with the app shell instead of JavaScript. The button that was clicked
 * then does nothing, with the real cause only in the console. The recovery is a
 * single full reload, which fetches the current shell and its matching chunks.
 */
function isStaleBundleError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');

  return /Failed to fetch dynamically imported module|Loading chunk [\w-]+ failed/i.test(
    message,
  );
}

/** Elements that can hold focus, used by the drawer's focus trap. */
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Whether the routed view owns the whole screen.
 *
 * Read from route data rather than from a list of paths held here. A list in the
 * shell is a second thing to remember: a signed-out route added without it would
 * render with the sidebar and a conversation list it has no business showing, and
 * nothing would say so. The route declares `data: { plain: true }`, so the fact
 * lives with the route.
 *
 * The router state is followed rather than just the URL, because the flag lives on
 * the deepest activated route and reading it off the URL alone would need exactly
 * the path list this replaced. `startWith` on the same expression matters for a deep
 * link: without it the first paint happens before any navigation event, and a
 * signed-out screen would render with the sidebar for a frame.
 */
/**
 * The application shell: the sidebar, the dismissible backdrop, and the routed
 * view. It owns no domain state; the sidebar's presentation is decided by
 * `LayoutService`.
 *
 * Whether the routed view stands on its own is a question about the route rather
 * than about this shell, and it is answered from route data. Signing in has nothing
 * to do with a conversation list, so the sidebar and the offset it causes are
 * dropped there rather than covered up — and the route says so itself with
 * `data: { plain: true }`, which means a signed-out screen added later gets this
 * right without anybody remembering to list it here.
 */
@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ChatSidebarComponent, RouterOutlet],
  host: {
    '(keydown.tab)': 'onTab($event)',
  },
  template: `
    <a
      href="#app-main"
      class="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[60]
        focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-sm
        focus:text-primary-foreground"
    >
      Skip to content
    </a>

    <!--
      Until the app knows who is signed in, nothing that depends on knowing is drawn.

      A refresh starts with no user and no answer, and every question the shell asks
      about the role is answered "no" in the meantime. That is what put a
      non-administrator's sidebar on screen for a frame before the dashboard
      appeared: the navigation was right, and everything inside it was drawn from a
      role that had not arrived yet.

      A loading card rather than a wrong screen. It is the only state here that is
      true — somebody is signed in, and the answer is on its way.
    -->
    @if (resolving()) {
      <div class="flex h-dvh items-center justify-center bg-background px-6" role="status">
        <div
          class="flex w-full max-w-sm flex-col gap-3 rounded-lg border border-border bg-card p-6"
        >
          <div class="flex items-center gap-3">
            <div class="size-9 shrink-0 rounded-full bg-muted"></div>
            <div class="flex-1">
              <div class="h-3.5 w-32 rounded bg-muted"></div>
              <div class="mt-2 h-2.5 w-48 rounded bg-muted"></div>
            </div>
          </div>
          <div class="h-2.5 w-full rounded bg-muted"></div>
          <div class="h-2.5 w-2/3 rounded bg-muted"></div>
          <span class="sr-only">Loading your account.</span>
        </div>
      </div>
    } @else {
      <div class="flex h-dvh overflow-hidden bg-background">
      <!--
        Neither the backdrop nor the sidebar is rendered on a signed-out screen.

        Not hidden — absent. That is deliberate: a sidebar that is present but
        invisible still constructs its services and still sits in the accessibility
        tree, and the one thing that must never appear on the sign-in screen is the
        sidebar. The route tree is empty until the first navigation settles, so
        isPlain() counts "not known yet" as signed out, and this renders only once
        the router can say for certain which screen it is on.
      -->
      @if (!isPlain()) {
        <!--
          Present and faded rather than added and removed: mounting it on open would
          make the dimming land in a single frame and the whole drawer would read as
          a jump.
        -->
        <button
          type="button"
          class="fixed inset-0 z-40 cursor-default bg-foreground/40 backdrop-blur-[1px]
            transition-opacity duration-shell ease-out-soft motion-reduce:transition-none"
          [class.opacity-0]="!layout.isBackdropVisible()"
          [class.pointer-events-none]="!layout.isBackdropVisible()"
          [inert]="!layout.isBackdropVisible()"
          aria-label="Close sidebar"
          (click)="layout.closeSidebar()"
        ></button>

        <aside
          #sidebar
          id="app-sidebar"
          class="fixed inset-y-0 left-0 z-50 flex shrink-0 flex-col overflow-hidden
            shadow-raised transition-[width,translate] duration-shell ease-out-soft
            motion-reduce:transition-none lg:translate-x-0 lg:shadow-none"
          [class.w-sidebar]="!layout.isRail()"
          [class.w-rail]="layout.isRail()"
          [class.-translate-x-full]="layout.mode() === 'hidden'"
          [inert]="layout.mode() === 'hidden'"
        >
          <app-chat-sidebar />
        </aside>
      }

      <main
        id="app-main"
        class="flex min-h-0 min-w-0 flex-1 flex-col transition-[padding] duration-shell
          ease-out-soft motion-reduce:transition-none"
        [class.lg:pl-sidebar]="!layout.isRail() && !isPlain()"
        [class.lg:pl-rail]="layout.isRail() && !isPlain()"
        [class.lg:pl-0]="isPlain()"
      >
        <router-outlet />
      </main>
    </div>
    }
  `,
})
export class AppComponent {
  /** Responsive shell state: breakpoints, collapse preference and drawer. */
  protected readonly layout = inject(LayoutService);

  private readonly router = inject(Router);

  /** Who is signed in, which is not known until the first answer arrives. */
  private readonly auth = inject(AuthService);

  /**
   * Whether the answer about the signed-in person is still on its way.
   *
   * Only for the browser. A server render has nobody to ask and no cookie to read, so
   * waiting there would hold the whole page on a card nobody will ever replace.
   */
  protected readonly resolving = computed(
    () => this.auth.isBrowserOnly() && this.auth.status() === 'unknown' && !this.isPlain(),
  );

  /**
   * Whether the routed view stands on its own, with "not known yet" counted as yes.
   *
   * This is the bug that put the sidebar on the sign-in screen. The route tree is
   * empty until the first navigation completes, so asking it what to render before
   * then returns nothing and the shell fell back to drawing the sidebar. Worse, it
   * stayed that way for a whole network round trip, because the app initializer asks
   * the backend who is signed in before the router is allowed to navigate at all. So
   * a visitor with no session saw the app's sidebar — conversations, search, the
   * person's own avatar — until the guard finally answered.
   *
   * `scan` rather than `map`, and the seed rather than a default: only a settled
   * navigation may change the answer. Every other router event carries the previous
   * one, so a `NavigationStart` does not flip the shell back to signed-out while the
   * next screen is on its way.
   */
  protected readonly isPlain = toSignal(
    this.router.events.pipe(
      scan(
        (plain, event) => (this.settles(event) ? this.readsAsPlain() : plain),
        // Until a navigation settles, draw the signed-out shell. An empty sidebar-
        // less screen is wrong for nobody; a sidebar on the sign-in screen is.
        true,
      ),
      startWith(true),
    ),
    { initialValue: true },
  );

  /**
   * Whether this router event means a navigation has landed.
   *
   * `NavigationSkipped` counts: a guard returning a redirect for a URL that is
   * already the current one settles without a `NavigationEnd`.
   */
  private settles(event: unknown): boolean {
    return event instanceof NavigationEnd || event instanceof NavigationSkipped;
  }

  /**
   * Whether the routed view stands on its own.
   *
   * Walks the whole route chain rather than only the deepest route. Angular merges a
   * parent's `data` into a child's only for componentless parents, so a signed-out
   * route with anything nested under it would lose the flag and bring the sidebar
   * back — and `plain` describes a *section*, so a child of one is inside it whether
   * it says so or not.
   */
  private readsAsPlain(): boolean {
    let route: ActivatedRouteSnapshot | null = this.router.routerState.snapshot.root;

    while (route) {
      if (route.data['plain'] === true) {
        return true;
      }

      route = route.firstChild;
    }

    return false;
  }

  /**
   * The drawer element.
   *
   * The ref is on the `<aside>` rather than on `<app-chat-sidebar>`: a ref on a
   * component resolves to that component's instance, not to an `ElementRef`, so
   * `.nativeElement` would be undefined and the `querySelectorAll` below it would
   * match nothing. That is how a focus trap can read as correct and trap nothing
   * at all, so the ref is kept on the element it describes.
   */
  private readonly sidebar = viewChild<ElementRef<HTMLElement>>('sidebar');

  /** True while the sidebar covers the content and should trap focus. */
  private readonly isDrawerModal = computed(
    () => !this.isPlain() && this.layout.isBackdropVisible(),
  );

  /** Where focus came from when the drawer opened, to give it back on close. */
  private focusBeforeDrawer: HTMLElement | null = null;

  /** The drawer's last modal state, so only the transition is acted on. */
  private wasDrawerModal = false;

  constructor() {
    // A navigation that dies on a missing chunk recovers with one full reload.
    // Seen in the wild as buttons that go nowhere after a deploy replaced the
    // hashed files underneath an open tab. Once per tab, so a genuinely broken
    // deployment cannot trap the browser in a reload loop.
    this.router.events
      .pipe(filter((event): event is NavigationError => event instanceof NavigationError))
      .subscribe((event) => {
        if (typeof window === 'undefined' || typeof sessionStorage === 'undefined') {
          return;
        }

        if (!isStaleBundleError(event.error) || sessionStorage.getItem(STALE_BUNDLE_RELOAD_KEY)) {
          return;
        }

        sessionStorage.setItem(STALE_BUNDLE_RELOAD_KEY, '1');
        window.location.reload();
      });

    // A modal drawer has to take focus, or the trap below never engages: it only
    // rewrites Tab at the drawer's first and last control, which focus never
    // reaches if it is still out in the content behind the backdrop. Closing it
    // without handing focus back strands the user at the top of the document.
    //
    // `afterRenderEffect` rather than `effect`, because the drawer is `inert`
    // while it is closed and only reachable once the binding that removes that
    // has been applied, which happens during render.
    afterRenderEffect(() => {
      const modal = this.isDrawerModal();

      // Only the transition matters. Re-focusing on every render would drag focus
      // back to the first control while someone was part way down it, and the
      // close case has to fire even though focus is still sitting inside the
      // drawer that just became inert.
      if (modal === this.wasDrawerModal) {
        return;
      }

      this.wasDrawerModal = modal;

      if (modal) {
        this.focusBeforeDrawer =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
        this.focusableElements()[0]?.focus();

        return;
      }

      const target = this.focusBeforeDrawer;
      this.focusBeforeDrawer = null;

      // The control that opened the drawer may have been navigated away from, in
      // which case there is nowhere to go back to and focus is left alone.
      if (target?.isConnected) {
        target.focus();
      }
    });
  }

  /**
   * Keeps Tab inside the sidebar while it is a modal drawer, so keyboard users
   * cannot wander into the content hidden behind the backdrop.
   */
  protected onTab(event: Event): void {
    if (!this.isDrawerModal() || !(event instanceof KeyboardEvent) || event.key !== 'Tab') {
      return;
    }

    const focusable = this.focusableElements();

    if (focusable.length === 0) {
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;

    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
      return;
    }

    if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  /**
   * Focusable controls inside the sidebar, in tab order.
   *
   * Empty when there is no sidebar, which is the signed-out case: the element is not
   * rendered at all rather than hidden, so there is nothing to trap focus within and
   * nothing to find.
   */
  private focusableElements(): HTMLElement[] {
    const element = this.sidebar()?.nativeElement;

    return element ? Array.from(element.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)) : [];
  }
}
