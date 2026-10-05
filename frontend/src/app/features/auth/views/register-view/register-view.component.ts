import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { ButtonComponent } from '../../../../shared/components/button/button.component';
import { FormFieldComponent } from '../../../../shared/components/form-field/form-field.component';
import { IconComponent } from '../../../../shared/components/icon/icon.component';
import { COMPANY_EMAIL_DOMAIN, MIN_PASSWORD_LENGTH, isCompanyEmail } from '../../../../core/models/auth.model';
import { AuthService } from '../../../../core/services/auth.service';
import { AuthLayoutComponent } from '../../components/auth-layout/auth-layout.component';

/** One rule a new password has to satisfy. */
interface PasswordRule {
  label: string;
  met: boolean;
}

/**
 * Registering for an account.
 *
 * This creates a request that an administrator reads; it does not create an
 * account, and it cannot. Nothing here is signed in, nothing gets a role, and
 * nothing works until somebody approves it — at which point the password chosen
 * here becomes the account's password and signing in just works.
 *
 * The shape it replaces asked for no password and sent the person off to set one
 * through an invitation link after approval. Choosing it up front removes that
 * second step, which is the thing people tripped on: a link that expires before
 * it is opened reads as a broken product rather than as a queue still working.
 */
@Component({
  selector: 'app-register-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AuthLayoutComponent,
    ButtonComponent,
    FormFieldComponent,
    IconComponent,
    ReactiveFormsModule,
    RouterLink,
  ],
  template: `
    <app-auth-layout>
      <h1 class="text-center font-headings text-xl font-semibold text-foreground">
        Request access
      </h1>
      <p class="mt-1 text-center text-sm text-muted-foreground">
        Choose a password now — you will sign in with it as soon as an administrator
        approves your request.
      </p>

      @if (isSent()) {
        <div class="mt-6 flex flex-col items-center gap-4 text-center">
          <p
            class="flex items-start gap-2 rounded-md bg-success/10 px-3 py-2 text-xs
              text-success"
          >
            <app-icon name="check-circle-2" [size]="14" class="mt-0.5 shrink-0" />
            <span class="text-left">
              Thanks — your request is with an administrator now. Sign in with your new
              password once they approve it.
            </span>
          </p>

          <a routerLink="/login" class="text-sm font-medium text-primary hover:underline">
            Back to sign in
          </a>
        </div>
      } @else {
        <form class="mt-6 flex flex-col gap-4" [formGroup]="form" (ngSubmit)="onSubmit()">
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

          <div>
            <app-form-field
              label="Password"
              [faintPlaceholder]="true"
              type="password"
              icon="lock"
              autocomplete="new-password"
              placeholder="Choose a password"
              [required]="true"
              [value]="password()"
              [error]="passwordError()"
              (valueChange)="onPasswordChange($event)"
            />

            <ul class="mt-3 flex flex-col gap-1.5">
              @for (rule of rules(); track rule.label) {
                <li class="flex items-center gap-2 text-xs" [class]="ruleClasses(rule.met)">
                  <app-icon [name]="rule.met ? 'check-circle-2' : 'clock'" [size]="14" />
                  <span>{{ rule.label }}</span>
                </li>
              }
            </ul>
          </div>

          <app-form-field
            label="Confirm password"
            [faintPlaceholder]="true"
            type="password"
            icon="lock"
            autocomplete="new-password"
            placeholder="Type it again"
            [required]="true"
            [value]="confirmation()"
            [error]="confirmationError()"
            (valueChange)="onConfirmationChange($event)"
          />

          <button app-button type="submit" size="lg" [fullWidth]="true" [disabled]="isSubmitting()">
            @if (isSubmitting()) {
              <app-icon name="loader-2" [size]="16" class="animate-spin" />
              <span>Sending…</span>
            } @else {
              <span>Request access</span>
            }
          </button>
        </form>

        @if (notice()) {
          <p
            class="mt-4 flex items-start gap-2 rounded-md bg-danger/10 px-3 py-2 text-xs
              text-danger"
            role="alert"
            >
            <app-icon name="alert-triangle" [size]="14" class="mt-0.5 shrink-0" />
            <span>{{ notice() }}</span>
          </p>
        }

        <p class="mt-6 border-t border-border pt-4 text-center text-sm text-muted-foreground">
          Already have an account?
          <a routerLink="/login" class="font-medium text-primary hover:underline">Sign in</a>
        </p>
      }
    </app-auth-layout>
  `,
})
export class RegisterViewComponent {
  private readonly auth = inject(AuthService);
  private readonly formBuilder = inject(FormBuilder);

  /** The domain the field asks for, read from the one place it is written. */
  protected readonly companyDomain = COMPANY_EMAIL_DOMAIN;

