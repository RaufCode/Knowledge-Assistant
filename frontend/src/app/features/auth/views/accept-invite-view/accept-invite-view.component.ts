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
import { ActivatedRoute, Router, RouterLink } from '@angular/router';

import { ButtonComponent } from '../../../../shared/components/button/button.component';
import { FormFieldComponent } from '../../../../shared/components/form-field/form-field.component';
import { IconComponent } from '../../../../shared/components/icon/icon.component';
import { MIN_PASSWORD_LENGTH } from '../../../../core/models/auth.model';
import { AuthService } from '../../../../core/services/auth.service';
import { AuthLayoutComponent } from '../../components/auth-layout/auth-layout.component';

/** One rule a new password has to satisfy. */
interface PasswordRule {
  label: string;
  met: boolean;
}

/**
 * The screen an invited person lands on from their email link: it confirms who the
 * invitation is for and collects the password that will replace it.
 *
 * The token arrives in the query string, and on load the screen asks the backend
 * what the invitation is for so the name and address can be filled in rather than
 * typed. That is a convenience, not a source of truth: the submission carries only
 * the token and the password, and the server works out everything else from the
 * token itself.
 *
 * Name and email are left editable rather than locked. The invitation was addressed
 * to a particular person, so changing them is usually a mistake — but locking them
 * turns a mistyped address at invite time into a dead end, and the backend is the
 * one that ultimately decides what account this produces.
 */
