import { Injectable, computed, inject, signal } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { filter } from 'rxjs';

/**
 * Which of the two places the app can be: the administrator's section or the assistant.
 *
 * An administrator has both, and they are genuinely different jobs — uploading a
 * document is not asking a question about one. The sidebar shows one set of
 * navigation for whichever is in front of them, so the two never compete for the
 * same column and an administrator is never left with a row that does not apply to
 * the screen they are on.
 *
 * Read from the URL rather than held as state, because the URL is what a reload,
 * a bookmark and the browser's back button all agree on. A flag the app remembered
 * for itself would disagree with all three the moment any of them was used.
 *
 * `/admin` is matched exactly and `/admin/...` by prefix, so the dashboard is not
 * treated as active while a document screen underneath it is the one on show.
 */
@Injectable({ providedIn: 'root' })
export class SectionService {
  private readonly router = inject(Router);

  /** The current path, updated on every settled navigation. */
  private readonly pathState = signal('/');

  /** True while an administrator is on one of their own screens. */
  readonly isAdminSection = computed(() => {
    const path = this.pathState();

    return path === '/admin' || path.startsWith('/admin/');
  });

  constructor() {
    this.pathState.set(this.router.url.split('?')[0]);

    // Only settled navigations count. A `NavigationStart` carries the URL being left
    // behind, so following it would flip the section a frame before the new screen
    // was there — long enough to show the wrong navigation on a slow connection.
    this.router.events
      .pipe(filter((event): event is NavigationEnd => event instanceof NavigationEnd))
      .subscribe((event) => this.pathState.set(event.urlAfterRedirects.split('?')[0]));
  }
}