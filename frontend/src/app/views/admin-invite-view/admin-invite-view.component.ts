import { isPlatformBrowser } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  PLATFORM_ID,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';

import {
  COMPANY_EMAIL_DOMAIN,
  MIN_PASSWORD_LENGTH,
  ROLE_LABELS,
  isCompanyEmail,
  type Role,
} from '../../core/models/auth.model';
import { AuthService } from '../../core/services/auth.service';
import { AdminAccessRequiredComponent } from '../../features/admin/components/admin-access-required/admin-access-required.component';
import { ViewHeaderComponent } from '../../features/chat/components/view-header/view-header.component';
import { ButtonComponent } from '../../shared/components/button/button.component';
import { FormFieldComponent } from '../../shared/components/form-field/form-field.component';
import { IconComponent } from '../../shared/components/icon/icon.component';

/**
 * Inviting somebody, and what happens when there is no way to send them a link.
 *
 * The honest answer, and the reason this screen exists: with no mail service there is
 * no automatic delivery, so an invitation cannot be dispatched from here. What the
 * backend does is mint a single-use link, and what this screen does is make handing
 * that link over a two-second job — one button produces it and one copies it.
 *
 * So the workflow is: the administrator fills in the form, copies the link, and sends
 * it by whatever means the company already uses. Chat, a phone call, a sticky note.
 * Nothing is queued and nothing is silently dropped, because there is no queue: the
 * link either leaves this screen in the administrator's hands or it does not, and an
 * unclaimed invitation simply expires after 72 hours and can be issued again.
 *
 * That is a worse experience than sending an email. It is not, however, an
 * unacknowledged one, which is what "the invitation was sent, we think" would be.
 */
@Component({
  selector: 'app-admin-invite-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AdminAccessRequiredComponent,
    ButtonComponent,
    FormFieldComponent,
    IconComponent,
    ReactiveFormsModule,
    ViewHeaderComponent,
  ],
  host: { class: 'flex min-h-0 flex-1 flex-col' },
  template: `
    <app-view-header title="Add a user" />

    @if (auth.isAdmin()) {
      <div class="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:px-8">
        <div class="mx-auto w-full max-w-2xl">
          <p class="text-sm text-muted-foreground">
            Create the account and hand over the credentials. Choose the role: an employee asks
            questions, an administrator also manages documents and people.
          </p>

          <form
            class="mt-6 flex flex-col gap-4 rounded-lg border border-border bg-card p-4 sm:p-5"
            [formGroup]="form"
            (ngSubmit)="onSubmit()"
          >
            <app-form-field
              label="Full name"
              [faintPlaceholder]="true"
              icon="user"
              autocomplete="name"
              placeholder="Ama Konadu"
              [required]="true"
              [value]="name()"
              [error]="nameError()"
              (valueChange)="onNameChange($event)"
            />

            <app-form-field
              label="Work email"
              [faintPlaceholder]="true"
              type="email"
              icon="mail"
              autocomplete="email"
              [placeholder]="'you@' + companyDomain"
              [required]="true"
              [value]="email()"
              [error]="emailError()"
              (valueChange)="onEmailChange($event)"
            />

            <app-form-field
              label="Password"
              type="password"
              icon="lock"
              autocomplete="new-password"
              placeholder="Something they can remember"
              [required]="true"
              [value]="password()"
              [error]="passwordError()"
              (valueChange)="onPasswordChange($event)"
            />

            <p class="-mt-2 text-xs text-muted-foreground">
              At least {{ minPasswordLength }} characters. They can change it by using the reset
              link an administrator issues.
            </p>

            <fieldset class="flex flex-col gap-1.5">
              <legend class="text-sm font-medium text-foreground">Role</legend>

              <div class="flex flex-col gap-2">
                @for (option of roleOptions; track option.value) {
                  <label
                    class="flex cursor-pointer items-start gap-2.5 rounded-md border border-border
                      px-3 py-2.5 text-sm transition-colors hover:border-primary/40"
                    [class.border-primary]="form.controls.role.value === option.value"
                  >
                    <input
                      type="radio"
                      class="mt-0.5 size-3.5 cursor-pointer accent-primary"
                      [value]="option.value"
                      [checked]="form.controls.role.value === option.value"
                      (change)="onRoleChange(option.value)"
                    />
                    <span class="flex flex-col gap-0.5">
                      <span class="font-medium text-foreground">{{ labels[option.value] }}</span>
                      <span class="text-xs text-muted-foreground">{{ option.detail }}</span>
                    </span>
                  </label>
                }
              </div>
            </fieldset>

            <button app-button type="submit" size="lg" [disabled]="isSubmitting()">
              @if (isSubmitting()) {
                <app-icon name="loader-2" [size]="16" class="animate-spin" />
                <span>Creating…</span>
              } @else {
                <app-icon name="user-plus" [size]="16" />
                <span>Create account</span>
              }
            </button>
          </form>

          @if (createdAccount(); as account) {
            <!--
              The credentials, shown once and only here.

              They cannot be shown again: the backend stores a hash, so this panel is
              the only place the plaintext exists outside the person who now owns it.
              That is why it says so, rather than leaving it looking like a receipt
              that can be fetched whenever.
            -->
            <div
              class="mt-6 flex flex-col gap-3 rounded-lg border border-success/30 bg-success/5
                p-4 sm:p-5"
            >
              <p class="flex items-start gap-2 text-sm font-medium text-success">
                <app-icon name="check-circle-2" [size]="16" class="mt-0.5 shrink-0" />
                <span>
                  {{ account.name }} can sign in now. Send them these, then close this page.
                </span>
              </p>

              <dl class="flex flex-col gap-2">
                <div class="flex items-center gap-3 rounded-md border border-border bg-card px-3 py-2">
                  <dt class="w-16 shrink-0 text-xs text-muted-foreground">Email</dt>
                  <dd class="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
                    {{ account.email }}
                  </dd>
                </div>

                <div class="flex items-center gap-3 rounded-md border border-border bg-card px-3 py-2">
                  <dt class="w-16 shrink-0 text-xs text-muted-foreground">Password</dt>
                  <dd class="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
                    {{ account.password }}
                  </dd>
                </div>
              </dl>

              <div class="flex flex-wrap items-center gap-2">
                <button app-button size="sm" variant="outline" (click)="copyCredentials()">
                  <app-icon name="copy" [size]="15" />
                  <span>{{ didCopy() ? 'Copied' : 'Copy both' }}</span>
                </button>

                <button
                  app-button
                  size="sm"
                  variant="ghost"
                  (click)="startAnother()"
                >
                  Add someone else
                </button>
              </div>

              <p class="text-xs text-muted-foreground">
                This is the only time the password is shown — the backend keeps only a hash of it.
                Copy it now rather than reading it out over a desk.
              </p>
            </div>
          }

          @if (notice()) {
            <p
              class="mt-4 flex items-start gap-2 rounded-md bg-muted px-3 py-2 text-xs
                text-muted-foreground"
            >
              <app-icon name="info" [size]="14" class="mt-0.5 shrink-0" />
              <span>{{ notice() }}</span>
            </p>
          }
        </div>
      </div>
    } @else {
      <app-admin-access-required />
    }
  `,
})
export class AdminInviteViewComponent {
  private readonly auth = inject(AuthService);
  private readonly formBuilder = inject(FormBuilder);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  protected readonly companyDomain = COMPANY_EMAIL_DOMAIN;
  protected readonly labels = ROLE_LABELS;

