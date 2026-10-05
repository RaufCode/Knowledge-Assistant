import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { Router, provideRouter } from '@angular/router';

import { API_BASE_URL } from './core/api.config';
import { AuthService } from './core/services/auth.service';

import { AppComponent } from './app.component';

/** The signed-out screen, which is declared plain in `app.routes.ts`. */
const PLAIN_ROUTE = { path: 'login', data: { plain: true }, children: [] };

/** An app screen, which is not. */
const APP_ROUTE = { path: '', children: [] };

/** A signed-out route with something nested under it, which inherits the flag. */
const NESTED_SIGNED_OUT_ROUTE = {
  path: 'accept-invite',
  data: { plain: true },
  children: [{ path: 'confirm', children: [] }],
};

describe('AppComponent', () => {
  let router: Router;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AppComponent],
      // The shell renders the sidebar, which reaches the conversation services,
      // which reach `HttpClient`. Without a backend behind it the sidebar fails
      // to construct and these assertions fail intermittently depending on when
      // the injection error surfaces.
      providers: [
        provideRouter([APP_ROUTE, PLAIN_ROUTE, NESTED_SIGNED_OUT_ROUTE]),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    }).compileComponents();

    router = TestBed.inject(Router);
  });

  it('shows a loading card, not a wrong screen, until it knows who is signed in', async () => {
    // The bug this covers: a refresh answered every question about the role with
    // "no" until the answer arrived, so an administrator saw a non-administrator's
    // shell for a frame before the dashboard appeared.
    const fixture = TestBed.createComponent(AppComponent);

    // Navigate to an app route (not plain) so the loading card can appear
    await router.navigate(['/']);
    fixture.detectChanges();
    await fixture.whenStable();

    const element = fixture.nativeElement as HTMLElement;

    expect(element.textContent).toContain('Loading your account');
    expect(element.querySelector('aside')).toBeNull();
  });

  /**
   * The shell, either as it stands or once a navigation has landed.
   *
   * Which of those two is being tested is the whole point of several of these, so
   * each case asks for the state it means rather than relying on a shared helper.
   */
  const render = async (navigateTo?: string): Promise<ComponentFixture<AppComponent>> => {
    const fixture = TestBed.createComponent(AppComponent);

    // Signed in, and known to be. The shell draws a loading card until the answer
    // about the person arrives, and every case below is about what it draws after
    // that — so the answer is settled here rather than in each test.
    const auth = TestBed.inject(AuthService);
    const known = auth.bootstrap();

    TestBed.inject(HttpTestingController)
      .expectOne(`${API_BASE_URL}/api/auth/me`)
      .flush({ id: 'u1', name: 'Ama Konadu', email: 'ama@acmetech.example', role: 'admin' });
    await known;
    await new Promise((resolve) => setTimeout(resolve, 0));

    fixture.detectChanges();

    if (navigateTo !== undefined) {
      await router.navigate([navigateTo]);
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
    }

    return fixture;
  };

  const elementOf = (fixture: ComponentFixture<AppComponent>): HTMLElement =>
    fixture.nativeElement as HTMLElement;

  it('should create the app', () => {
    const fixture = TestBed.createComponent(AppComponent);
    expect(fixture.componentInstance).toBeTruthy();
  });

  // These three are the regression tests for the sidebar appearing on the sign-in
  // screen. The cause was `isPlain()` asking an empty route tree what to render,
  // which answered "not plain", so the shell drew the sidebar — and kept drawing it
  // for the length of the `/api/auth/me` round trip that the app initializer makes
  // before the router is allowed to navigate at all.
  it('renders no sidebar before the router knows which screen it is on', async () => {
    const fixture = await render();
    const element = elementOf(fixture);

    // No navigation has settled, so the shell must be drawing the signed-out shape:
    // the content area and the skip link, and nothing else.
    expect(element.querySelector('#app-sidebar')).toBeNull();
    expect(element.querySelector('button[aria-label="Close sidebar"]')).toBeNull();
    expect(element.querySelector('#app-main')).toBeTruthy();
    expect(element.querySelector('a[href="#app-main"]')?.textContent).toContain('Skip to content');
  });

  it('renders no sidebar on a signed-out route, once the router has settled', async () => {
    const element = elementOf(await render('login'));

    expect(element.querySelector('#app-sidebar')).toBeNull();
    expect(element.querySelector('button[aria-label="Close sidebar"]')).toBeNull();
  });

  it('renders no sidebar inside a nested signed-out route', async () => {
    // The flag is on the parent and the child does not repeat it. Reading only the
    // deepest route answered "not plain" here and put the sidebar on a signed-out
    // screen — `plain` describes a section, and anything inside it is inside it.
    const element = elementOf(await render('accept-invite/confirm'));

    expect(element.querySelector('#app-sidebar')).toBeNull();
  });

  it('should render the sidebar landmark and the skip link on an app route', async () => {
    const element = elementOf(await render(''));

    expect(element.querySelector('#app-sidebar')).toBeTruthy();
    expect(element.querySelector('#app-main')).toBeTruthy();
    expect(element.querySelector('a[href="#app-main"]')?.textContent).toContain('Skip to content');
  });

  it('should keep the backdrop mounted but transparent and unclickable while closed', async () => {
    const backdrop = elementOf(await render('')).querySelector<HTMLElement>(
      'button[aria-label="Close sidebar"]',
    );

    // Once the app shell exists the backdrop stays in the DOM so it can fade;
    // without the pointer and opacity guards it would swallow every click on the
    // view behind it.
    expect(backdrop).toBeTruthy();
    expect(backdrop?.classList).toContain('opacity-0');
    expect(backdrop?.classList).toContain('pointer-events-none');
    expect(backdrop?.inert).toBe(true);
  });

  it('should leave the sidebar interactive when it is on screen', async () => {
    const sidebar = elementOf(await render('')).querySelector<HTMLElement>('#app-sidebar');

    // The test viewport reads as desktop, so the sidebar starts expanded: it
    // must not be inert, or the drawer would trap focus while it is on screen.
    expect(sidebar?.inert).toBe(false);
  });

  it('should transition the drawer, the backdrop and the content offset together', async () => {
    const element = elementOf(await render(''));

    const sidebar = element.querySelector('#app-sidebar');
    const main = element.querySelector('#app-main');
    const backdrop = element.querySelector<HTMLElement>('button[aria-label="Close sidebar"]');

    // `translate`, not `transform`: Tailwind v4 offsets with the `translate`
    // property, so transitioning `transform` left the drawer snapping.
    expect(sidebar?.className).toContain('transition-[width,translate]');
    expect(main?.className).toContain('transition-[padding]');
    expect(backdrop?.className).toContain('transition-opacity');

    // The shell assumes the compact layout before it can measure anything, so
    // the drawer renders off canvas. `lg:translate-x-0` is what puts it back for
    // a wide screen without waiting for hydration.
    expect(sidebar?.className).toContain('lg:translate-x-0');

    // One shared duration, so nothing overtakes anything else.
    for (const node of [sidebar, main, backdrop]) {
      expect(node?.className).toContain('duration-shell');
    }
  });

  it('should reserve the full column for the content offset, not just when expanded', async () => {
    const main = elementOf(await render('')).querySelector('#app-main');

    // Gating this on "is the viewport desktop" made the offset wrong on the
    // first paint, because the server cannot know the viewport.
    expect(main?.classList).toContain('lg:pl-sidebar');
    expect(main?.classList).not.toContain('lg:pl-rail');
  });

  it('should not reserve the column for the content offset on a signed-out route', async () => {
    const main = elementOf(await render('login')).querySelector('#app-main');

    // A signed-out screen is the full width, so the sidebar's offset must not be
    // reserved for something that is not rendered.
    expect(main?.classList).toContain('lg:pl-0');
    expect(main?.classList).not.toContain('lg:pl-sidebar');
  });
});
