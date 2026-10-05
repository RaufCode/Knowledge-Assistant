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

/** One credential the administrator has just chosen and has to hand over. */
interface HandedOver {
  heading: string;
  email: string;
  password: string;
}

/**
 * Everybody who has an account, and what an administrator can do about it.
 *
 * The list is the accounts the backend pages out, ten at a time. Three things
 * can be done to an account: change its role (making somebody an administrator
 * after approval happens here, with the same control, rather than only in the
 * queue), set a new password for somebody locked out, and delete it so it
 * cannot access anything anymore. Each destructive one is behind a
 * confirmation, and acting on your own account the fatal ways is refused —
 * every one of those ends with nobody able to administer the system.
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
      <div class="flex min-w-0 flex-1 flex-col">
        @if (!auth.isAdmin()) {
          <app-admin-access-required />
        } @else {
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
            @if (isLoading() && users().length === 0) {
              <p class="px-4 py-8 text-center text-sm text-muted-foreground">Loading accounts…</p>
            } @else if (visibleUsers().length === 0) {
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

    <!-- Adding somebody, as a dialog rather than a form on the page. -->
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

    <!-- A new password for somebody locked out. -->
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
        This signs them out everywhere, so anybody holding an old session is signed out too.
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
      [isOpen]="deleteTarget() !== null"
      tone="danger"
      icon="trash-2"
      title="Delete this account?"
      [message]="deleteMessage()"
      confirmLabel="Delete"
      (confirmed)="deleteUser()"
      (cancelled)="deleteTarget.set(null)"
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
  protected readonly perPage = signal(10);
  protected readonly isLoading = signal(false);
  protected readonly isBusy = signal(false);
  protected readonly notice = signal('');
  protected readonly search = signal('');

  /** Page count, derived here so a delete updates it without refetching. */
  protected readonly pages = computed(() =>
    Math.max(1, Math.ceil(this.total() / this.perPage())),
  );

  /**
   * The accounts on this page matching the search.
   *
   * A client-side filter over one page, and it says so: the backend pages ten at
   * a time, so this sees ten accounts and not the directory.
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

  protected readonly searchScope = computed(() => {
    const term = this.search().trim();

    if (term === '') {
      return '';
    }

    const onPage = this.users().length;

    return onPage === 0
      ? `Nobody on this page matches "${term}".`
      : `${this.visibleUsers().length} of ${onPage} on this page match "${term}".`;
  });

  /** Whether the add-user dialog is showing. */
  protected readonly isCreating = signal(false);

  protected openCreate(): void {
    this.submitted = false;
    this.resetCreateForm();
    this.isCreating.set(true);
  }

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

  /** The account a delete is waiting on confirmation for. */
  protected readonly deleteTarget = signal<UserSummaryDto | null>(null);

  protected readonly deleteMessage = computed(() => {
    const target = this.deleteTarget();

    return target
      ? `${target.name} loses access immediately, along with every conversation they have. This cannot be undone.`
      : '';
  });

  /** The credentials just chosen, to hand over. */
  protected readonly handedOver = signal<HandedOver | null>(null);

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

  /** Whether the first fetch has been sent, so the effect below runs once. */
  private readonly hasLoaded = signal(false);

  private readonly injectorRef = inject(Injector);

  constructor() {
    // Waits for the role rather than asking straight away: fetching before anybody
    // knows who is looking sends a request the backend was always going to refuse.
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

  /** Fetches a page of accounts. */
  private load(page: number): void {
    this.isLoading.set(true);

    this.auth.listUsers(page).subscribe({
      next: (result) => {
        this.users.set(result.users);
        this.total.set(result.total);
        this.page.set(result.page);
        this.perPage.set(result.per_page);
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
      next: (updated) => {
        this.isBusy.set(false);
        this.roleTarget.set(null);
        // Written onto the row in place: the server answered with the corrected
        // account, so there is nothing a refetch could add and the rest of the
        // page never flickers.
        this.users.update((rows) =>
          rows.map((user) => (user.id === target.id ? updated : user)),
        );
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
    this.deleteTarget.set(user);
  }

  /** Deletes the confirmed account, lifting its row out without touching the rest. */
  protected deleteUser(): void {
    const target = this.deleteTarget();
    this.deleteTarget.set(null);

    if (target === null) {
      return;
    }

    this.isBusy.set(true);
    this.notice.set('');

    this.auth.deleteUser(target.id).subscribe({
      next: () => {
        this.isBusy.set(false);
        this.users.update((rows) => rows.filter((user) => user.id !== target.id));
        this.total.update((total) => Math.max(0, total - 1));

        // The page emptied out from under the pager: step back to the previous
        // one, which is the only case that still needs the server. Anything
        // else stays exactly as it was.
        if (this.users().length === 0 && this.page() > 1) {
          this.load(this.page() - 1);
        }
      },
      error: (error: unknown) => {
        this.isBusy.set(false);
        this.notice.set(readFailure(error, 'The account could not be deleted.'));
      },
    });
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
