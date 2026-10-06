import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  HostListener,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { NgClass } from '@angular/common';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map } from 'rxjs';
import { NavigationEnd, Router, RouterLink } from '@angular/router';

import { AuthService } from '../../../../core/services/auth.service';
import { ChatService } from '../../../../core/services/chat.service';
import { ConversationService } from '../../../../core/services/conversation.service';
import { LayoutService } from '../../../../core/services/layout.service';
import { SectionService } from '../../../../core/services/section.service';
import { MIN_PASSWORD_LENGTH } from '../../../../core/models/auth.model';
import { toInitials } from '../../../../shared/utils/initials.util';
import { AvatarComponent } from '../../../../shared/components/avatar/avatar.component';
import { ButtonComponent } from '../../../../shared/components/button/button.component';
import { ConfirmDialogComponent } from '../../../../shared/components/confirm-dialog/confirm-dialog.component';
import { IconComponent, type IconName } from '../../../../shared/components/icon/icon.component';
import { FormFieldComponent } from '../../../../shared/components/form-field/form-field.component';
import { ModalComponent } from '../../../../shared/components/modal/modal.component';
import { ConversationItemComponent } from '../../../conversations/components/conversation-item/conversation-item.component';
import { ConversationSearchComponent } from '../../../conversations/components/conversation-search/conversation-search.component';
import { BrandLogoComponent } from '../brand-logo/brand-logo.component';
import { readRefusalOr } from '../../../auth/utils/read-backend-refusal';

/**
 * One destination in the administrator's navigation.
 *
 * Declared here rather than read from the route table, because a link is a choice
 * about what an administrator is shown, not a fact about what exists. The
 * question-log and access-request routes still resolve; neither is offered,
 * because the sidebar is the only navigation an administrator has and a screen
 * reachable only by typing its URL is not part of the product.
 */
interface AdminNavItem {
  label: string;
  path: string;
  icon: IconName;

  /**
   * Every path that counts as being on this destination.
   *
   * A screen can be reached from more than one address without becoming more than
   * one place in the navigation, and `routerLinkActive` only ever matches one
   * prefix. So a sub-page reached by a sibling address left its own section looking
   * unselected: the highlight said "you are not in Users" while the page on screen
   * was the queue of people waiting to join Users.
   */
  activeFor?: string[];
}

/**
 * What an administrator can reach, in the order they would look for it.
 *
 * Four destinations, and each is a job rather than a screen: the overview, the
 * documents the assistant answers from, and the people who have access — which is
 * where a new account is added, so that adding one and seeing who has one are the
 * same screen rather than two addresses to remember.
 */
const ADMIN_NAV: AdminNavItem[] = [
  { label: 'Dashboard', path: '/admin', icon: 'layout-dashboard' },
  { label: 'Documents', path: '/admin/documents', icon: 'file-text' },
  // The access queue belongs to Users. It is reached from the users screen and from
  // the sidebar, and either way the section somebody is inside is the one lit up.
  { label: 'Users', path: '/admin/users', icon: 'users', activeFor: ['/admin/users', '/admin/access'] },
];

/**
 * The shell's navigation: brand, new conversation, conversation search and recent
 * conversations, plus the administration links for an administrator.
 *
 * One row per conversation, never one per question. That is the distinction the
 * whole list turns on: asking a follow-up extends the conversation it belongs to
 * and leaves this list alone, so the number of rows is the number of threads the
 * user has started rather than the number of questions they have asked.
 *
 * The administration links sit in the footer rather than above the conversations,
 * so an employee's sidebar and an administrator's differ only by what is below the
 * list: an employee who is not an administrator sees no administration section at
 * all, rather than one that is present and disabled.
 *
 * This component renders content only. Every decision about *how* the sidebar
 * is presented lives in `LayoutService`, so this sidebar, the header toggle
 * and the content offset can never disagree about what is on screen.
 */
