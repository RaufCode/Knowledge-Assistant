import {
  ChangeDetectionStrategy,
  Component,
  Injector,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';

import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  COMPANY_EMAIL_DOMAIN,
  isCompanyEmail,
} from '../../core/models/auth.model';
import type { Role } from '../../core/models/auth.model';
import type { UserSummaryDto } from '../../core/models/access-request.model';
import { AuthService } from '../../core/services/auth.service';
import { AdminAccessRequiredComponent } from '../../features/admin/components/admin-access-required/admin-access-required.component';
import { ViewHeaderComponent } from '../../features/chat/components/view-header/view-header.component';
import { BadgeComponent } from '../../shared/components/badge/badge.component';
import { ButtonComponent } from '../../shared/components/button/button.component';
import { ConfirmDialogComponent } from '../../shared/components/confirm-dialog/confirm-dialog.component';
import { FormFieldComponent } from '../../shared/components/form-field/form-field.component';
import { InputComponent } from '../../shared/components/input/input.component';
import { IconComponent } from '../../shared/components/icon/icon.component';
import { ModalComponent } from '../../shared/components/modal/modal.component';
import { GENERIC_REFUSAL, readRefusalOr } from '../../features/auth/utils/read-backend-refusal';

/** What the confirmation currently open is about. */
type PendingAction =
  | { kind: 'delete'; user: UserSummaryDto }
  | { kind: 'reset-password'; user: UserSummaryDto };

/** One credential the administrator has just chosen and has to hand over. */
interface HandedOver {
  heading: string;
  email: string;
  password: string;
}

/**
 * Everybody who has an account, and everything an administrator can do to one.
 *
 * The list is the screen. Adding somebody used to be the whole of this route, which
 * meant the way to see who had access was to remember a second address — so a person
 * who had been given an account by somebody else was invisible. Names, addresses and
 * roles, ten to a page, because a screen that renders a thousand rows is a screen
 * nobody can use.
 *
 * Four things can be done to an account: change its role, change its address, reset
 * its password, and delete it. Each is behind a confirmation, and each refuses to act
 * on the administrator's own account — every one of those is survivable on somebody
 * else and fatal on your own.
 */
