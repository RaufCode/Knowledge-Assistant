import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { ButtonComponent } from '../../../../shared/components/button/button.component';
import { FormFieldComponent } from '../../../../shared/components/form-field/form-field.component';
import { IconComponent } from '../../../../shared/components/icon/icon.component';
import {
  COMPANY_EMAIL_DOMAIN,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  isCompanyEmail,
} from '../../../../core/models/auth.model';
import type { Role } from '../../../../core/models/auth.model';
import { AuthService } from '../../../../core/services/auth.service';
import { AuthLayoutComponent } from '../../components/auth-layout/auth-layout.component';
import { GENERIC_REFUSAL, readRefusalOr } from '../../utils/read-backend-refusal';

/**
 * Registering, and asking for access in the same step.
 *
 * Public, so anybody with a company address can start. It leaves behind an account
 * that is **switched off** and a request an administrator reads, and it grants
 * nothing: an inactive account is refused by every route that matters. The row exists
 * so the person has a password to come back with, which is what lets them sign in
 * afterwards and be told they are still waiting rather than being told nothing and
 * left to guess.
 *
 * They choose the role they are asking for, and the form says plainly what that does
 * and does not mean. It is a sentence in an administrator's queue, not a smaller step
 * towards the role: the one that ends up on the account is whichever one the approval
 * carries, and an approval is sent by an administrator.
 *
 * The alternative shapes both had a cost. An open form that provisions an account lets
 * anyone who can type a colleague's address claim that address, because a domain
 * check proves the address was typed and not that the mailbox is theirs. Having no
 * form at all means only somebody who already knows an administrator can get in.
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
        Register
      </h1>
      <p class="mt-1 text-center text-sm text-muted-foreground">
        Register to get started. An administrator will review your request.
      </p>
      @if (isSent()) {
        <div class="mt-6 flex flex-col items-center gap-4 text-center">
          <p
            class="flex items-start gap-2 rounded-md bg-success/10 px-3 py-2 text-xs
              text-success"
          >
            <app-icon name="check-circle-2" [size]="14" class="mt-0.5 shrink-0" />
            <span class="text-left">
              Thanks — your request is with an administrator now. Sign in with the password you
              just chose and this screen will tell you when it has been approved.
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


          <app-form-field
            label="Password"
            [faintPlaceholder]="true"
            type="password"
            icon="lock"
            autocomplete="new-password"
            placeholder="At least 8 characters"
            [required]="true"
            [value]="password()"
            [error]="passwordError()"
            (valueChange)="onPasswordChange($event)"
          />

          <app-form-field
            label="Confirm password"
            [faintPlaceholder]="true"
            type="password"
            icon="lock"
            autocomplete="new-password"
            placeholder="Type it once more"
            [required]="true"
            [value]="confirmPassword()"
            [error]="confirmPasswordError()"
            (valueChange)="onConfirmPasswordChange($event)"
          />

          <button app-button type="submit" size="lg" [fullWidth]="true" [disabled]="isSubmitting()">
            @if (isSubmitting()) {
              <app-icon name="loader-2" [size]="16" class="animate-spin" />
              <span>Sending…</span>
            } @else {
              <span>Register</span>
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

        <div
          class="mt-6 flex flex-wrap items-center justify-center gap-x-1.5 border-t
            border-border pt-4 text-sm text-muted-foreground"
        >
          <span>Already have an account?</span>
          <a routerLink="/login" class="font-medium text-primary hover:underline">Sign in</a>
        </div>
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
   * The password is set here rather than later against an invitation, which is what
   * lets the person come back and sign in to check on their request. There is
   * deliberately nothing to type twice: they will not be asked for it again unless
   * an administrator resets it.
   *
   * The address carries a domain check here because the field should say so before
   * the round trip. It is a convenience — the server runs the same rule and is what
   * decides.
   */
  protected readonly form = this.formBuilder.group({
    name: this.formBuilder.nonNullable.control('', [
      Validators.required,
      Validators.maxLength(120),
    ]),
    email: this.formBuilder.nonNullable.control('', [Validators.required, Validators.email]),
    password: this.formBuilder.nonNullable.control('', [
      Validators.required,
      Validators.minLength(MIN_PASSWORD_LENGTH),
      Validators.maxLength(MAX_PASSWORD_LENGTH),
    ]),
    confirmPassword: this.formBuilder.nonNullable.control('', [Validators.required]),
    // Not on screen and not chosen. Held at the least privileged role so the request
    // that goes out asks for nothing, and an administrator can still raise it later.
    role: this.formBuilder.nonNullable.control<Role>('employee'),
  });

  /** The name as typed, for the error messages and the payload. */
  protected readonly name = signal('');

  /** The address as typed, likewise. */
  protected readonly email = signal('');

  /** The password as typed — never trimmed, because a space may be part of it. */
  protected readonly password = signal('');

  /** The password as typed a second time, to check it against the first. */
  protected readonly confirmPassword = signal('');

  /** Whether the form has been sent at all, which is what turns errors on. */
  private readonly submitted = signal(false);

  /** Whether a request is in flight, so the button cannot be pressed twice. */
  protected readonly isSubmitting = signal(false);

  /** Whether the request has been accepted and the confirmation is showing. */
  protected readonly isSent = signal(false);

  /** A refusal from the backend, or empty. */
  protected readonly notice = signal('');

  /** Name error, once the form has been sent. */
  protected readonly nameError = computed(() =>
    this.submitted() && this.name().trim() === '' ? 'Enter your full name' : '',
  );

  /** Address error, once the form has been sent. */
  protected readonly emailError = computed(() => {
    if (!this.submitted()) {
      return '';
    }

    const address = this.email().trim();

    if (address === '') {
      return 'Enter your work email';
    }

    // Two different mistakes, and they are told apart: something that is not an
    // address at all is a typo, and something that is an address somewhere else is a
    // person in the wrong place. One message for both would be wrong for one of them.
    if (!address.includes('@')) {
      return 'That does not look like an email address';
    }

    if (!isCompanyEmail(address)) {
      return `Use your @${this.companyDomain} work email`;
    }

    return '';
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
   * Whether the two entries agree, once the form has been sent.
   *
   * Checked here and nowhere else. The backend cannot tell a mistyped password from a
   * deliberate one — it receives a single field — so this is the only place the
   * mistake can be caught before the account is created with a password the person
   * cannot reproduce. Nothing about the request changes: the confirmation is never
   * sent.
   */
  protected readonly confirmPasswordError = computed(() => {
    if (!this.submitted()) {
      return '';
    }

    if (this.confirmPassword() === '') {
      return 'Type your password again';
    }

    return this.confirmPassword() === this.password()
      ? ''
      : 'Those passwords do not match';
  });

  protected onConfirmPasswordChange(value: string): void {
    this.confirmPassword.set(value);
    this.form.controls.confirmPassword.setValue(value);
  }

  /** Password error, once the form has been sent. */
  protected readonly passwordError = computed(() => {
    if (!this.submitted()) {
      return '';
    }

    const value = this.password();

    if (value === '') {
      return 'Choose a password';
    }
    if (value.length < MIN_PASSWORD_LENGTH) {
      return `Use at least ${MIN_PASSWORD_LENGTH} characters`;
    }
    if (value.length > MAX_PASSWORD_LENGTH) {
      return `Use at most ${MAX_PASSWORD_LENGTH} characters`;
    }

    return '';
  });

  protected onSubmit(): void {
    this.submitted.set(true);
    this.notice.set('');

    if (
      this.nameError() ||
      this.emailError() ||
      this.passwordError() ||
      this.confirmPasswordError() ||
      this.form.invalid
    ) {
      return;
    }

    this.isSubmitting.set(true);

    this.auth
      .requestAccess(
        this.form.controls.name.value,
        this.form.controls.email.value,
        // Nobody chooses this. The form holds the least privileged role, so the
        // request asks for an employee account and an administrator can raise it when
        // they look at it.
        this.form.controls.role.value,
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

  if (status === 429) {
    return 'Too many attempts. Please wait a moment and try again.';
  }
  if (status === 409 || status === 422 || status === 400) {
    // Both 409s are worth passing on rather than replacing: there is already an
    // account at that address, or a request is already waiting. Both are things the
    // reader can act on, and both come from the backend.
    return readRefusalOr(error, GENERIC_REFUSAL);
  }
  if (status === 0) {
    return 'Could not reach the server. Please check your connection and try again.';
  }

  return 'Your request could not be sent. Please try again.';
}
