import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { Observable } from 'rxjs';

import {
  AccessRequestDecisionDto,
  AccessRequestRowDto,
  AccessRequestStatus,
} from '../../core/models/access-request.model';
import type { Role } from '../../core/models/auth.model';
import { parseUtcTimestamp } from '../../core/models/api.model';
import { AuthService } from '../../core/services/auth.service';
import { AdminAccessRequiredComponent } from '../../features/admin/components/admin-access-required/admin-access-required.component';
import { ViewHeaderComponent } from '../../features/chat/components/view-header/view-header.component';
import { BadgeComponent, type BadgeTone } from '../../shared/components/badge/badge.component';
import { ButtonComponent } from '../../shared/components/button/button.component';
import { EmptyStateComponent } from '../../shared/components/empty-state/empty-state.component';
import { IconComponent } from '../../shared/components/icon/icon.component';
import { SkeletonComponent } from '../../shared/components/skeleton/skeleton.component';
import { formatRelativeTime } from '../../shared/utils/relative-time.util';
import { toInitials } from '../../shared/utils/initials.util';

/** Colour per status, so a decided request reads differently from a waiting one. */
const STATUS_TONES: Record<AccessRequestStatus, BadgeTone> = {
  pending: 'warning',
  approved: 'success',
  declined: 'neutral',
};

/** Human-readable label per status. */
const STATUS_LABELS: Record<AccessRequestStatus, string> = {
  pending: 'Waiting',
  approved: 'Approved',
  declined: 'Declined',
};

/**
 * Everybody who has asked for an account, and the two buttons that answer them.
 *
 * This is the administrator's half of the request flow, and it is where an
 * administrator role is granted — the person asking could not set one, so approving
 * with the role set to Administrator is the only way that role comes into being
 * through this route.
 *
 * Approving activates the account with the password they chose when registering,
 * so they can sign in straight away. Requests made before the register form grew
 * password fields carry no password and still hand back an invitation link, shown
 * once per approval rather than stored, because it is a single-use secret and
 * leaving it lying around in a list would be the wrong place for it.
 */
@Component({
  selector: 'app-admin-access-requests-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AdminAccessRequiredComponent,
    BadgeComponent,
    ButtonComponent,
    EmptyStateComponent,
    IconComponent,
    SkeletonComponent,
    ViewHeaderComponent,
  ],
  host: { class: 'flex min-h-0 flex-1 flex-col' },
  template: `
    <app-view-header title="Access requests" />

    @if (auth.isAdmin()) {
      <div class="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:px-8">
        <div class="mx-auto w-full max-w-5xl">
          <p class="text-sm text-muted-foreground">
            People waiting to be given an account. Approving activates them with the
            password they chose, so they can sign in straight away.
          </p>

          @if (failure()) {
            <p
              class="mt-4 flex items-start gap-2 rounded-md bg-danger/10 px-3 py-2 text-xs
                text-danger"
            >
              <app-icon name="alert-triangle" [size]="14" class="mt-0.5 shrink-0" />
              <span>{{ failure() }}</span>
            </p>
          }

          @if (newInviteLink()) {
            <p
              class="mt-4 flex items-start gap-2 rounded-md bg-success/10 px-3 py-3 text-xs
                text-success"
            >
              <app-icon name="send-horizontal" [size]="14" class="mt-0.5 shrink-0" />
              <span class="flex min-w-0 flex-1 flex-col gap-1">
                <span>Send this link to the person you just approved:</span>
                <code class="block break-all rounded bg-card/60 px-2 py-1 text-[11px]">
                  {{ newInviteLink() }}
                </code>
                <span class="opacity-80">It works once and then expires.</span>
              </span>
            </p>
          }

          <div class="mt-5">
            @if (isLoading()) {
              <!--
                Rows in the shape of the real ones, rather than a spinner between two
                screens. The queue is a stack of cards, so the placeholder is a stack
                of cards: same padding, same initials circle, same two lines of name
                and address, and the badge and buttons where they will be. The page
                does not change height when the answer arrives.
              -->
              <ul class="flex flex-col gap-2" aria-hidden="true">
                @for (row of skeletonRows; track row) {
                  <li
                    class="flex items-center gap-3 rounded-lg border border-border bg-card p-3"
                  >
                    <span class="size-9 shrink-0 rounded-full bg-muted"></span>

                    <span class="min-w-0 flex-1">
                      <app-skeleton class="h-3.5 w-32" />
                      <app-skeleton class="mt-1.5 h-2.5 w-48" />
                    </span>

                    <app-skeleton class="h-5 w-16 rounded-full" />
                    <app-skeleton class="h-8 w-20 rounded-sm" />
                  </li>
                }
              </ul>

              <span class="sr-only" role="status">Loading access requests.</span>
            } @else if (isEmpty()) {
              <app-empty-state
                icon="users"
                title="Nobody is waiting"
                message="Requests for access will appear here for an administrator to review."
              />
            } @else {
              <ul class="flex flex-col gap-2">
                @for (row of rows(); track row.id) {
                  <li
                    class="flex flex-wrap items-center gap-3 rounded-lg border border-border
                      bg-card p-3"
                  >
                    <span
                      class="flex size-9 shrink-0 items-center justify-center rounded-full
                        bg-muted text-xs font-semibold text-muted-foreground"
                    >
                      {{ initials(row.name) }}
                    </span>

                    <span class="min-w-0 flex-1">
                      <span class="block truncate text-sm font-medium text-foreground">
                        {{ row.name }}
                      </span>
                      <span class="block truncate text-xs text-muted-foreground">
                        {{ row.email }} · asked {{ ago(row.requested_at) }}
                      </span>
                    </span>

                    <app-badge [tone]="tones[row.status]">{{ labels[row.status] }}</app-badge>

                    @if (row.status === 'pending') {
                      <span class="flex shrink-0 items-center gap-1.5">
                        <button
                          app-button
                          size="sm"
                          variant="outline"
                          [disabled]="isDeciding(row.id)"
                          (click)="approve(row)"
                        >
                          <app-icon name="check" [size]="15" />
                          <span>Approve</span>
                        </button>

                        <!--
                          Which role they get is chosen here rather than by the
                          person asking, so this is the only control in the product
                          that can create an administrator.
                        -->
                        <button
                          app-button
                          size="sm"
                          variant="ghost"
                          [disabled]="isDeciding(row.id)"
                          (click)="approve(row, 'admin')"
                        >
                          <app-icon name="shield" [size]="15" />
                          <span>Make administrator</span>
                        </button>

                        <button
                          app-button
                          size="sm"
                          variant="ghost"
                          tone="dark"
                          [disabled]="isDeciding(row.id)"
                          (click)="decline(row)"
                        >
                          Decline
                        </button>
                      </span>
                    }
                  </li>
                }
              </ul>
            }
          </div>
        </div>
      </div>
    } @else {
      <app-admin-access-required />
    }
  `,
})
export class AdminAccessRequestsViewComponent implements OnInit {
  /** Who is signed in, which decides whether this area is open at all. */
  protected readonly auth = inject(AuthService);