  /**
   * The form.
   *
   * Name, address and a password with confirmation. The password validator
   * restates the length floor of the server's policy so the reader finds out
   * before the round trip; the server runs it and is what decides.
   *
   * The address carries a domain check here because the field should say so before
   * the round trip. It is a convenience — the server runs the same rule and is what
   * decides.
   */
  protected readonly form = this.formBuilder.nonNullable.group({
    name: ['', [Validators.required, Validators.maxLength(120)]],
    email: ['', [Validators.required, Validators.email]],
    password: ['', [Validators.required, Validators.minLength(MIN_PASSWORD_LENGTH)]],
    confirmation: ['', [Validators.required]],
  });

  /** Full name as typed. */
  protected readonly name = signal('');

  /** Work email as typed. */
  protected readonly email = signal('');

  /** Chosen password. */
  protected readonly password = signal('');

  /** Repeated password. */
  protected readonly confirmation = signal('');

  /** Whether the form has been sent, which is when fields start complaining. */
  private readonly submitted = signal(false);

  /** Whether the request is in flight. */
  protected readonly isSubmitting = signal(false);

  /** Whether the request has been accepted by the backend. */
  protected readonly isSent = signal(false);

  /** Explanatory message shown after an attempt. */
  protected readonly notice = signal('');

  /** The rules the new password has to satisfy, and whether each is met. */
  protected readonly rules = computed<PasswordRule[]>(() => {
    const value = this.password();

    return [
      {
        label: `At least ${MIN_PASSWORD_LENGTH} characters`,
        met: value.length >= MIN_PASSWORD_LENGTH,
      },
    ];
  });

  /** Whether every password rule is satisfied. */
  private readonly isPasswordValid = computed(() => this.rules().every((rule) => rule.met));

  /** Name error, once the form has been sent. */
  protected readonly nameError = computed(() =>
    this.submitted() && this.name().trim() === '' ? 'Enter your full name' : '',
  );

  /** Email error, once the form has been sent. */
  protected readonly emailError = computed(() => {
    if (!this.submitted()) {
      return '';
    }

    const value = this.email().trim();

    if (value === '') {
      return 'Enter your work email';
    }
    if (this.form.controls.email.hasError('email')) {
      return 'That does not look like an email address';
    }
    // Worth saying before the round trip, because a personal address is the likeliest
    // mistake here and the server would refuse it anyway.
    if (!isCompanyEmail(value)) {
      return `Use your @${this.companyDomain} work email`;
    }

    return '';
  });

  /** Password error, once the form has been sent. */
  protected readonly passwordError = computed(() => {
    if (!this.submitted()) {
      return '';
    }
    if (this.password() === '') {
      return 'Choose a password';
    }

    return this.isPasswordValid() ? '' : 'Choose a password that satisfies every rule below';
  });

  /** Mismatch error, once the form has been sent. */
  protected readonly confirmationError = computed(() => {
    if (!this.submitted()) {
      return '';
    }
    if (this.confirmation() === '') {
      return 'Type your password again';
    }

    return this.confirmation() === this.password() ? '' : 'Passwords do not match';
  });

  /** Colour of a rule line: met rules pick up the brand, unmet ones stay muted. */
  protected ruleClasses(met: boolean): string {
    return met ? 'text-primary' : 'text-muted-foreground';
  }

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

  protected onConfirmationChange(value: string): void {
    this.confirmation.set(value);
    this.form.controls.confirmation.setValue(value);
  }

  protected onSubmit(): void {
    this.submitted.set(true);
    this.notice.set('');

    if (this.nameError() || this.emailError() || this.passwordError() || this.confirmationError() || this.form.invalid) {
      return;
    }

    this.isSubmitting.set(true);

    this.auth
      .requestAccess(
        this.form.controls.name.value,
        this.form.controls.email.value,
        this.form.controls.password.value,
      )
      .subscribe({
        next: () => {
          this.isSubmitting.set(false);
          this.isSent.set(true);
        },
        error: (error: unknown) => {
          this.isSubmitting.set(false);
          this.notice.set(readRequestFailure(error));
        },
      });
  }
}

/**
 * What to say when a request is refused.
 *
 * The two 409s are the useful ones and both come from the backend rather than from
 * here: there is already an account at that address, or a request is already
 * waiting. Both are things the reader can act on, so they are passed on rather than
 * replaced with a generic failure.
 */
function readRequestFailure(error: unknown): string {
  const status = (error as { status?: number } | null)?.status;
  const detail = (error as { error?: { detail?: string } } | null)?.error?.detail;

  if (status === 409 && typeof detail === 'string') {
    return detail;
  }
  if (status === 429) {
    return 'Too many attempts. Please wait a moment and try again.';
  }
  if (status === 422 && typeof detail === 'string') {
    return detail;
  }
  if (status === 422) {
    return 'That email address is not one this workspace accepts.';
  }
  if (status === 0) {
    return 'Could not reach the server. Please check your connection and try again.';
  }

  return 'Your request could not be sent. Please try again.';
}