  /** The backend's own minimum, so the field says it before the round trip. */
  protected readonly minPasswordLength = MIN_PASSWORD_LENGTH;

  /**
   * The two roles, described rather than just named.
   *
   * "Administrator" is a large thing to hand out, so it says what it is. Choosing it
   * here is the only place in the product that creates one.
   */
  protected readonly roleOptions: { value: Role; detail: string }[] = [
    { value: 'employee', detail: 'Can ask questions and read their own conversations.' },
    {
      value: 'admin',
      detail: 'Can also add people and manage the documents the assistant answers from.',
    },
  ];

  protected readonly form = this.formBuilder.nonNullable.group({
    name: ['', [Validators.required, Validators.maxLength(120)]],
    email: ['', [Validators.required, Validators.email]],
    password: ['', [Validators.required]],
    role: ['employee' as Role, [Validators.required]],
  });

  protected readonly name = signal('');
  protected readonly email = signal('');
  protected readonly password = signal('');

  private readonly submitted = signal(false);
  protected readonly isSubmitting = signal(false);

  /**
   * The credentials just handed over, held so the panel can show them.
   *
   * The only copy of the password that will ever exist outside the person it belongs
   * to: the backend keeps a hash. Cleared as soon as the administrator starts on
   * somebody else, so it does not sit in a tab being read over a shoulder.
   */
  protected readonly createdAccount = signal<{ name: string; email: string; password: string } | null>(
    null,
  );

  /** Whether the last copy attempt reported success. */
  protected readonly didCopy = signal(false);

  protected readonly notice = signal('');

  protected readonly nameError = computed(() =>
    this.submitted() && this.name().trim() === '' ? 'Enter their full name' : '',
  );