@Component({
  selector: 'app-chat-sidebar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AvatarComponent,
    BrandLogoComponent,
    ButtonComponent,
    ConfirmDialogComponent,
    ConversationItemComponent,
    ConversationSearchComponent,
    IconComponent,
    FormFieldComponent,
    ModalComponent,
    NgClass,
    RouterLink,
  ],
  host: { class: 'relative flex h-full flex-col overflow-hidden bg-sidebar' },
  template: `
    @if (layout.isRail()) {
      <!--
        The rail is the expanded column with the labels taken off, not a different
        sidebar. Everything below mirrors it: which controls are there, what order
        they are in, and where the section switch sits. A rail that showed the
        conversation list while the expanded column was showing the administration
        links was offering a different set of destinations at a different height, so
        collapsing the sidebar changed what the sidebar was for.
      -->
      <div class="flex h-full flex-col items-center px-3 pt-5 pb-4">
        <app-brand-logo [showWordmark]="false" />

        @if (showsAdminNav()) {
          <!--
            Administration, where the expanded column puts it. The heading is dropped
            along with the labels, which is the only thing lost by collapsing: the
            icons and their titles carry it.
          -->
          <nav class="mt-6 flex flex-col items-center gap-2" aria-label="Administration">
            @for (item of adminNav; track item.path) {
              <a
                app-button
                variant="ghost"
                tone="dark"
                size="rail"
                [routerLink]="item.path"
                [attr.aria-label]="item.label"
                [title]="item.label"
                (click)="layout.closeAfterNavigation()"
              >
                <app-icon [name]="item.icon" [size]="18" />
              </a>
            }
          </nav>
        } @else {
          <!--
            The assistant's own controls, at the same height the expanded column puts
            them. The rail kept only the administration links, so an administrator who
            collapsed the sidebar lost the two things this section is for — starting a
            conversation and reaching the conversation list — and collapsing changed
            what the sidebar was for rather than how much of it there was.
          -->
          <button
            app-button
            type="button"
            variant="ghost"
            tone="dark"
            size="rail"
            class="mt-6"
            aria-label="New conversation"
            title="New Conversation"
            (click)="onNewConversation()"
          >
            <app-icon name="plus" [size]="18" />
          </button>

          <div class="scrollbar-thin mt-4 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
            @for (conversation of conversations.filteredConversations(); track conversation.id) {
              <app-conversation-item
                appearance="rail"
                [conversation]="conversation"
                [isSelected]="isActive(conversation.id)"
                (selected)="openConversation($event)"
                (renamed)="onRenamed($event)"
                (removed)="askToDelete($event)"
              />
            }
          </div>

          <!--
            The rail's way into the expanded column's search box, so it belongs after
            the list rather than above it: it does not search anything itself, it
            hands the conversation list over to the place that can filter it.

            There used to be a second "+" button and a second conversation list below
            this one, unfiltered and unscrollable. Collapsing the sidebar therefore
            showed the same navigation twice — once at the top where the controls
            belong and once again at the bottom, in a different order and ignoring
            the search — and the two copies drifted out of step, so the one at the
            bottom kept offering conversations the one at the top had filtered out.
            Mirroring the expanded column means each control appears once.
          -->
          <button
            app-button
            type="button"
            variant="ghost"
            tone="dark"
            size="rail"
            class="mt-4"
            aria-label="Search conversations"
            (click)="layout.openSidebar()"
          >
            <app-icon name="search" [size]="18" />
          </button>
        }

        <!--
          The section switch, in the same place as the expanded column's: pinned to
          the bottom, immediately above the account. It was previously grouped with
          the administration links at the top, which put it nowhere near where the
          reader had just seen it and made the rail a different arrangement from the
          column it is the collapsed form of.
        -->
        <div class="mt-auto flex flex-col items-center gap-3 pt-4">
          @if (auth.isAdmin()) {
            <a
              app-button
              variant="ghost"
              tone="dark"
              size="rail"
              [routerLink]="showsAdminNav() ? auth.assistantPath() : '/admin'"
              [attr.aria-label]="showsAdminNav() ? 'Ask' : 'View as admin'"
              [title]="showsAdminNav() ? 'Ask' : 'View as admin'"
              (click)="layout.closeAfterNavigation()"
            >
              <app-icon [name]="showsAdminNav() ? 'bot' : 'layout-dashboard'" [size]="18" />
            </a>
          }

          <app-avatar
            [initials]="initials()"
            tone="outline"
            [size]="32"
            [label]="auth.user()?.name ?? ''"
          />
        </div>
      </div>
    } @else {
      <!--
        The administrator's section replaces the conversation controls outright
        rather than sitting above them. Uploading a document and asking a question
        about one are different jobs, and a column offering both at once leaves the
        reader deciding which half of it applies to the screen they are on.
      -->
      @if (showsAdminNav()) {
        <nav class="flex flex-col gap-1 px-4 pt-5" aria-label="Administration">
          <p class="px-2 pb-2 text-xs font-medium text-sidebar-muted">Administration</p>

          @for (item of adminNav; track item.path) {
            <a
              app-button
              variant="ghost"
              tone="dark"
              size="md"
              [fullWidth]="true"
              [alignStart]="true"
              [routerLink]="item.path"
              [ngClass]="{ 'bg-white/10 text-sidebar-foreground': isNavItemActive(item) }"
              (click)="layout.closeAfterNavigation()"
            >
              <app-icon [name]="item.icon" [size]="16" />
              <span>{{ item.label }}</span>
            </a>
          }
        </nav>
      } @else {
        <!-- The expanded column carries no mark: the view header names the
             product instead, so the two never compete for the same corner. -->
        <div class="px-4 pt-5">
          <button
            app-button
            type="button"
            size="lg"
            [fullWidth]="true"
            (click)="onNewConversation()"
          >
            <app-icon name="plus" [size]="16" />
            <span>New Conversation</span>
          </button>

          <!--
            Only once there is something to search. An empty list offered a search box
            that could only ever fail, and typing in it changed the message underneath
            from "no conversations yet" to "nothing matched" — so the one action
            available on an empty list was the one that made it look emptier.
          -->
          @if (conversations.hasConversations()) {
            <div class="mt-3">
              <app-conversation-search
                [value]="conversations.searchTerm()"
                (valueChange)="conversations.setSearchTerm($event)"
              />
            </div>
          }
        </div>
      }

      @if (!showsAdminNav()) {
        <!--
          The same inset as the New Conversation button and the search box above, so
          the three are one column rather than three that happen to be near each
          other.

          It was a half-step narrower with each row adding its own padding inside
          itself, which put the conversation titles at 20px from the edge while the
          search box's text sat at 28px and the New Conversation button's label at
          32px. Three values for one alignment. The row now lines its border box up
          with those controls and its title up with the search placeholder.
        -->
        <nav
          class="scrollbar-thin mt-4 min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4"
          aria-label="Your conversations"
        >
          <div class="flex flex-col gap-1 pb-2">
            @for (group of conversations.groups(); track group.bucket) {
              <div class="px-3 pt-3 pb-1 text-xs font-medium text-sidebar-muted first:pt-0">
                {{ group.bucket }}
              </div>
              @for (conversation of group.conversations; track conversation.id) {
                <app-conversation-item
                  appearance="sidebar"
                  [conversation]="conversation"
                  [isSelected]="isActive(conversation.id)"
                  (selected)="openConversation($event)"
                  (renamed)="onRenamed($event)"
                  (removed)="askToDelete($event)"
                />
              }
            } @empty {
              <p class="px-3 py-2 text-xs leading-relaxed text-sidebar-muted">
                {{ emptyMessage() }}
              </p>
            }
          </div>
        </nav>
      }

      <!--
        Pinned to the bottom of the column, below the conversations, so the account is
        where every signed-in person expects to find it rather than moving about
        depending on how many conversations there are.
      -->
      <div class="mt-auto">
        <!--
          The way to the other half of the app, sitting immediately above the account
          row and above the rule that separates the two.

          It is not inside the account card because it is not an account action. An
          administrator switches between running the knowledge base and using it as
          often as they sign in, and burying that behind a profile menu would make the
          commoner of the two the harder one. Which label it carries depends on the
          section: Ask from the dashboard, View as admin from a conversation, never
          both.
        -->
        @if (auth.isAdmin()) {
          <!--
            Inset to match the administration links above it and the rail's own icons,
            rather than the footer's own padding. The switch belongs to the navigation
            it continues; only the account row below the rule is inset differently.
          -->
          <div class="px-4 pb-3">
            <a
              app-button
              variant="ghost"
              tone="dark"
              size="md"
              [fullWidth]="true"
              [alignStart]="true"
              [routerLink]="showsAdminNav() ? auth.assistantPath() : '/admin'"
              (click)="layout.closeAfterNavigation()"
            >
              <app-icon [name]="showsAdminNav() ? 'bot' : 'layout-dashboard'" [size]="16" />
              <span>{{ showsAdminNav() ? 'Ask' : 'View as admin' }}</span>
            </a>
          </div>
        }

        <div class="border-t border-white/10 p-3">
          <!--
            The positioning context for the card, and nothing more. It has to wrap the
            row rather than the column: the card opens upwards from the name, and an
            offset measured against the sidebar's own height puts it at the top of the
            screen instead of beside the thing that opened it.
          -->
          <div class="relative">
            <!--
              The name is the control, not the decoration. It carries the account's
              only action behind it, so an avatar alone would be a button whose effect
              could not be guessed at, and a lone sign-out icon beside it would be a
              destructive action one mis-click away with nothing to confirm it.
            -->
            <button
              app-button
              type="button"
              variant="ghost"
              tone="dark"
              size="md"
              [fullWidth]="true"
              [alignStart]="true"
              aria-haspopup="menu"
              [attr.aria-expanded]="isAccountOpen()"
              aria-label="Account menu"
              (click)="toggleAccount()"
            >
              <app-avatar [initials]="initials()" tone="outline" [size]="28" />

              <span class="min-w-0 flex-1 truncate text-left">{{ auth.user()?.name ?? '' }}</span>

              <app-icon
                name="chevron-down"
                [size]="14"
                class="shrink-0 transition-transform"
                [class.rotate-180]="isAccountOpen()"
              />
            </button>

            @if (isAccountOpen()) {
              <div
                #accountCard
                class="animate-panel-rise absolute right-0 bottom-full left-0 z-50 mb-2
                  overflow-hidden rounded-lg border border-border bg-card shadow-raised"
                role="menu"
                aria-label="Account"
              >
                <div class="flex items-center gap-2 px-3 py-3">
                  <app-avatar [initials]="initials()" tone="muted" [size]="28" />

                  <span class="min-w-0 flex-1">
                    <span class="block truncate text-sm font-medium text-foreground">
                      {{ auth.user()?.name ?? '' }}
                    </span>
                    <span class="block truncate text-xs text-muted-foreground">
                      {{ auth.user()?.email ?? '' }}
                    </span>
                  </span>
                </div>

                <div class="border-t border-border"></div>

                @if (canChangeOwnPassword()) {
                  <button
                    app-button
                    type="button"
                    variant="ghost"
                    size="sm"
                    class="w-full justify-start rounded-none text-left"
                    role="menuitem"
                    (click)="askToChangeOwnPassword()"
                  >
                    <app-icon name="key-round" [size]="15" />
                    <span>Change password</span>
                  </button>
                }

                <button
                  app-button
                  type="button"
                  variant="ghost"
                  size="sm"
                  class="w-full justify-start rounded-none text-left"
                  role="menuitem"
                  (click)="askToSignOut()"
                >
                  <app-icon name="log-out" [size]="15" />
                  <span>Sign out</span>
                </button>
              </div>
            }
          </div>
        </div>
      </div>

      <app-modal
        [(isOpen)]="isOwnPasswordOpen"
        icon="key-round"
        title="Change your password"
        message="You will be signed out everywhere, including here. Sign in again with the new one."
        (closed)="closeOwnPassword()"
      >
        <app-form-field
          label="Current password"
          type="password"
          icon="lock"
          autocomplete="current-password"
          placeholder="Enter your current password"
          [required]="true"
          [(value)]="ownCurrentPassword"
        />

        <app-form-field
          label="New password"
          type="password"
          icon="lock"
          autocomplete="new-password"
          placeholder="Something you have not used here"
          [required]="true"
          [(value)]="ownPassword"
          [error]="ownPasswordError()"
        />

        @if (ownPasswordNotice()) {
          <p
            class="mt-3 flex items-start gap-2 rounded-md bg-danger/10 px-3 py-2 text-xs
              text-danger"
            role="alert"
          >
            <app-icon name="alert-triangle" [size]="14" class="mt-0.5 shrink-0" />
            <span>{{ ownPasswordNotice() }}</span>
          </p>
        }

        <div modalFooter class="flex justify-between gap-2">
          <button app-button type="button" variant="ghost" (click)="closeOwnPassword()">
            Go back
          </button>
          <button app-button type="button" [disabled]="isBusy()" (click)="saveOwnPassword()">
            Change password
          </button>
        </div>
      </app-modal>

      <app-confirm-dialog
        [isOpen]="isSignOutOpen()"
        icon="log-out"
        title="Sign out?"
        message="You will be asked to sign in again. Your conversations stay saved to your account."
        confirmLabel="Sign out"
        tone="danger"
        (confirmed)="signOut()"
      />

      <!--
        A separate dialog from the sign-out one rather than a shared instance: two
        confirmations cannot both be open, and a single component with one open state
        would let deleting a conversation raise the sign-out question.
      -->
      <app-confirm-dialog
        [isOpen]="pendingDeleteId !== null"
        icon="trash-2"
        tone="danger"
        title="Delete this conversation?"
        message="The conversation and every question and answer in it are removed. This cannot be undone."
        confirmLabel="Delete"
        tone="danger"
        (confirmed)="confirmDelete()"
        (cancelled)="pendingDeleteId = null"
      />
    }
  `,
})
export class ChatSidebarComponent {
  /** Layout state: breakpoint bucket, collapse preference and drawer. */
  protected readonly layout = inject(LayoutService);