@Component({
  selector: 'app-admin-users-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AdminAccessRequiredComponent,
    BadgeComponent,
    ButtonComponent,
    ConfirmDialogComponent,
    FormFieldComponent,
    IconComponent,
    InputComponent,
    ModalComponent,
    ReactiveFormsModule,
    RouterLink,
    ViewHeaderComponent,
  ],
  host: { class: 'flex min-h-0 flex-1 flex-col' },
  template: `
    <app-view-header title="Users" />

    <div class="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:px-8">
      <!--
        Full width, like the documents page and the bar above it.

        A centred column was holding this page to 56rem while the header it sits
        beneath ran the full width of the window, so the two disagreed about where
        the page began and ended. A list of people is also the widest thing in the
        product — columns of name, address, role and dates — and truncating it to fit
        a reading measure made those columns worse.
      -->
      <div class="flex min-w-0 flex-1 flex-col">
        @if (!auth.isAdmin()) {
          <app-admin-access-required />
        } @else {
          <!--
            The two actions sit above the list rather than below it.

            They used to be underneath, which made reaching them mean scrolling past
            every account — so the way to add somebody and the way to see who has an
            account were both below the thing they operate on. At the top they are the
            first thing on the page and the list is what they act on.
          -->
          <div class="mb-4 flex flex-col gap-3">
            <div class="flex flex-wrap gap-2">
            <a routerLink="/admin/access">
              <button app-button type="button" variant="outline" size="sm">
                <app-icon name="users" [size]="14" />
                <span>View access requests</span>
              </button>
            </a>

            <button app-button type="button" size="sm" (click)="openCreate()">
              <app-icon name="user-plus" [size]="14" />
              <span>Add a user</span>
            </button>
            </div>

            <div class="w-full sm:max-w-xs">
              <app-input
                [value]="search()"
                (valueChange)="search.set($event)"
                placeholder="Search this page"
                ariaLabel="Search accounts by name or email"
              />
            </div>

            @if (searchScope(); as scope) {
              <p class="text-xs text-muted-foreground" role="status">{{ scope }}</p>
            }
          </div>

          @if (notice()) {
            <p
              class="mb-4 flex items-start gap-2 rounded-md px-3 py-2 text-xs"
              [class]="notice().startsWith('Could not') ? 'bg-danger/10 text-danger' : 'bg-muted text-muted-foreground'"
              role="alert"
            >
              <app-icon name="info" [size]="14" class="mt-0.5 shrink-0" />
              <span>{{ notice() }}</span>
            </p>
          }

          <div class="overflow-hidden rounded-lg border border-border bg-card">
            @if (isLoading()) {
              <p class="px-4 py-8 text-center text-sm text-muted-foreground">Loading accounts…</p>
            } @else if (visibleUsers().length === 0) {
              <!--
                A stated absence rather than an empty table. "Could not load the
                accounts" is what a failure says, and showing it because the list
                happened to be empty would tell an administrator the opposite of what
                is true.
              -->
              <div class="px-4 py-12 text-center">
                <p class="text-sm font-medium text-foreground">There is no account yet</p>
                <p class="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
                  Nobody has been given access. Add one above, or wait for somebody to
                  request it.
                </p>

                <a routerLink="/admin/access" class="mt-4 inline-block">
                  <button app-button type="button" variant="outline" size="sm">
                    <span>View access requests</span>
                  </button>
                </a>
              </div>
            } @else {
              @for (user of visibleUsers(); track user.id) {
                <div
                  class="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3
                    last:border-b-0"
                >
                  <div class="min-w-0 flex-1">
                    <p class="truncate text-sm font-medium text-foreground">{{ user.name }}</p>
                    <p class="truncate text-xs text-muted-foreground">{{ user.email }}</p>
                  </div>

                  <app-badge [tone]="user.role === 'admin' ? 'brand' : 'info'">
                    {{ user.role === 'admin' ? 'Administrator' : 'Employee' }}
                  </app-badge>

                  @if (!user.is_active) {
                    <app-badge tone="warning">Pending</app-badge>
                  }

                  @if (user.id === auth.user()?.id) {
                    <span class="text-xs text-muted-foreground">You</span>
                  } @else {
                    <div class="flex shrink-0 items-center gap-1">
                      <button
                        app-button
                        type="button"
                        variant="ghost"
                        size="sm"
                        [attr.aria-label]="'Change role for ' + user.name"
                        (click)="beginRoleChange(user)"
                      >
                        <app-icon name="key-round" [size]="14" />
                        <span class="hidden sm:inline">Role</span>
                      </button>

                      <button
                        app-button
                        type="button"
                        variant="ghost"
                        size="sm"
                        [attr.aria-label]="'Reset password for ' + user.name"
                        (click)="askResetPassword(user)"
                      >
                        <app-icon name="lock" [size]="14" />
                        <span class="hidden sm:inline">Password</span>
                      </button>

                      <button
                        app-button
                        type="button"
                        variant="ghost"
                        size="sm"
                        class="text-danger hover:bg-danger/10"
                        [attr.aria-label]="'Delete ' + user.name"
                        (click)="askDelete(user)"
                      >
                        <app-icon name="trash-2" [size]="14" />
                      </button>
                    </div>
                  }
                </div>
              }
            }
          </div>

          <!--
            The pager is drawn from the server's own page count rather than counting
            rows, so it cannot disagree with the server about how many there are.
          -->
          @if (pages() > 1) {
            <div class="mt-4 flex items-center justify-between gap-3">
              <p class="text-xs text-muted-foreground">
                {{ total() }} account{{ total() === 1 ? '' : 's' }} · page {{ page() }} of
                {{ pages() }}
              </p>

              <div class="flex items-center gap-2">
                <button
                  app-button
                  type="button"
                  variant="outline"
                  size="sm"
                  [disabled]="page() <= 1 || isLoading()"
                  (click)="goToPage(page() - 1)"
                >
                  Previous
                </button>
                <button
                  app-button
                  type="button"
                  variant="outline"
                  size="sm"
                  [disabled]="page() >= pages() || isLoading()"
                  (click)="goToPage(page() + 1)"
                >
                  Next
                </button>
              </div>
            </div>
          }

        }
      </div>
    </div>

    <!--
      Adding somebody, as a dialog rather than a form that opens on the page.

      Inline, the form pushed the list down the screen and the page changed shape
      under the person looking at it. A dialog keeps the accounts where they were and
      makes the way out obvious — a close button, Escape, and a click outside, all of
      which this component already has from the shared dialog.

      Every one of those needs a visible way back as well, because a dialog whose only
      exits are its own dismissals is a trap for anybody who does not guess.
    -->
    <app-modal
      [(isOpen)]="isCreating"
      title="Add a user"
      message="They can sign in as soon as you have made the account."
      icon="user-plus"
      (closed)="closeCreate()"
    >
      <form class="flex flex-col gap-4" [formGroup]="createForm" (ngSubmit)="createUser()">
        <app-form-field
          label="Full name"
          [faintPlaceholder]="true"
          icon="user"
          autocomplete="off"
          placeholder="Ama Konadu"
          [required]="true"
          [(value)]="createName"
          [error]="createNameError()"
        />

        <app-form-field
          label="Work email"
          [faintPlaceholder]="true"
          type="email"
          icon="mail"
          autocomplete="off"
          [placeholder]="'you@' + companyDomain"
          [required]="true"
          [(value)]="createEmail"
          [error]="createEmailError()"
        />

        <app-form-field
          label="Password"
          type="password"
          icon="lock"
          autocomplete="new-password"
          placeholder="Something they can remember"
          [required]="true"
          [(value)]="createPassword"
          [error]="createPasswordError()"
        />

        <p class="-mt-2 text-xs text-muted-foreground">
          At least {{ minPasswordLength }} characters. You will be shown this once, to hand
          over — it is never shown again.
        </p>

        <fieldset class="flex flex-col gap-2">
          <legend class="text-sm font-medium text-foreground">Role</legend>
          <div class="flex flex-col gap-2">
            @for (option of roleOptions; track option.value) {
              <label
                class="flex cursor-pointer items-start gap-2.5 rounded-md border border-border
                  px-3 py-2.5 text-sm transition-colors hover:border-primary/40"
                [class.border-primary]="createRole() === option.value"
              >
                <input
                  type="radio"
                  name="createRole"
                  class="mt-0.5 size-3.5 cursor-pointer accent-primary"
                  [value]="option.value"
                  [checked]="createRole() === option.value"
                  (change)="createRole.set(option.value)"
                />
                <span class="flex flex-col gap-0.5">
                  <span class="font-medium text-foreground">{{ option.label }}</span>
                  <span class="text-xs text-muted-foreground">{{ option.detail }}</span>
                </span>
              </label>
            }
          </div>
        </fieldset>
      </form>

      <div modalFooter class="flex justify-between gap-2">
        <button app-button type="button" variant="ghost" (click)="closeCreate()">
          Go back
        </button>
        <button app-button type="button" [disabled]="isBusy()" (click)="createUser()">
          {{ isBusy() ? 'Creating…' : 'Create account' }}
        </button>
      </div>
    </app-modal>

    <!-- Changing a role, which is a decision rather than a correction. -->
    <app-modal
      [isOpen]="roleTarget() !== null"
      title="Change role"
      [message]="
        roleTarget() !== null ? roleTarget()!.name + ' will be able to do the following instead.' : ''
      "
      icon="key-round"
      (closed)="roleTarget.set(null)"
    >
      <div class="flex flex-col gap-2">
        @for (option of roleOptions; track option.value) {
          <label
            class="flex cursor-pointer items-start gap-2.5 rounded-md border border-border
              px-3 py-2.5 text-sm transition-colors hover:border-primary/40"
            [class.border-primary]="chosenRole() === option.value"
          >
            <input
              type="radio"
              name="roleChange"
              class="mt-0.5 size-3.5 cursor-pointer accent-primary"
              [value]="option.value"
              [checked]="chosenRole() === option.value"
              (change)="chosenRole.set(option.value)"
            />
            <span class="flex flex-col gap-0.5">
              <span class="font-medium text-foreground">{{ option.label }}</span>
              <span class="text-xs text-muted-foreground">{{ option.detail }}</span>
            </span>
          </label>
        }
      </div>

      <div modalFooter class="flex justify-between gap-2">
        <button app-button type="button" variant="ghost" (click)="roleTarget.set(null)">
          Go back
        </button>
        <button app-button type="button" [disabled]="isBusy()" (click)="saveRole()">
          Save role
        </button>
      </div>
    </app-modal>

    <!-- The password, once. -->
    <app-modal
      [isOpen]="passwordTarget() !== null"
      title="Set a new password"
      [message]="
        passwordTarget() !== null
          ? 'For ' + passwordTarget()!.name + '. You will be shown it once, to hand over.'
          : ''
      "
      icon="lock"
      (closed)="passwordTarget.set(null)"
    >
      <app-form-field
        label="New password"
        type="password"
        icon="lock"
        autocomplete="new-password"
        [placeholder]="'At least ' + minPasswordLength + ' characters'"
        [required]="true"
        [value]="newPassword()"
        [error]="newPasswordError()"
        (valueChange)="newPassword.set($event)"
      />

      <p class="mt-2 text-xs text-muted-foreground">
        This ends every session they have open, so anybody who copied a cookie is signed out too.
      </p>

      <div modalFooter class="flex justify-between gap-2">
        <button app-button type="button" variant="ghost" (click)="passwordTarget.set(null)">
          Go back
        </button>
        <button app-button type="button" [disabled]="isBusy()" (click)="savePassword()">
          Set password
        </button>
      </div>
    </app-modal>

    <!-- The credentials, to hand over. -->
    <app-modal
      [isOpen]="handedOver() !== null"
      [title]="handedOver()?.heading ?? ''"
      message="This is the only time it is shown. Copy it now rather than reading it aloud."
      icon="check-circle-2"
      (closed)="handedOver.set(null)"
    >
      @if (handedOver(); as details) {
        <dl class="flex flex-col gap-2">
          <div class="flex items-center gap-3 rounded-md border border-border bg-background px-3 py-2">
            <dt class="w-20 shrink-0 text-xs text-muted-foreground">Email</dt>
            <dd class="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
              {{ details.email }}
            </dd>
          </div>
          <div class="flex items-center gap-3 rounded-md border border-border bg-background px-3 py-2">
            <dt class="w-20 shrink-0 text-xs text-muted-foreground">Password</dt>
            <dd class="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
              {{ details.password }}
            </dd>
          </div>
        </dl>
      }
    </app-modal>

    <app-confirm-dialog
      [isOpen]="pendingAction() !== null"
      [tone]="pendingAction()?.kind === 'delete' ? 'danger' : 'primary'"
      [title]="pendingAction()?.kind === 'delete' ? 'Delete this account?' : 'Set a new password?'"
      [message]="pendingMessage()"
      [icon]="pendingAction()?.kind === 'delete' ? 'trash-2' : 'lock'"
      [confirmLabel]="pendingAction()?.kind === 'delete' ? 'Delete' : 'Set password'"
      (confirmed)="confirmPending()"
      (cancelled)="pendingAction.set(null)"
    />
  `,
})
export class AdminUsersViewComponent {
  protected readonly auth = inject(AuthService);
  private readonly formBuilder = inject(FormBuilder);

