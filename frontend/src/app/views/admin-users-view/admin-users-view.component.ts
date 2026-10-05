import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  Injector,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { Observable } from 'rxjs';

import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  COMPANY_EMAIL_DOMAIN,
  isCompanyEmail,
} from '../../core/models/auth.model';
import type { Role } from '../../core/models/auth.model';
import type {
  AccessRequestDecisionDto,
  AccessRequestRowDto,
  AccessRequestStatus,
} from '../../core/models/access-request.model';
import { AuthService } from '../../core/services/auth.service';
import { AdminAccessRequiredComponent } from '../../features/admin/components/admin-access-required/admin-access-required.component';
import { ViewHeaderComponent } from '../../features/chat/components/view-header/view-header.component';
import { BadgeComponent, type BadgeTone } from '../../shared/components/badge/badge.component';
import { ButtonComponent } from '../../shared/components/button/button.component';
import { FormFieldComponent } from '../../shared/components/form-field/form-field.component';
import { InputComponent } from '../../shared/components/input/input.component';
import { IconComponent } from '../../shared/components/icon/icon.component';
import { ModalComponent } from '../../shared/components/modal/modal.component';
import { GENERIC_REFUSAL, readRefusalOr } from '../../features/auth/utils/read-backend-refusal';
import { toInitials } from '../../shared/utils/initials.util';

/** Colour per status, so a waiting request reads differently from a decided one. */
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

/** One secret the administrator has just produced and has to hand over. */
interface HandedOver {
  heading: string;
  message: string;
  email: string;
  secret: string;
  secretLabel: string;
}

/**
 * People management, built only from endpoints the backend has.
 *
 * There is no accounts list endpoint, so this screen does not pretend to show
 * one: what it shows is everybody who has asked for access (the queue), plus
 * the two ways an administrator brings somebody in — creating the account
 * outright, and inviting them to set their own password. Approving and declining
 * happen here as well as on the queue screen, because the person and the
 * decision about them belong together.
 *
 * Role changes, password resets and deletions have no endpoint behind them, so
 * they are not on this screen. A button that called a missing endpoint would be
 * decoration that fails.
 */