  /** The router, for the address bar's contents rather than for navigating. */
  private readonly router = inject(Router);

  /** The conversation list and search term, shared with the conversations view. */
  protected readonly conversations = inject(ConversationService);

  /** Who is signed in, which decides whether the admin links are there at all. */
  protected readonly auth = inject(AuthService);

  /** The administrator's destinations, hidden from everybody else. */
  protected readonly adminNav = ADMIN_NAV;

  /**
   * The path on screen, as a signal.
   *
   * Read from the router's events rather than from `router.url`, which is only a
   * snapshot: a plain property read in a template is not re-evaluated when the URL
   * changes, so the highlight would be right on first paint and stale after every
   * navigation.
   */
  private readonly currentUrl = toSignal(
    this.router.events.pipe(
      filter((event) => event instanceof NavigationEnd),
      map(() => this.router.url),
    ),
    { initialValue: this.router.url },
  );

  /**
   * Whether this destination is the one on screen.
   *
   * Prefix matching, and exact for the overview, so `/admin` does not light up for
   * every administration page. That is the behaviour `routerLinkActive` was
   * configured for, and losing it would have lit three items at once.
   */
  protected isNavItemActive(item: AdminNavItem): boolean {
    const url = this.currentUrl();

    return (item.activeFor ?? [item.path]).some((path) =>
      path === '/admin' ? url === path : url.startsWith(path),
    );
  }

