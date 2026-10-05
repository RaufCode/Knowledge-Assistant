import { ChangeDetectionStrategy, Component, OnInit, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';

import { ActivityService } from '../../core/services/activity.service';
import { AuthService } from '../../core/services/auth.service';
import { AdminAccessRequiredComponent } from '../../features/admin/components/admin-access-required/admin-access-required.component';
import { StatCardComponent } from '../../features/admin/components/stat-card/stat-card.component';
import { ViewHeaderComponent } from '../../features/chat/components/view-header/view-header.component';
import { ButtonComponent } from '../../shared/components/button/button.component';
import { IconComponent } from '../../shared/components/icon/icon.component';
import { SkeletonComponent } from '../../shared/components/skeleton/skeleton.component';
import { formatRelativeTime } from '../../shared/utils/relative-time.util';

/**
 * The administrator's landing screen.
 *
 * Two things, and only two: the figures an administrator is asked for, and what has
 * happened lately. The indexing breakdown, the knowledge-base health bar and the
 * recent-questions panel that used to live here were all derived from a placeholder
 * document list, so every one of them was a number with nothing behind it. They are
 * gone rather than reworded, because a real figure next to an invented one is worse
 * than the invented one alone — an administrator cannot tell which is which.
 *
 * Navigation is the sidebar's job. This screen used to carry a tab bar as well,
 * which meant two systems for one job and left the reader working out which was
 * the real one.
 */
@Component({
  selector: 'app-admin-dashboard-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AdminAccessRequiredComponent,
    ButtonComponent,
    IconComponent,
    RouterLink,
    SkeletonComponent,
    StatCardComponent,
    ViewHeaderComponent,
  ],
  host: { class: 'flex min-h-0 flex-1 flex-col' },
  template: `
    <app-view-header title="Admin Dashboard" />

    @if (auth.isAdmin()) {
      <!--
        No max-width here, and that is the point: the header strip above spans the
        full content area, so a capped, centred column below it left the title and
        the panels it is about sitting at two different widths. The horizontal
        padding matches the header's own, so the left edges line up with each other.
      -->
      <div class="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:px-8">
        <!--
          Goes to the documents screen rather than opening a panel here: the upload
          modal lives there, and a second one would be the same control in two places
          with the two copies drifting apart. Right-aligned on its own so it does not
          need a paragraph of explanation beside it to justify where it sits.
        -->
        <div class="flex justify-end">
          <a app-button routerLink="/admin/documents" class="shrink-0">
            <app-icon name="upload" [size]="16" />
            <span>Upload document</span>
          </a>
        </div>

        <div class="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <app-stat-card
            label="Documents indexed"
            [value]="asText(activity.documentCount())"
            [detail]="documentDetail()"
            icon="file-text"
          />

          <app-stat-card
            label="Waiting for access"
            [value]="asText(activity.pendingRequestCount())"
            [detail]="pendingDetail()"
            icon="users"
          />

          <app-stat-card
            label="Conversations"
            [value]="asText(activity.conversationCount())"
            detail="Asked from this browser"
            icon="message-square-text"
          />
        </div>

        <section class="mt-8 pb-4">
          <h2 class="font-headings text-sm font-semibold text-foreground">Recent activity</h2>

          @if (activity.isLoading()) {
            <!--
              Four rows in the exact shape of the real ones, rather than a spinner. The
              panel has a border and a height whether or not anything is in it, and a
              spinner in the middle of it means the list arrives by pushing everything
              on the page down.
            -->
            <ul class="mt-3 overflow-hidden rounded-lg border border-border bg-card" aria-hidden="true">
              @for (row of skeletonRows; track row.width) {
                <li
                  class="flex items-center gap-3 border-b border-border px-4 py-3
                    last:border-b-0"
                >
                  <app-skeleton class="size-3.5 rounded" />
                  <app-skeleton class="h-3" [style.width.%]="row.width" />
                  <app-skeleton class="ml-auto h-2.5 w-14" />
                </li>
              }
            </ul>

            <span class="sr-only" role="status">Loading recent activity.</span>
          } @else if (activity.isEmpty()) {
            <!--
              Its own panel rather than the shared empty state inside one.

              The shared empty state is a centred icon, a heading and a sentence, which
              suits a page with nothing else on it. Here the list is one section of a
              screen that already has figures above it, so a second centred block would
              read as another thing that failed to load. A bordered panel with a line
              of copy and the one action that changes it says "this is empty" without
              competing with the numbers.
            -->
            <div
              class="mt-3 flex items-center gap-3 rounded-lg border border-border
                bg-card px-4 py-4"
            >
              <span
                class="flex size-9 shrink-0 items-center justify-center rounded-full
                  bg-muted text-muted-foreground"
              >
                <app-icon name="clock" [size]="17" />
              </span>

              <p class="min-w-0 flex-1 text-sm text-muted-foreground">
                Nothing yet. Access requests will show up here once people start asking.
              </p>
            </div>
          } @else {
            <ul class="mt-3 overflow-hidden rounded-lg border border-border bg-card">
              @for (item of activity.items(); track item.id) {
                <li
                  class="flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0"
                >
                  <app-icon [name]="item.icon" [size]="14" class="shrink-0 text-muted-foreground" />
                  <p class="min-w-0 flex-1 truncate text-sm text-foreground">
                    <span class="font-medium">{{ item.actor }}</span>
                    {{ item.summary }}
                  </p>
                  <span class="shrink-0 text-xs text-muted-foreground">
                    {{ relativeTime(item.createdAt) }}
                  </span>
                </li>
              }
            </ul>
          }
        </section>
      </div>
    } @else {
      <app-admin-access-required />
    }
  `,
})
export class AdminDashboardViewComponent implements OnInit {
  /** Who is signed in, which decides whether this area is open at all. */
  protected readonly auth = inject(AuthService);

  /** The live figures and the activity behind them. */
  protected readonly activity = inject(ActivityService);

  /**
   * Placeholder rows, at uneven widths.
   *
   * Uneven because four bars the same length read as a table, and this is a list of
   * sentences of different lengths. The widths are the ones the real rows tend to.
   */
  protected readonly skeletonRows = [{ width: 58 }, { width: 72 }, { width: 44 }, { width: 66 }];

  /**
   * What the document figure is counting.
   *
   * Says "not indexed yet" rather than a zero, because an empty list here means the
   * corpus has not been built rather than that the company has no documents.
   */
  protected readonly documentDetail = computed(() =>
    this.activity.documentCount() === 0 ? 'Nothing indexed yet' : 'Available to answer from',
  );

  /**
   * What the waiting figure means, which differs by whether there is anybody.
   *
   * The zero is the case that matters: "nobody is waiting" is good news an
   * administrator can stop thinking about, and it should not read like a problem.
   */
  protected readonly pendingDetail = computed(() =>
    this.activity.pendingRequestCount() === 0
      ? 'Nobody is waiting'
      : 'Asked for an account',
  );

  ngOnInit(): void {
    this.activity.load();
  }

  /**
   * A count as the card renders it.
   *
   * The card's value is a string so a figure that cannot be counted can say so. That
   * is a presentational concern, so the conversion happens here rather than in the
   * service, which deals in counts and has no business formatting them.
   */
  protected asText(count: number): string {
    return String(count);
  }

  /** When an event happened, as a reader would say it. */
  protected relativeTime(isoDate: string): string {
    return formatRelativeTime(isoDate);
  }
}