@Component({
  selector: 'app-accept-invite-view',
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
      @if (isLoadingInvitation()) {
        <p class="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
          <app-icon name="loader-2" [size]="16" class="animate-spin" />
          <span>Checking your invitation…</span>
        </p>
      } @else if (!isInvitationValid()) {
        <h1 class="text-center font-headings text-xl font-semibold text-foreground">
          This invitation cannot be used
        </h1>
        <p class="mt-1 text-center text-sm text-muted-foreground">
          {{ notice() }}
        </p>
        <p class="mt-6 border-t border-border pt-4 text-center text-sm text-muted-foreground">
          Already have a password?
          <a routerLink="/login" class="font-medium text-primary hover:underline">Sign in</a>
        </p>
      } @else {
        <p
          class="mb-5 flex items-start gap-2 rounded-md bg-secondary-soft px-3 py-2 text-xs
            text-secondary"
        >
          <app-icon name="mail" [size]="14" class="mt-0.5 shrink-0" />
          <span> Your account is created as soon as a password is set. </span>
        </p>

        <h1 class="text-center font-headings text-xl font-semibold text-foreground">
          Set your password
        </h1>
        <p class="mt-1 text-center text-sm text-muted-foreground">
          You will sign in with this password from then on.
        </p>

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
            [required]="true"
            [value]="email()"
            [error]="emailError()"
            (valueChange)="onEmailChange($event)"
          />

          <div>
            <app-form-field
              label="New password"
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
              <span>Saving…</span>
            } @else {
              <span>Set password</span>
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
          Already have a password?
          <a routerLink="/login" class="font-medium text-primary hover:underline">Sign in</a>
        </p>
      }
    </app-auth-layout>
  `,
})
export class AcceptInviteViewComponent {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly formBuilder = inject(FormBuilder);

  /**
   * The form.
   *
   * The password validator restates the length floor of the server's policy so the
   * reader finds out before the round trip. Length is the whole policy, so it is
   * the only rule rendered underneath the field. The server runs it and is what
   * decides, so this is a convenience.
   */
  protected readonly form = this.formBuilder.nonNullable.group({
    name: ['', [Validators.required, Validators.maxLength(120)]],
    email: ['', [Validators.required, Validators.email]],
    password: ['', [Validators.required, Validators.minLength(MIN_PASSWORD_LENGTH)]],
    confirmation: ['', [Validators.required]],
  });

  /** Full name as typed. */
  protected readonly name = signal('');

  /** Work email the invitation was sent to. */
  protected readonly email = signal('');

  /** Chosen password. */
  protected readonly password = signal('');

  /** Repeated password. */
  protected readonly confirmation = signal('');

  /** Whether the form has been sent, which is when fields start complaining. */
  private readonly submitted = signal(false);

  /** Whether the request is in flight. */
  protected readonly isSubmitting = signal(false);

  /** Explanatory message shown after an attempt. */
  protected readonly notice = signal('');

  /** Whether the invitation is still being looked up. */
  protected readonly isLoadingInvitation = signal(true);

  /** Whether the invitation in the URL turned out to be usable. */
  protected readonly isInvitationValid = signal(false);

  /**
   * The token from the link.
   *
   * Held and sent back on submit. It is not the account's identity and carries no
   * claim worth keeping: the backend looks the account up from it, and it is spent
   * as soon as the password is set.
   */
  private readonly token = signal('');

  constructor() {
    this.token.set(this.route.snapshot.queryParamMap.get('token') ?? '');

    // Only in a browser. A server render would otherwise ask the backend what this
    // invitation is for — a request whose result would be thrown away, because the
    // screen is rendered again on the client where the answer is actually used. It
    // would also mean an unauthenticated request to the API on every render of this
    // URL, which is the one URL a stranger is most likely to guess.
    if (this.token() && isPlatformBrowser(inject(PLATFORM_ID))) {
      this.loadInvitation();
      return;
    }

    this.isLoadingInvitation.set(false);

    if (!this.token()) {
      // No token at all, which is what someone gets from typing the path. There is
      // nothing to look up and nothing to submit.
      this.notice.set('Open the link from your invitation email to set a password.');
    }
  }

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
    if (this.email().trim() === '') {
      return 'Enter your work email';
    }

    return this.form.controls.email.hasError('email')
      ? 'That does not look like an email address'
      : '';
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

  /** Asks what the invitation is for, so the form can be filled in. */
  private loadInvitation(): void {
    this.auth.previewInvite(this.token()).subscribe({
      next: (invitation) => {
        this.name.set(invitation.name);
        this.email.set(invitation.email);
        this.form.patchValue({ name: invitation.name, email: invitation.email });
        this.isInvitationValid.set(true);
        this.isLoadingInvitation.set(false);
      },
      error: () => {
        // Unknown, expired and already-used tokens all answer the same way, so
        // there is nothing more specific to say and nothing to retry.
        this.notice.set('This invitation has expired or has already been used. Ask for a new one.');
        this.isLoadingInvitation.set(false);
      },
    });
  }

  /** Sends the chosen password, which activates the account and signs it in. */
  protected onSubmit(): void {
    this.submitted.set(true);
    this.notice.set('');

    if (this.hasErrors()) {
      return;
    }

    this.isSubmitting.set(true);

    this.auth.acceptInvite(this.token(), this.form.controls.password.value).subscribe({
      next: () => {
        // Accepting signs the person in server-side, so there is nothing to
        // navigate around: the app is already in a session. Where it lands depends
        // on the role that was just created, which the service now knows.
        this.isSubmitting.set(false);
        void this.router.navigateByUrl(this.auth.landingPath());
      },
      error: (error: unknown) => {
        this.isSubmitting.set(false);
        this.notice.set(readAcceptanceFailure(error));
      },
    });
  }

  /** Whether any field is currently complaining. */
  private hasErrors(): boolean {
    return Boolean(
      this.nameError() ||
      this.emailError() ||
      this.passwordError() ||
      this.confirmationError() ||
      this.form.invalid,
    );
  }
}

/**
 * What to say when the password is refused.
 *
 * A 422 is the policy refusing this particular password; a 429 is the attempt limit;
 * a 404 means the invitation went while the form was open, which is the case worth
 * naming rather than reporting as a bad password.
 */
function readAcceptanceFailure(error: unknown): string {
  const status = (error as { status?: number } | null)?.status;

  if (status === 404) {
    return 'This invitation has expired or has already been used. Ask for a new one.';
  }
  if (status === 429) {
    return 'Too many attempts. Please wait a moment and try again.';
  }
  if (status === 422) {
    return 'That password does not meet the requirements. Check the rules above.';
  }
  if (status === 0) {
    return 'Could not reach the server. Please check your connection and try again.';
  }

  return 'Your password could not be set. Please try again.';
}