@Component({
  selector: 'app-admin-users-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AdminAccessRequiredComponent,
    BadgeComponent,
    ButtonComponent,
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

              <button app-button type="button" variant="outline" size="sm" (click)="openInvite()">
                <app-icon name="send-horizontal" [size]="14" />
                <span>Invite by link</span>
              </button>
            </div>

            <div class="w-full sm:max-w-xs">
              <app-input
                [value]="search()"
                (valueChange)="search.set($event)"
                placeholder="Search people"
                ariaLabel="Search by name or email"
              />
            </div>
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
              <p class="px-4 py-8 text-center text-sm text-muted-foreground">Loading people…</p>
            } @else if (visibleRows().length === 0) {
              <div class="px-4 py-12 text-center">
                <p class="text-sm font-medium text-foreground">
                  {{ rows().length === 0 ? 'Nobody has asked for access yet' : 'Nobody matches that search' }}
                </p>
                <p class="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
                  {{
                    rows().length === 0
                      ? 'Add somebody above, or wait for somebody to request access.'
                      : 'Try a different name or email.'
                  }}
                </p>
              </div>
            } @else {
              @for (row of visibleRows(); track row.id) {
                <div
                  class="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3
                    last:border-b-0"
                >
                  <span
                    class="flex size-9 shrink-0 items-center justify-center rounded-full
                      bg-muted text-xs font-semibold text-muted-foreground"
                  >
                    {{ initials(row.name) }}
                  </span>

                  <div class="min-w-0 flex-1">
                    <p class="truncate text-sm font-medium text-foreground">{{ row.name }}</p>
                    <p class="truncate text-xs text-muted-foreground">{{ row.email }}</p>
                  </div>

                  <app-badge [tone]="tones[row.status]">{{ labels[row.status] }}</app-badge>

                  @if (row.status === 'pending') {
                    <div class="flex shrink-0 items-center gap-1">
                      <button
                        app-button
                        type="button"
                        variant="ghost"
                        size="sm"
                        [disabled]="isDeciding(row.id)"
                        (click)="approve(row)"
                      >
                        <app-icon name="check" [size]="14" />
                        <span class="hidden sm:inline">Approve</span>
                      </button>

                      <button
                        app-button
                        type="button"
                        variant="ghost"
                        size="sm"
                        [disabled]="isDeciding(row.id)"
                        (click)="approve(row, 'admin')"
                      >
                        <app-icon name="shield" [size]="14" />
                        <span class="hidden sm:inline">Make admin</span>
                      </button>

                      <button
                        app-button
                        type="button"
                        variant="ghost"
                        size="sm"
                        class="text-danger hover:bg-danger/10"
                        [disabled]="isDeciding(row.id)"
                        (click)="decline(row)"
                      >
                        Decline
                      </button>
                    </div>
                  }
                </div>
              }
            }
          </div>
        }
      </div>
    </div>

    <!-- Adding somebody outright, with a password chosen here. -->
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

    <!-- Inviting somebody to set their own password, via a link. -->
    <app-modal
      [(isOpen)]="isInviting"
      title="Invite by link"
      message="They set their own password, so you never learn it. There is no mail service, so copy the link and send it yourself."
      icon="send-horizontal"
      (closed)="closeInvite()"
    >
      <form class="flex flex-col gap-4" [formGroup]="inviteForm" (ngSubmit)="sendInvite()">
        <app-form-field
          label="Full name"
          [faintPlaceholder]="true"
          icon="user"
          autocomplete="off"
          placeholder="Ama Konadu"
          [required]="true"
          [(value)]="inviteName"
          [error]="inviteNameError()"
        />

        <app-form-field
          label="Work email"
          [faintPlaceholder]="true"
          type="email"
          icon="mail"
          autocomplete="off"
          [placeholder]="'you@' + companyDomain"
          [required]="true"
          [(value)]="inviteEmail"
          [error]="inviteEmailError()"
        />

        <fieldset class="flex flex-col gap-2">
          <legend class="text-sm font-medium text-foreground">Role</legend>
          <div class="flex flex-col gap-2">
            @for (option of roleOptions; track option.value) {
              <label
                class="flex cursor-pointer items-start gap-2.5 rounded-md border border-border
                  px-3 py-2.5 text-sm transition-colors hover:border-primary/40"
                [class.border-primary]="inviteRole() === option.value"
              >
                <input
                  type="radio"
                  name="inviteRole"
                  class="mt-0.5 size-3.5 cursor-pointer accent-primary"
                  [value]="option.value"
                  [checked]="inviteRole() === option.value"
                  (change)="inviteRole.set(option.value)"
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
        <button app-button type="button" variant="ghost" (click)="closeInvite()">
          Go back
        </button>
        <button app-button type="button" [disabled]="isBusy()" (click)="sendInvite()">
          {{ isBusy() ? 'Inviting…' : 'Create invite link' }}
        </button>
      </div>
    </app-modal>

    <!-- The secret just produced, shown once. -->
    <app-modal
      [isOpen]="handedOver() !== null"
      [title]="handedOver()?.heading ?? ''"
      [message]="handedOver()?.message ?? ''"
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
            <dt class="w-20 shrink-0 text-xs text-muted-foreground">{{ details.secretLabel }}</dt>
            <dd class="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
              {{ details.secret }}
            </dd>
          </div>
        </dl>
      }
    </app-modal>
  `,
})
export class AdminUsersViewComponent {
  protected readonly auth = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly formBuilder = inject(FormBuilder);

  protected readonly companyDomain = COMPANY_EMAIL_DOMAIN;
  protected readonly minPasswordLength = MIN_PASSWORD_LENGTH;
  protected readonly tones = STATUS_TONES;
  protected readonly labels = STATUS_LABELS;

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

  /** Everybody who has asked for access, pending first. */
  protected readonly rows = signal<AccessRequestRowDto[]>([]);
  protected readonly isLoading = signal(true);
  protected readonly isBusy = signal(false);
  protected readonly notice = signal('');
  protected readonly search = signal('');

  /** Ids with a decision in flight, so one row cannot be answered twice. */
  private readonly deciding = signal<string[]>([]);

  /** The secret just produced, shown once so it can be copied. */
  protected readonly handedOver = signal<HandedOver | null>(null);

  protected readonly visibleRows = computed(() => {
    const term = this.search().trim().toLowerCase();

    if (term === '') {
      return this.rows();
    }

    return this.rows().filter(
      (row) => row.name.toLowerCase().includes(term) || row.email.toLowerCase().includes(term),
    );
  });

  protected readonly isCreating = signal(false);
  protected readonly isInviting = signal(false);

  protected readonly createName = signal('');
  protected readonly createEmail = signal('');
  protected readonly createPassword = signal('');
  protected readonly createRole = signal<Role>('employee');

  protected readonly inviteName = signal('');
  protected readonly inviteEmail = signal('');
  protected readonly inviteRole = signal<Role>('employee');

  protected readonly createForm = this.formBuilder.nonNullable.group({
    name: ['', [Validators.required, Validators.maxLength(120)]],
    email: ['', [Validators.required, Validators.email]],
    password: [
      '',
      [Validators.required, Validators.minLength(MIN_PASSWORD_LENGTH), Validators.maxLength(MAX_PASSWORD_LENGTH)],
    ],
  });

  protected readonly inviteForm = this.formBuilder.nonNullable.group({
    name: ['', [Validators.required, Validators.maxLength(120)]],
    email: ['', [Validators.required, Validators.email]],
  });

  private submittedCreate = false;
  private submittedInvite = false;

  protected readonly createNameError = computed(() =>
    this.submittedCreate && this.createName().trim() === '' ? 'Enter their full name' : '',
  );

  protected readonly createEmailError = computed(() =>
    this.emailError(this.submittedCreate, this.createEmail()),
  );

  protected readonly createPasswordError = computed(() => {
    if (!this.submittedCreate) {
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

  protected readonly inviteNameError = computed(() =>
    this.submittedInvite && this.inviteName().trim() === '' ? 'Enter their full name' : '',
  );

  protected readonly inviteEmailError = computed(() =>
    this.emailError(this.submittedInvite, this.inviteEmail()),
  );

  private emailError(submitted: boolean, raw: string): string {
    if (!submitted) {
      return '';
    }

    const value = raw.trim();

    if (value === '') {
      return 'Enter their work email';
    }
    if (!isCompanyEmail(value)) {
      return `Use their @${this.companyDomain} work email`;
    }

    return '';
  }

  constructor() {
    // Waits for the role rather than asking straight away. The session is still
    // settling when this is built, so asking in the constructor would ask before
    // anybody knew who was looking.
    effect(
      () => {
        if (this.auth.isAdmin() && !this.hasLoaded()) {
          this.hasLoaded.set(true);
          this.reload();
        }
      },
      { injector: this.injectorRef },
    );
  }

  /** Whether the first fetch has been sent, so the effect above runs once. */
  private readonly hasLoaded = signal(false);

  private readonly injectorRef = inject(Injector);

  /** Re-reads the queue. */
  protected reload(): void {
    this.isLoading.set(true);
    this.notice.set('');

    this.auth
      .listAccessRequests()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          this.rows.set(response.requests);
          this.isLoading.set(false);
        },
        error: (error: unknown) => {
          this.isLoading.set(false);
          this.notice.set(readFailure(error, 'Could not load the people.'));
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

  private decide(
    row: AccessRequestRowDto,
    action: () => Observable<AccessRequestDecisionDto>,
  ): void {
    this.deciding.update((ids) => [...ids, row.id]);
    this.notice.set('');

    action()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (decision) => {
          this.deciding.update((ids) => ids.filter((id) => id !== row.id));
          this.rows.update((rows) =>
            rows.map((candidate) => (candidate.id === row.id ? decision.request : candidate)),
          );

          if (decision.invite_link) {
            this.handedOver.set({
              heading: `${row.name} was approved`,
              message: 'Send this link so they can set a password. It works once.',
              email: row.email,
              secret: decision.invite_link,
              secretLabel: 'Invite link',
            });
          }
        },
        error: (error: unknown) => {
          this.deciding.update((ids) => ids.filter((id) => id !== row.id));
          this.notice.set(readFailure(error, 'That decision could not be recorded.'));
        },
      });
  }

  /** Opens the create dialog with an empty form. */
  protected openCreate(): void {
    this.submittedCreate = false;
    this.resetCreateForm();
    this.isCreating.set(true);
  }

  /** Closes it, discarding anything half filled in. */
  protected closeCreate(): void {
    this.isCreating.set(false);
    this.submittedCreate = false;
    this.resetCreateForm();
  }

  /** Creates the account and shows the password once. */
  protected createUser(): void {
    this.submittedCreate = true;
    this.notice.set('');

    if (this.createNameError() || this.createEmailError() || this.createPasswordError()) {
      return;
    }

    this.isBusy.set(true);
    const email = this.createEmail().trim();
    const password = this.createPassword();

    this.auth
      .createAccount(this.createName().trim(), email, this.createRole(), password)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (user) => {
          this.isBusy.set(false);
          this.closeCreate();
          this.handedOver.set({
            heading: `${user.name} can sign in now`,
            message: 'This is the only time the password is shown. Copy it now.',
            email: user.email,
            secret: password,
            secretLabel: 'Password',
          });
          this.reload();
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

  /** Opens the invite dialog with an empty form. */
  protected openInvite(): void {
    this.submittedInvite = false;
    this.resetInviteForm();
    this.isInviting.set(true);
  }

  /** Closes it, discarding anything half filled in. */
  protected closeInvite(): void {
    this.isInviting.set(false);
    this.submittedInvite = false;
    this.resetInviteForm();
  }

  /** Mints the invitation and shows the link once. */
  protected sendInvite(): void {
    this.submittedInvite = true;
    this.notice.set('');

    if (this.inviteNameError() || this.inviteEmailError()) {
      return;
    }

    this.isBusy.set(true);
    const email = this.inviteEmail().trim();

    this.auth
      .invite(this.inviteName().trim(), email, this.inviteRole())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (response) => {
          this.isBusy.set(false);
          this.closeInvite();
          this.handedOver.set({
            heading: `Invite ready for ${response.user.name}`,
            message: 'Send this link so they can set a password. It works once.',
            email: response.user.email,
            secret: response.invite_link,
            secretLabel: 'Invite link',
          });
          this.reload();
        },
        error: (error: unknown) => {
          this.isBusy.set(false);
          this.notice.set(readFailure(error, 'The invitation could not be created.'));
        },
      });
  }

  private resetInviteForm(): void {
    this.inviteForm.reset({ name: '', email: '' });
    this.inviteName.set('');
    this.inviteEmail.set('');
    this.inviteRole.set('employee');
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