  /** Which of the two sections the signed-in person is currently in. */
  protected readonly section = inject(SectionService);

  /**
   * Whether the administration navigation is the sidebar's job right now.
   *
   * Only for an administrator, and only while they are on one of their own screens.
   * An employee never sees it, and an administrator in the assistant is asking a
   * question — where the conversation list is the navigation, and a section of three
   * administration links would be competing with it for the same column.
   */
  protected readonly showsAdminNav = computed(
    () => this.auth.isAdmin() && this.section.isAdminSection(),
  );

  /**
 * The signed-in person's initials.
 *
 * A placeholder rather than nothing when the name has not arrived, because a blank
 * circle reads as a broken control: it is the one thing on screen that says who is
 * signed in, and an empty badge beside an empty name leaves the person looking at a
 * page that has decided nobody is here.
 */
  protected readonly initials = computed(() => toInitials(this.auth.user()?.name ?? ''));

  /** The conversation a delete confirmation is about, or null when there is none. */
  private pendingDeleteId: string | null = null;

  constructor() {
    // Registered on the document so a click in the chat area, the header, or any
    // other part of the page dismisses the card. Removed with the component, so it
    // cannot outlive the sidebar and keep swallowing clicks after a navigation.
    if (typeof document !== 'undefined') {
      document.addEventListener('click', this.onDocumentClick, true);
      inject(DestroyRef).onDestroy(() =>
        document.removeEventListener('click', this.onDocumentClick, true),
      );
    }
  }

