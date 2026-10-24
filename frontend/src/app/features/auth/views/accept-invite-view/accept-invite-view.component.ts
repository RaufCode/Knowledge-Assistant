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
import {
  COMPANY_EMAIL_DOMAIN,
  MAX_NAME_LENGTH,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  NAME_ALLOWED_PATTERN,
  isCompanyEmail,
  looksLikeEmailAddress,
} from '../../../../core/models/auth.model';
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

          <button app-button type="submit" size="lg" [fullWidth]="true" [disabled]="!canSubmit() || isSubmitting()">
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
   * reader finds out before the round trip. The character rules are not validators:
   * they are the `rules` list rendered underneath the field, which turns them into
   * something visible rather than a message that only appears on submit. The server
   * runs all of them and is what decides, so every one of these is a convenience.
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

  /**
   * The rules the new password has to satisfy, and whether each is met.
   *
   * Length, and nothing else — the backend's policy, kept identical so the checklist
   * here agrees with what will actually be accepted. The character-class rules this
   * used to list are gone: they measure the shape of a password rather than its
   * strength, and mainly produce `Passw0rd!`.
   */
  protected readonly rules = computed<PasswordRule[]>(() => {
    const value = this.password();

    return [
      {
        label: `At least ${MIN_PASSWORD_LENGTH} characters`,
        met: value.length >= MIN_PASSWORD_LENGTH,
      },
      {
        label: 'No spaces',
        met: !/\s/.test(value),
      },
      {
        label: `At most ${MAX_PASSWORD_LENGTH} characters`,
        met: value.length <= MAX_PASSWORD_LENGTH,
      },
    ];
  });

  /** Whether every password rule is satisfied. */
  private readonly isPasswordValid = computed(() => this.rules().every((rule) => rule.met));

  /** Whether the button should be enabled, which is only when the whole form is valid. */
  protected readonly canSubmit = computed(() => {
    if (this.isSubmitting() || !this.isInvitationValid()) {
      return false;
    }

    const name = this.name().trim();
    const email = this.email().trim();
    const password = this.password();

    if (name === '' || email === '' || password === '' || this.confirmation() === '') {
      return false;
    }
    if (name.length > MAX_NAME_LENGTH || !NAME_ALLOWED_PATTERN.test(name)) {
      return false;
    }
    if (!looksLikeEmailAddress(email) || !isCompanyEmail(email)) {
      return false;
    }
    if (!this.isPasswordValid() || password !== this.confirmation()) {
      return false;
    }

    return this.form.valid;
  });

  /** Name error, once the form has been sent. */
  protected readonly nameError = computed(() => {
    if (!this.submitted()) {
      return '';
    }

    const value = this.name().trim();

    if (value === '') {
      return 'Enter your full name';
    }
    if (value.length > MAX_NAME_LENGTH) {
      return `Use at most ${MAX_NAME_LENGTH} characters`;
    }
    if (!NAME_ALLOWED_PATTERN.test(value)) {
      return 'Name can only contain letters, spaces, hyphens and apostrophes';
    }

    return '';
  });

  /** Email error, once the form has been sent. */
  protected readonly emailError = computed(() => {
    if (!this.submitted()) {
      return '';
    }

    const address = this.email().trim();

    if (address === '') {
      return 'Enter your work email';
    }
    if (!looksLikeEmailAddress(address)) {
      return 'That does not look like an email address';
    }
    if (!isCompanyEmail(address)) {
      return `Use your @${COMPANY_EMAIL_DOMAIN} work email`;
    }

    return '';
  });

  /** Password error, once the form has been sent. */
  protected readonly passwordError = computed(() => {
    if (!this.submitted()) {
      return '';
    }

    const value = this.password();

    if (value === '') {
      return 'Choose a password';
    }
    if (value.trim() === '') {
      return 'Password cannot be only spaces';
    }
    if (/\s/.test(value)) {
      return 'Password cannot contain spaces';
    }
    if (value.length < MIN_PASSWORD_LENGTH) {
      return `Use at least ${MIN_PASSWORD_LENGTH} characters`;
    }
    if (value.length > MAX_PASSWORD_LENGTH) {
      return `Use at most ${MAX_PASSWORD_LENGTH} characters`;
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

    if (!this.canSubmit() || this.hasErrors()) {
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