  private readonly destroyRef = inject(DestroyRef);

  /** Every request, pending first. */
  protected readonly rows = signal<AccessRequestRowDto[]>([]);

  /** Whether the list is on its way. */
  protected readonly isLoading = signal(true);

  /** How many placeholder rows to show: enough to read as a queue, not a table. */
  protected readonly skeletonRows = [1, 2, 3];

  /** A failure worth showing, rather than an empty list that looks like good news. */
  protected readonly failure = signal('');

  /** The link the last approval produced, shown once so it can be copied. */
  protected readonly newInviteLink = signal('');

  /** Ids with a decision in flight, so one row cannot be answered twice. */
  private readonly deciding = signal<string[]>([]);

  protected readonly tones = STATUS_TONES;
  protected readonly labels = STATUS_LABELS;

  /**
   * Whether the list is empty because there is genuinely nothing in it.
   *
   * Not true after a failed load, which is the bug this guards: an empty list and a
   * list that could not be fetched look identical, and telling an administrator
   * "nobody is waiting" when the truth is that nobody could read the queue is the
   * one wrong answer to give — they would conclude there was nothing to do.
   */
  protected readonly isEmpty = computed(
    () => !this.isLoading() && this.failure() === '' && this.rows().length === 0,
  );

  ngOnInit(): void {
    this.reload();
  }

  /**
   * Re-reads the queue.
   *
   * Does nothing for anybody who is not an administrator, rather than asking and
   * being refused. The route guard already turns them away, so this is the second
   * layer: a screen that renders for the wrong role should not put a 403 in the
   * console, and should not depend on the guard having run for its own correctness.
   */
  protected reload(): void {
    if (!this.auth.isAdmin()) {
      this.isLoading.set(false);

      return;
    }

    this.isLoading.set(true);
    this.failure.set('');

    this.auth
      .listAccessRequests()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          this.rows.set(response.requests);
          this.isLoading.set(false);
        },
        error: () => {
          // Shown rather than left as an empty list, because an empty queue and a
          // queue that could not be fetched look identical otherwise.
          this.failure.set('The queue could not be loaded. Please try again.');
          this.isLoading.set(false);
        },
      });
  }

  /** Approves a request, optionally as an administrator. */
  protected approve(row: AccessRequestRowDto, role: Role = 'employee'): void {
    this.decide(row, () => this.auth.approveAccessRequest(row.id, role));
  }

  /** Turns a request down, which provisions nothing. */
  protected decline(row: AccessRequestRowDto): void {
    this.decide(row, () => this.auth.declineAccessRequest(row.id));
  }

  /** Whether this row is waiting on an answer. */
  protected isDeciding(id: string): boolean {
    return this.deciding().includes(id);
  }

  /** Initials for the avatar, from the name as typed on the request. */
  protected initials(name: string): string {
    return toInitials(name);
  }

  /** How long ago a request arrived. */
  protected ago(isoDate: string): string {
    return formatRelativeTime(parseUtcTimestamp(isoDate));
  }

  private decide(
    row: AccessRequestRowDto,
    action: () => Observable<AccessRequestDecisionDto>,
  ): void {
    this.deciding.update((ids) => [...ids, row.id]);
    this.failure.set('');

    action()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (decision) => {
          this.deciding.update((ids) => ids.filter((id) => id !== row.id));

          // Replaced in place rather than re-fetched, so the list does not jump and the
          // row the administrator just acted on stays where their eye is.
          this.rows.update((rows) =>
            rows.map((candidate) => (candidate.id === row.id ? decision.request : candidate)),
          );

          // Shown only when the approval actually produced one. An approval where the
          // account already existed has nothing to send.
          this.newInviteLink.set(decision.invite_link);
        },
        error: (error: unknown) => {
          this.deciding.update((ids) => ids.filter((id) => id !== row.id));
          this.failure.set(readDecisionFailure(error));
        },
      });
  }
}

/** What to say when a decision is refused. */
function readDecisionFailure(error: unknown): string {
  const status = (error as { status?: number } | null)?.status;
  const detail = (error as { error?: { detail?: string } } | null)?.error?.detail;

  if (status === 409 && typeof detail === 'string') {
    return detail;
  }
  if (status === 0) {
    return 'Could not reach the server. Please check your connection and try again.';
  }

  return 'That decision could not be recorded. Please try again.';
}