  /** Whether the sign-out confirmation is open. */
  protected readonly isSignOutOpen = signal(false);

  /** Whether the account card is open. */
  protected readonly isAccountOpen = signal(false);

  /**
   * Closes the account card on any click elsewhere on the page.
   *
   * Not an overlay element. An overlay large enough to cover the page has to live
   * outside the sidebar, because the sidebar clips its own contents — a `fixed`
   * overlay inside it covers the sidebar's box and nothing else, which meant only a
   * click within the sidebar dismissed the card. A click in the chat area, on the
   * header, or anywhere else on the page went straight through.
   *
   * Bound to the document rather than to an element so the click that opened the
   * card, and a click inside the card, are both recognised as outside-the-rest and
   * ignored: `relatedTarget` is still inside for both, since neither moves focus.
   */
  protected readonly onDocumentClick = (event: MouseEvent): void => {
    if (!this.isAccountOpen()) {
      return;
    }

    const origin = event.target;
    if (!(origin instanceof Node)) {
      return;
    }

    const insideTrigger = this.accountTrigger()?.nativeElement.contains(origin) ?? false;
    const insideCard = this.accountCard()?.nativeElement.contains(origin) ?? false;

    if (insideTrigger || insideCard) {
      return;
    }

    this.closeAccount();
  };