  protected readonly emailError = computed(() => {
    if (!this.submitted()) {
      return '';
    }

    const value = this.email().trim();

    if (value === '') {
      return 'Enter their work email';
    }
    if (this.form.controls.email.hasError('email')) {
      return 'That does not look like an email address';
    }

    return isCompanyEmail(value) ? '' : `Use their @${this.companyDomain} work email`;
  });

  protected onNameChange(value: string): void {
    this.name.set(value);
    this.form.controls.name.setValue(value);
  }

  protected onEmailChange(value: string): void {
    this.email.set(value);
    this.form.controls.email.setValue(value);
  }

  protected onPasswordChange(value: string): void {
    this.password.set(value);
    this.form.controls.password.setValue(value);
  }

  /**
   * The password, checked against the backend's policy before it is sent.
   *
   * The server runs the same rule and is the authority, but a person choosing a
   * password for somebody else should be told it is too short as they type, not after
   * a round trip — and the message has to be the policy, not a bare length error.
   */
  protected readonly passwordError = computed(() => {
    if (!this.submitted()) {
      return '';
    }

    const value = this.password();

    if (value === '') {
      return 'Choose a password for them';
    }

    return value.length >= MIN_PASSWORD_LENGTH ? '' : `Use at least ${MIN_PASSWORD_LENGTH} characters`;
  });

  protected onRoleChange(value: Role): void {
    this.form.controls.role.setValue(value);
  }

  protected onSubmit(): void {
    this.submitted.set(true);
    this.notice.set('');
    this.createdAccount.set(null);
    this.didCopy.set(false);

    if (this.nameError() || this.emailError() || this.passwordError() || this.form.invalid) {
      return;
    }

    this.isSubmitting.set(true);

    const { name, email, password, role } = this.form.getRawValue();

    this.auth.createAccount(name, email, role, password).subscribe({
      next: (user) => {
        this.isSubmitting.set(false);
        this.createdAccount.set({
          name: user.name,
          email: user.email,
          // Read back off the form rather than off the response: the backend never
          // sends the password back, and echoing what was typed is the only copy
          // that can be handed over.
          password,
        });
      },
      error: (error: unknown) => {
        this.isSubmitting.set(false);
        this.notice.set(readInviteFailure(error));
      },
    });
  }

  /** Empties the form for the next person, and forgets the last password. */
  protected startAnother(): void {
    this.form.reset({ name: '', email: '', password: '', role: 'employee' });
    this.name.set('');
    this.email.set('');
    this.password.set('');
    this.submitted.set(false);
    this.createdAccount.set(null);
    this.notice.set('');
    this.didCopy.set(false);
  }

  /**
   * Copies the link.
   *
   * Reported rather than assumed, in both directions. A clipboard write the browser
   * refused otherwise looks exactly like one that worked, and the administrator
   * would send a link they never actually captured.
   *
   * The API is checked for rather than assumed present: `navigator.clipboard` only
   * exists in a secure context, so it is missing on any page served over plain http
   * to anything other than localhost. Optional chaining alone would not cover that —
   * it guards the call and then chains `.then` onto the resulting `undefined`.
   */
  protected copyCredentials(): void {
    const account = this.createdAccount();
    const clipboard = this.isBrowser ? navigator.clipboard : undefined;

    if (!account) {
      return;
    }

    if (!clipboard?.writeText) {
      this.didCopy.set(false);
      this.notice.set('Could not copy automatically. Select the credentials and copy them.');

      return;
    }

    // Both halves in one write, so the person receiving it cannot end up with the
    // email from one copy and the password from another.
    void clipboard
      .writeText(`${account.email}\n${account.password}`)
      .then(() => this.didCopy.set(true))
      .catch(() => {
        this.didCopy.set(false);
        this.notice.set('Could not copy automatically. Select the credentials and copy them.');
      });
  }
}

/** What to say when an invitation is refused. */
function readInviteFailure(error: unknown): string {
  const status = (error as { status?: number } | null)?.status;
  const detail = (error as { error?: { detail?: string } } | null)?.error?.detail;

  if (status === 409 && typeof detail === 'string') {
    // Usually that somebody already accepted an earlier invitation. The address is
    // reserved from the moment one is issued, so this is the one case an
    // administrator needs the reason spelled out.
    return detail;
  }
  if (status === 429) {
    return 'Too many attempts. Please wait a moment and try again.';
  }
  if (status === 422) {
    return 'That email address is not one this workspace accepts.';
  }
  if (status === 0) {
    return 'Could not reach the server. Please check your connection and try again.';
  }

  return 'The account could not be created. Please try again.';
}