  protected readonly companyDomain = COMPANY_EMAIL_DOMAIN;
  protected readonly minPasswordLength = MIN_PASSWORD_LENGTH;

  protected readonly roleOptions: { value: Role; label: string; detail: string }[] = [
    {
      value: 'employee',
      label: 'Employee',
      detail: 'Ask questions and read their own conversations.',
    },
    {
      value: 'admin',
      label: 'Administrator',
      detail: 'Also manage documents and people.',
    },
  ];

  protected readonly users = signal<UserSummaryDto[]>([]);
  protected readonly total = signal(0);
  protected readonly page = signal(1);
  protected readonly pages = signal(1);
  protected readonly isLoading = signal(false);
  protected readonly isBusy = signal(false);
  protected readonly notice = signal('');

  /** What has been typed into the search box. */
  protected readonly search = signal('');

  /**
   * The accounts on this page that match the search.
   *
   * A client-side filter, and it says so on screen. The list is paged ten at a time by
   * the backend, so this sees one page and not the whole directory — a search box that
   * quietly matched ten of four hundred accounts would be worse than none, because it
   * answers "no such person" about somebody standing further along the list.
   *
   * Name and address, because those are what somebody remembers about a colleague.
   * Case-insensitive, and matched anywhere in the string so a surname typed on its own
   * still finds them.
   */
  protected readonly visibleUsers = computed(() => {
    const term = this.search().trim().toLowerCase();

    if (term === '') {
      return this.users();
    }

    return this.users().filter(
      (user) =>
        user.name.toLowerCase().includes(term) || user.email.toLowerCase().includes(term),
    );
  });