  private readonly chat = inject(ChatService);

  /**
   * Whether this row is the open conversation.
   *
   * One value decides this, and it is the same one that decides where a new question
   * goes. That is the whole point: the highlight used to be computed from the route
   * while the question went to `activeId`, so the row could be lit for a conversation
   * nothing was being added to, or unlit for the one that was.
   *
   * A blank window now has nothing open at all, because the ask screen says so when
   * it is built, rather than this hiding the disagreement.
   */
  protected isActive(conversationId: string): boolean {
    return this.conversations.activeId() === conversationId;
  }

  /** Explains an empty list, distinguishing "none yet" from "no matches". */
  protected readonly emptyMessage = computed(() =>
    this.conversations.hasNoResults()
      ? 'No conversations match your search.'
      : 'No conversations yet. Ask one to get started.',
  );

  /**
   * Ends the session, here and on the server.
   *
   * The local session ends first and the navigation follows it immediately, so
   * the button answers at once even if the network does not: on a cold or slow
   * connection the revocation request can hang long enough that waiting on it
   * reads as a dead button. The revocation still goes out in the background and
   * still carries the cookies, so the server session dies as usual — the page
   * just does not wait around to watch it happen.
   */
  protected signOut(): void {
    this.layout.closeAfterNavigation();
    this.auth.clear();
    void this.router.navigate(['/login']);
    this.auth.logout().subscribe();
  }

  /** Opens the account card, or closes it if it is already open. */
  protected toggleAccount(): void {
    this.isAccountOpen.update((open) => !open);
  }

  private readonly accountTrigger = viewChild<ElementRef<HTMLButtonElement>>('accountTrigger');
  private readonly accountCard = viewChild<ElementRef<HTMLElement>>('accountCard');

  /**
   * Whether this person can change their own password from here.
   *
   * Everybody signed in: the self-service route checks the current password
   * rather than the role, so an employee proves possession the same way an
   * administrator does. Offered from the account card so it does not require
   * finding yourself in a list of other people first.
   */
  protected readonly canChangeOwnPassword = computed(() => this.auth.isAuthenticated());

  protected readonly isOwnPasswordOpen = signal(false);
  protected readonly ownCurrentPassword = signal('');
  protected readonly ownPassword = signal('');
  protected readonly isBusy = signal(false);

  /** What went wrong with the last change attempt, shown inside the dialog. */
  protected readonly ownPasswordNotice = signal('');

  protected readonly ownPasswordError = computed(() => {
    const value = this.ownPassword();

    if (value === '') {
      return '';
    }

    return value.length >= MIN_PASSWORD_LENGTH ? '' : `Use at least ${MIN_PASSWORD_LENGTH} characters`;
  });

  /** Opens the dialog, discarding whatever the last attempt left behind. */
  protected askToChangeOwnPassword(): void {
    this.closeAccount();
    this.ownCurrentPassword.set('');
    this.ownPassword.set('');
    this.ownPasswordNotice.set('');
    this.isOwnPasswordOpen.set(true);
  }

