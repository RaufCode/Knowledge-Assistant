import { isPlatformBrowser } from '@angular/common';
import { DestroyRef, Injectable, PLATFORM_ID, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Observable, catchError, forkJoin, map, of } from 'rxjs';

import type { AccessRequestRowDto } from '../models/access-request.model';
import { ACTIVITY_LIMIT, type ActivityItem } from '../models/activity.model';
import type { Conversation } from '../models/conversation.model';
import { ApiService } from './api.service';
import { AuthService } from './auth.service';
import { IdentityService } from './identity.service';

/**
 * The administrator's recent activity, assembled from the reads that already exist.
 *
 * There is no event log on the backend, so this builds one out of what can be
 * asked. Access requests carry when they arrived and when they were decided, and
 * between them they cover what an administrator is asked about most: who is
 * waiting for an account.
 *
 * Questions asked are deliberately not in here. A feed row per question would
 * read as surveillance of what people typed, and the conversations count beside
 * it already says how much is being asked.
 *
 * Nothing here invents an event. A source that cannot be read contributes no rows,
 * which is why every one of them is allowed to come back empty rather than being
 * padded to fill the list.
 */
@Injectable({ providedIn: 'root' })
export class ActivityService {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly identity = inject(IdentityService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  private readonly requestsState = signal<AccessRequestRowDto[]>([]);
  private readonly conversationsState = signal<Conversation[]>([]);
  private readonly documentTitlesState = signal<string[]>([]);
  private readonly loadingState = signal(false);
  private readonly loadedState = signal(false);

  /** True while the first load is in flight. */
  readonly isLoading = this.loadingState.asReadonly();

  /** True once a load has finished, successfully or partly. */
  readonly isLoaded = this.loadedState.asReadonly();

  /**
   * Every event available, newest first.
   *
   * Access requests and their decisions, as one chronology: the ask and the
   * answer to it belong together, and a decision with nothing to attach it to is
   * a number nobody can act on.
   */
  readonly items = computed<ActivityItem[]>(() =>
    this.requestsState()
      .flatMap(toRequestActivity)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, ACTIVITY_LIMIT),
  );

  /** True when there is genuinely nothing to show, as opposed to nothing loaded yet. */
  readonly isEmpty = computed(
    () => this.loadedState() && !this.loadingState() && this.items().length === 0,
  );

  /** How many documents are in the indexed corpus. */
  readonly documentCount = computed(() => this.documentTitlesState().length);

  /** People waiting for an account, which is the one figure that needs a decision. */
  readonly pendingRequestCount = computed(
    () => this.requestsState().filter((row) => row.status === 'pending').length,
  );

  /** Conversations this browser holds. */
  readonly conversationCount = computed(() => this.conversationsState().length);

  /**
   * Re-reads every source.
   *
   * Asks for nothing when there is no administrator session, so a signed-out
   * visitor never puts a 403 in the console from a screen they cannot reach.
   */
  load(): void {
    if (!this.isBrowser || !this.auth.isAdmin()) {
      this.loadedState.set(true);

      return;
    }

    this.loadingState.set(true);

    forkJoin({
      requests: this.read(this.auth.listAccessRequests(), (response) => response.requests, []),
      conversations: this.read(
        this.api.getConversations(this.identity.clientId()),
        (rows) => rows,
        [],
      ),
      documents: this.read(this.api.getIndexedDocuments(), (titles) => titles, []),
    }).subscribe(({ requests, conversations, documents }) => {
      this.requestsState.set(requests);
      this.conversationsState.set(conversations);
      this.documentTitlesState.set(documents);
      this.loadingState.set(false);
      this.loadedState.set(true);
    });
  }

  /**
   * One source, reduced to a value, or to nothing when it fails.
   *
   * A failed read costs its own rows rather than the whole list. This is a summary,
   * and a shorter honest one is more use than an error page. Nothing is logged:
   * the empty result already says the figure is unknown, and an administrator
   * cannot act on a stack trace.
   */
  private read<T, R>(source: Observable<T>, project: (value: T) => R, empty: R): Observable<R> {
    return source.pipe(
      map(project),
      catchError(() => of(empty)),
      takeUntilDestroyed(this.destroyRef),
    );
  }
}

/**
 * One access request as events.
 *
 * A decided request produces two rows: the decision, and the request behind it. An
 * approval is what an administrator acted on and when they did it, and a decision
 * with nothing to attach it to is a number nobody can act on.
 */
function toRequestActivity(row: AccessRequestRowDto): ActivityItem[] {
  const asked: ActivityItem = {
    id: `request-${row.id}`,
    actor: row.name,
    summary: 'asked for access',
    createdAt: row.requested_at,
    icon: 'user-plus',
  };

  if (!row.decided_at) {
    return [asked];
  }

  const decided: ActivityItem = {
    id: `decision-${row.id}`,
    actor: row.name,
    summary: row.status === 'approved' ? 'was given access' : 'was declined',
    createdAt: row.decided_at,
    icon: row.status === 'approved' ? 'check-circle-2' : 'x',
  };

  return [decided, asked];
}