  /**
   * What the search is actually looking at, said plainly while one is active.
   *
   * Empty when nothing has been typed, so the ordinary page says nothing about scope.
   */
  protected readonly searchScope = computed(() => {
    const term = this.search().trim();

    if (term === '') {
      return '';
    }

    const onPage = this.users().length;

    return onPage === 0
      ? `Nobody on this page matches "${term}".`
      : `${this.visibleUsers().length} of ${onPage} on this page match "${term}". Search the database to look further.`;
  });

  /** Whether the add-user dialog is showing. */
  protected readonly isCreating = signal(false);

  /** Opens the dialog with an empty form, whatever the last attempt left behind. */
  protected openCreate(): void {
    this.submitted = false;
    this.resetCreateForm();
    this.isCreating.set(true);
  }

  /** Closes it, discarding anything half filled in. */
  protected closeCreate(): void {
    this.isCreating.set(false);
    this.submitted = false;
    this.resetCreateForm();
  }

  protected readonly createName = signal('');
  protected readonly createEmail = signal('');
  protected readonly createPassword = signal('');
  protected readonly createRole = signal<Role>('employee');

  /** The account whose role is being changed, or null. */
  protected readonly roleTarget = signal<UserSummaryDto | null>(null);
  protected readonly chosenRole = signal<Role>('employee');