  protected closeOwnPassword(): void {
    this.isOwnPasswordOpen.set(false);
    this.ownCurrentPassword.set('');
    this.ownPassword.set('');
    this.ownPasswordNotice.set('');
  }

  /**
   * Sets the new password, then signs out.
   *
   * The change revokes every session for the account, so staying put would leave
   * a page that looks signed in and fails on the next action — going through
   * the sign-in screen is the honest sequence. A refusal keeps the dialog open
   * with the reason, so a mistyped current password is a retry rather than a
   * dismissal.
   */
  protected saveOwnPassword(): void {
    if (this.auth.user() === null || this.isBusy()) {
      return;
    }

    if (this.ownCurrentPassword() === '') {
      this.ownPasswordNotice.set('Enter your current password.');
      return;
    }

    if (this.ownPassword().length < MIN_PASSWORD_LENGTH) {
      this.ownPasswordNotice.set(
        `Choose a new password of at least ${MIN_PASSWORD_LENGTH} characters.`,
      );
      return;
    }

    // No request is made when nothing would change: the backend would refuse a
    // password that is already the current one, so saying so here saves the
    // round trip rather than spending it to be told.
    if (this.ownPassword() === this.ownCurrentPassword()) {
      this.ownPasswordNotice.set('Your new password must be different from the current one.');
      return;
    }

    this.isBusy.set(true);
    this.ownPasswordNotice.set('');

    this.auth.changeOwnPassword(this.ownCurrentPassword(), this.ownPassword()).subscribe({
      next: () => {
        this.isBusy.set(false);
        this.closeOwnPassword();
        this.signOut();
      },
      error: (error: unknown) => {
        this.isBusy.set(false);

        this.ownPasswordNotice.set(
          (error as { status?: number } | null)?.status === 401
            ? 'Your current password is not correct.'
            : readRefusalOr(error, 'Your password could not be changed. Please try again.'),
        );
      },
    });
  }

  /** Closes the account card without acting on anything in it. */
  protected closeAccount(): void {
    this.isAccountOpen.set(false);
  }

  /** Closes the card and asks to sign out, so the confirmation is not behind it. */
  protected askToSignOut(): void {
    this.closeAccount();
    this.isSignOutOpen.set(true);
  }

  /**
   * Escape closes the account card.
   *
   * On the document rather than the card, so it works wherever focus happens to be:
   * the card is not a dialog, so nothing traps focus inside it, and the key could
   * easily be pressed somewhere else on the page.
   */
  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    this.closeAccount();
  }

  /** Starts a new conversation and returns to the assistant. */
  protected onNewConversation(): void {
    this.chat.startNewConversation();
    this.layout.closeAfterNavigation();
    void this.router.navigateByUrl(this.auth.assistantPath());
  }

  /** Names a conversation from its row. */
  protected onRenamed(change: { id: string; title: string }): void {
    this.conversations.renameConversation(change.id, change.title);
  }

  /**
   * Asks before deleting, rather than deleting.
   *
   * A conversation and everything said in it cannot be recovered, and the row this is
   * reached from is one click away from opening it — so the click that asks for the
   * deletion is also a click that deletes it.
   */
  protected askToDelete(conversationId: string): void {
    this.pendingDeleteId = conversationId;
  }

  /** Deletes the conversation the confirmation is about. */
  protected confirmDelete(): void {
    const conversationId = this.pendingDeleteId;
    this.pendingDeleteId = null;

    if (conversationId === null) {
      return;
    }

    // Deleting the conversation on screen has to go somewhere: the service leaves
    // a fresh unsaved window, and this routes to the assistant entry, which is a
    // page for starting a new conversation rather than the blank remains of the
    // deleted one. Anything else stays exactly where it was.
    const wasOpen = conversationId === this.conversations.activeId();

    this.conversations.deleteConversation(conversationId);

    if (wasOpen) {
      this.layout.closeAfterNavigation();
      void this.router.navigateByUrl(this.auth.assistantPath());
    }
  }

  /** Opens the conversation a row stands for. */
  protected openConversation(conversationId: string): void {
    this.layout.closeAfterNavigation();
    void this.router.navigate(['/response', conversationId]);
  }
}