  protected readonly passwordTarget = signal<UserSummaryDto | null>(null);
  protected readonly newPassword = signal('');

  /**
   * What the open confirmation is about, said plainly.
   *
   * Computed rather than assembled in the template: naming the person being deleted
   * has to come from a narrowed type, and a cast cannot be written inside an Angular
   * expression.
   */
  protected readonly pendingMessage = computed(() => {
    const action = this.pendingAction();

    if (action === null) {
      return '';
    }

    return action.kind === 'delete'
      ? `${action.user.name} loses access immediately, along with every conversation they have. This cannot be undone.`
      : 'Every session they have open will be signed out.';
  });

  /** The credentials just chosen, to hand over. */
  protected readonly handedOver = signal<HandedOver | null>(null);

  protected readonly pendingAction = signal<PendingAction | null>(null);

  protected readonly createForm = this.formBuilder.nonNullable.group({
    name: ['', [Validators.required, Validators.maxLength(120)]],
    email: ['', [Validators.required, Validators.email]],
    password: [
      '',
      [Validators.required, Validators.minLength(MIN_PASSWORD_LENGTH), Validators.maxLength(MAX_PASSWORD_LENGTH)],
    ],
  });

  private submitted = false;

  protected readonly createNameError = computed(() =>
    this.submitted && this.createName().trim() === '' ? 'Enter their full name' : '',
  );

  protected readonly createEmailError = computed(() => {
    if (!this.submitted) {
      return '';
    }

    const value = this.createEmail().trim();

    if (value === '') {
      return 'Enter their work email';
    }
    if (!isCompanyEmail(value)) {
      return `Use their @${this.companyDomain} work email`;
    }

    return '';
  });

  protected readonly createPasswordError = computed(() => {
    if (!this.submitted) {
      return '';
    }

    const value = this.createPassword();

    if (value === '') {
      return 'Choose a password for them';
    }
    if (value.length < MIN_PASSWORD_LENGTH) {
      return `Use at least ${MIN_PASSWORD_LENGTH} characters`;
    }
    if (value.length > MAX_PASSWORD_LENGTH) {
      return `Use at most ${MAX_PASSWORD_LENGTH} characters`;
    }

    return '';
  });

  protected readonly newPasswordError = computed(() => {
    if (this.passwordTarget() === null) {
      return '';
    }

    const value = this.newPassword();

    if (value === '') {
      return 'Choose a password';
    }
    if (value.length < MIN_PASSWORD_LENGTH) {
      return `Use at least ${MIN_PASSWORD_LENGTH} characters`;
    }

    return '';
  });

  constructor() {
    // Waits for the role rather than asking straight away. Fetching in the
    // constructor asked before anybody knew who was looking, so an employee sent a
    // request the backend was always going to refuse — and had the refusal been
    // shown, the page would have read "Could not load the accounts" to somebody for
    // whom there was never an account list to load.
    effect(
      () => {
        if (this.auth.isAdmin() && !this.hasLoaded()) {
          this.hasLoaded.set(true);
          this.load(1);
        }
      },
      { injector: this.injectorRef },
    );
  }

  /** Whether the first fetch has been sent, so the effect above runs once. */
  private readonly hasLoaded = signal(false);

  private readonly injectorRef = inject(Injector);

  /** Fetches a page of accounts. */
  private load(page: number): void {
    this.isLoading.set(true);

    this.auth.listUsers(page).subscribe({
      next: (result) => {
        this.users.set(result.users);
        this.total.set(result.total);
        this.page.set(result.page);
        this.pages.set(result.pages);
        this.isLoading.set(false);
      },
      error: (error: unknown) => {
        this.isLoading.set(false);
        this.notice.set(readFailure(error, 'Could not load the accounts.'));
      },
    });
  }

  protected goToPage(page: number): void {
    if (page >= 1 && page <= this.pages()) {
      this.load(page);
    }
  }

  /** Creates the account and shows the password once. */
  protected createUser(): void {
    this.submitted = true;
    this.notice.set('');

    if (this.createNameError() || this.createEmailError() || this.createPasswordError()) {
      return;
    }

    this.isBusy.set(true);
    const email = this.createEmail().trim();
    const password = this.createPassword();

    this.auth.createAccount(this.createName().trim(), email, this.createRole(), password).subscribe({
      next: (user) => {
        this.isBusy.set(false);
        this.closeCreate();
        this.handedOver.set({
          heading: `${user.name} can sign in now`,
          email: user.email,
          password,
        });
        this.load(this.page());
      },
      error: (error: unknown) => {
        this.isBusy.set(false);
        this.notice.set(readFailure(error, 'The account could not be created.'));
      },
    });
  }

  private resetCreateForm(): void {
    this.createForm.reset({ name: '', email: '', password: '' });
    this.createName.set('');
    this.createEmail.set('');
    this.createPassword.set('');
    this.createRole.set('employee');
  }

  protected beginRoleChange(user: UserSummaryDto): void {
    this.chosenRole.set(user.role);
    this.roleTarget.set(user);
  }

  protected saveRole(): void {
    const target = this.roleTarget();

    if (target === null) {
      return;
    }

    this.isBusy.set(true);
    this.notice.set('');

    this.auth.updateUser(target.id, { role: this.chosenRole() }).subscribe({
      next: () => {
        this.isBusy.set(false);
        this.roleTarget.set(null);
        this.load(this.page());
      },
      error: (error: unknown) => {
        this.isBusy.set(false);
        this.notice.set(readFailure(error, 'The role could not be changed.'));
      },
    });
  }

  protected askResetPassword(user: UserSummaryDto): void {
    this.newPassword.set('');
    this.passwordTarget.set(user);
  }

  protected savePassword(): void {
    const target = this.passwordTarget();

    if (target === null || this.newPasswordError()) {
      return;
    }

    const password = this.newPassword();
    this.isBusy.set(true);
    this.notice.set('');

    this.auth.resetPassword(target.id, password).subscribe({
      next: () => {
        this.isBusy.set(false);
        this.passwordTarget.set(null);
        this.handedOver.set({
          heading: `${target.name}'s new password`,
          email: target.email,
          password,
        });
      },
      error: (error: unknown) => {
        this.isBusy.set(false);
        this.notice.set(readFailure(error, 'The password could not be changed.'));
      },
    });
  }

  protected askDelete(user: UserSummaryDto): void {
    this.pendingAction.set({ kind: 'delete', user });
  }

  /** Runs whatever the confirmation was opened for. */
  protected confirmPending(): void {
    const action = this.pendingAction();
    this.pendingAction.set(null);

    if (action === null) {
      return;
    }

    this.isBusy.set(true);
    this.notice.set('');

    if (action.kind === 'delete') {
      this.auth.deleteUser(action.user.id).subscribe({
        next: () => {
          this.isBusy.set(false);
          // Stepping back a page when the last row of the last page goes, so the
          // pager never points at a page that no longer exists.
          const remaining = this.users().length - 1;
          this.load(remaining === 0 && this.page() > 1 ? this.page() - 1 : this.page());
        },
        error: (error: unknown) => {
          this.isBusy.set(false);
          this.notice.set(readFailure(error, 'The account could not be deleted.'));
        },
      });

      return;
    }

    this.passwordTarget.set(action.user);
  }
}

/** The backend's own wording, so an administrator is told what actually happened. */
function readFailure(error: unknown, fallback: string): string {
  const status = (error as { status?: number } | null)?.status;

  if (status === 0) {
    return 'Could not reach the server. Please check your connection and try again.';
  }
  if (status === 409 || status === 422 || status === 400 || status === 403) {
    return readRefusalOr(error, GENERIC_REFUSAL);
  }

  return fallback;
}