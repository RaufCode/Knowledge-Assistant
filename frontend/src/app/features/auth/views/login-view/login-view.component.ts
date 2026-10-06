import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';

import { ButtonComponent } from '../../../../shared/components/button/button.component';
import { FormFieldComponent } from '../../../../shared/components/form-field/form-field.component';
import { IconComponent } from '../../../../shared/components/icon/icon.component';
import { COMPANY_EMAIL_DOMAIN, isCompanyEmail } from '../../../../core/models/auth.model';
import { AuthService } from '../../../../core/services/auth.service';
import { AuthLayoutComponent } from '../../components/auth-layout/auth-layout.component';
import { GENERIC_REFUSAL, readRefusalOr } from '../../utils/read-backend-refusal';

/**
 * Key the remembered work email is kept under.
 *
 * "Remember me" cannot remember a session while there is no session to remember,
 * and it cannot remember a password in any case. What it remembers is the address,
 * which is not a secret: it is already on screen every time somebody signs in, and
 * losing it means retyping it every morning.
 */
const REMEMBERED_EMAIL_KEY = 'knowledge-assistant.remembered-email';

/** Routes that are only useful before a session exists. */
const SIGNED_OUT_ROUTES = new Set(['/login', '/register', '/accept-invite', '/pending-approval']);

/**
 * The signed-out landing screen: collects a work email and a password and asks the
 * backend to start a session.
 *
 * The two are sent to `POST /api/auth/login`, and the answer arrives as two
 * `httpOnly` cookies. Nothing about the session is kept in this component or in
 * storage, because there is nothing here to keep — the browser holds it and this
 * screen is told only who the person is.
 *
 * The validators below are for the reader. The server runs the same checks and is
 * the one that decides: a field that looks right here can still be refused there,
 * and a rule that is only ever checked in a browser is a rule nobody is protected
 * by.
 */
@Component({
  selector: 'app-login-view',
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
      <h1 class="text-center font-headings text-xl font-semibold text-foreground">Sign in</h1>
      <p class="mt-1 text-center text-sm text-muted-foreground">Sign in to get started</p>

      <form class="mt-6 flex flex-col gap-4" [formGroup]="form" (ngSubmit)="onSubmit()">
        <app-form-field
          label="Work email"
          type="email"
          icon="mail"
          autocomplete="email"
          [placeholder]="'you@' + companyDomain"
          [faintPlaceholder]="true"
          [required]="true"
          [value]="email()"
          [error]="emailError()"
          (valueChange)="onEmailChange($event)"
        />

        <app-form-field
          label="Password"
          type="password"
          icon="lock"
          autocomplete="current-password"
          placeholder="Enter your password"
          [faintPlaceholder]="true"
          [required]="true"
          [value]="password()"
          [error]="passwordError()"
          (valueChange)="onPasswordChange($event)"
        />

        <label class="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            class="size-3.5 cursor-pointer accent-primary"
            [checked]="rememberMe()"
            (change)="onRememberMe($event)"
          />
          <span>Remember me</span>
        </label>

        <button app-button type="submit" size="lg" [fullWidth]="true" [disabled]="isSubmitting()">
          @if (isSubmitting()) {
            <app-icon name="loader-2" [size]="16" class="animate-spin" />
            <span>Signing in…</span>
          } @else {
            <span>Sign in</span>
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

      <!--
        One line, under the form.

        Stacked, these were three short lines in a centred column, which read as a
        footnote rather than as part of the form. On one line they read as one
        question with one answer, which is all they are.

        The invitation link is not here. Somebody who was invited already knows they
        were, and it reached them by a link an administrator sent; putting it beside
        "no account yet" invited a second question for the person who had just been
        told the answer.
      -->
      <!--
        Centred by the box, not by 'text-align'.

        'text-center' centres whatever is inline inside it and nothing else, so the
        two halves lined up only for as long as they stayed inline — and the moment
        either became a block, or the row wrapped on a narrow screen, the question and
        the answer drifted apart to opposite edges. A centred flex row positions the
        two together whatever they are, and wraps as one unit rather than separating.
      -->
      <div
        class="mt-6 flex flex-wrap items-center justify-center gap-x-1.5 border-t
          border-border pt-4 text-sm text-muted-foreground"
      >
        <span>Don't have an account?</span>
        <a routerLink="/register" class="font-medium text-primary hover:underline">
          Create an account
        </a>
      </div>
    </app-auth-layout>
  `,
})
export class LoginViewComponent {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly formBuilder = inject(FormBuilder);

  /** The domain the hint above asks for, read from the one place it is written. */
  protected readonly companyDomain = COMPANY_EMAIL_DOMAIN;

  /**
   * The form itself.
   *
   * Built with non-nullable controls, so reading `value` never has to be followed
   * by a check for `null`. The password carries only a length floor: a policy about
   * what a new password must contain is a rule for setting one, and applying it
   * here would stop somebody signing in with a password that predates the policy.
   */
  protected readonly form = this.formBuilder.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
    password: ['', [Validators.required]],
  });

  /** Work email as typed. */
  protected readonly email = signal('');

  /** Password as typed. */
  protected readonly password = signal('');

  /** Whether the address should be remembered for next time. */
  protected readonly rememberMe = signal(false);

  /** Whether the form has been sent, which is when fields start complaining. */
  private readonly submitted = signal(false);

  /** Whether the sign-in request is in flight. */
  protected readonly isSubmitting = signal(false);

  /** Explanatory message shown after an attempt. */
  protected readonly notice = signal('');

  /** Email error, once the form has been sent. */
  protected readonly emailError = computed(() => {
    if (!this.submitted()) {
      return '';
    }

    const control = this.form.controls.email;

    if (control.hasError('required')) {
      return 'Enter your work email';
    }
    if (control.hasError('email')) {
      return 'That does not look like an email address';
    }
    // Worth saying before the round trip, because a personal address is the
    // likeliest mistake here and the server will refuse it anyway.
    if (!isCompanyEmail(control.value)) {
      return `Use your @${this.companyDomain} work email`;
    }

    return '';
  });

  /** Password error, once the form has been sent. */
  protected readonly passwordError = computed(() => {
    if (!this.submitted()) {
      return '';
    }

    return this.form.controls.password.hasError('required') ? 'Enter your password' : '';
  });

  constructor() {
    // Fill the address if it was remembered last time. "Remember me" exists only
    // because it is on the design, and doing nothing with it would be a dead
    // control. Since the session itself is a cookie the browser holds and this
    // screen cannot read, the thing that is safe to remember is the email, and
    // nothing else.
    try {
      const remembered = localStorage.getItem(REMEMBERED_EMAIL_KEY);

      if (remembered && remembered.includes('@')) {
        this.email.set(remembered);
        this.rememberMe.set(true);
        this.form.controls.email.setValue(remembered);
      }
    } catch {
      // Storage may be unavailable in private modes, in which case the best course
      // is to ignore the request to remember and leave the form as it is.
    }
  }

  /** Feeds the field into the form, which owns the validation. */
  protected onEmailChange(value: string): void {
    this.email.set(value);
    this.form.controls.email.setValue(value);
  }

  /** Feeds the field into the form, which owns the validation. */
  protected onPasswordChange(value: string): void {
    this.password.set(value);
    this.form.controls.password.setValue(value);
  }

  /**
   * Sends the form to the backend.
   *
   * `markAllAsTouched` first, so that a submit with nothing typed in shows every
   * message rather than only the first one the reader runs into.
   */
  protected onSubmit(): void {
    this.submitted.set(true);
    this.notice.set('');

    if (this.emailError() || this.passwordError() || this.form.invalid) {
      return;
    }

    this.isSubmitting.set(true);

    this.auth.login(this.form.controls.email.value, this.form.controls.password.value).subscribe({
      next: (user) => {
        // `null` is the server's "your password was right and an administrator has to
        // approve this account". A separate screen, because nothing is wrong and a 401
        // here would send somebody to reset a password that is fine.
        if (user === null) {
          this.isSubmitting.set(false);
          void this.router.navigate(['/pending-approval']);

          return;
        }

        // Proved before navigating: a correct password is not yet a usable
        // session, because the session lives in cookies the browser has to keep.
        // When it does not keep them, navigating in anyway ends seconds later
        // back on this screen with nothing said — so the check happens here,
        // where the reason can still be named. A check that never answers is a
        // backend that cannot be reached, not a session that failed, and the
        // guards and the data calls ahead say that plainer than this screen can.
        this.auth.verifySession().subscribe({
          next: (persists) => {
            this.isSubmitting.set(false);

            if (persists) {
              void this.router.navigate([this.returnUrl()]);

              return;
            }

            this.auth.clear();

            // Named for what it usually is, because "allow cookies" is the right
            // advice for a browser refusing to store them and useless for every
            // other way of arriving here — and the reader cannot tell which they
            // are looking at. The address is called out because it is the one cause
            // nobody suspects: a `Secure` cookie is dropped without a word by a
            // browser on a plain-http page, which is what running the app locally
            // against a production backend amounts to.
            this.notice.set(
              'You signed in, but this browser did not keep the session. This is ' +
                'usually cookies being blocked — check that cookies are allowed for ' +
                'this site — and it also happens if this page was opened over http ' +
                'rather than https, because the session cookie is only stored on a ' +
                'secure connection. Sign in again once that is sorted.',
            );
          },
          error: () => {
            this.isSubmitting.set(false);
            void this.router.navigate([this.returnUrl()]);
          },
        });
      },
      error: (error: unknown) => {
        this.isSubmitting.set(false);
        this.notice.set(readSignInFailure(error));
      },
    });
  }

  /**
   * Records or forgets the address as the box is ticked.
   *
   * Applied on change rather than on submit so un-ticking takes effect at once: the
   * point of un-ticking the box is to stop being remembered, and holding the
   * address until the next attempt would keep it longer than asked.
   */
  protected onRememberMe(event: Event): void {
    this.rememberMe.set((event.target as HTMLInputElement).checked);

    try {
      if (this.rememberMe()) {
        localStorage.setItem(REMEMBERED_EMAIL_KEY, this.form.controls.email.value.trim());
      } else {
        localStorage.removeItem(REMEMBERED_EMAIL_KEY);
      }
    } catch {
      // Nothing useful to say here. Failing to remember an address is not worth an
      // error over the sign-in the user came for.
    }
  }

  /**
   * Where to go after signing in: back to whatever the guard interrupted, or the
   * role's own landing screen. A URL from the query string is only followed when it
   * is a path on this site — an absolute one would let a crafted link bounce
   * somebody off to somewhere else after they had signed in.
   *
   * Administrators always land on the dashboard: it is their home, with the figures
   * and the queue, and the assistant stays one click away on Ask. A return address
   * would drop them into a chat screen instead, past the very overview that tells
   * them what needs doing.
   *
   * The fallback is the landing path rather than a hardcoded `/`, so an employee
   * still lands on the assistant without this screen having to know the difference.
   */
  private returnUrl(): string {
    if (this.auth.isAdmin()) {
      return this.auth.landingPath();
    }

    const requested = this.route.snapshot.queryParamMap.get('returnUrl');

    if (
      requested &&
      requested.startsWith('/') &&
      !requested.startsWith('//') &&
      !this.isSignedOutRoute(requested)
    ) {
      return requested;
    }

    return this.auth.landingPath();
  }

  private isSignedOutRoute(path: string): boolean {
    const cleanPath = path.split(/[?#]/, 1)[0].replace(/\/+$/, '') || '/';

    return SIGNED_OUT_ROUTES.has(cleanPath);
  }
}

/**
 * What to say when sign-in is refused.
 *
 * The backend answers a wrong address and a wrong password with one message on
 * purpose, so that it cannot be used to find out who has an account. A 429 means
 * the attempt limit was reached, which is worth saying plainly because the reader
 * did nothing wrong and the fix is to wait.
 *
 * A correct password on an account that is still waiting for approval never reaches
 * this function: the backend answers that with its own `202` and its own payload, and
 * the caller navigates to the waiting screen. A refusal here means the sign-in really
 * was refused.
 */
function readSignInFailure(error: unknown): string {
  const status = (error as { status?: number } | null)?.status;

  if (status === 429) {
    return 'Too many attempts. Please wait a moment and try again.';
  }
  if (status === 0) {
    return 'Could not reach the server. Please check your connection and try again.';
  }
  if (status === 422) {
    // What the backend said, which for a sign-in means a malformed address or a
    // password the policy refuses. Naming the email here would be wrong: the address
    // is only one of the two fields that can be refused.
    return readRefusalOr(error, GENERIC_REFUSAL);
  }

  if (status === 401 || status === 403) {
    return 'That email and password do not match an account.';
  }

  // That message is said **only** for the statuses that mean the credentials were
  // refused. It used to be the fall-through for everything else, so a backend that fell
  // over answered a correct email and password with "that email and password do not
  // match an account" — the reader then blames the one thing that was fine, resets a
  // perfectly good password, and is refused again once the backend recovers.
  if (typeof status === 'number' && status >= 500) {
    // Deliberately NOT the server's own `detail`, unlike the case below. A 5xx body
    // holds whatever the backend was carrying when it broke — the exception's type and
    // message, a connection string, a query — and none of it was written for a reader.
    // Passing it through hands over the shape of the internals and tells the person in
    // front of the screen nothing they can act on.
    return 'Something went wrong signing you in. Please try again in a moment.';
  }

  // Anything else here is a refusal the backend did write for somebody to read — a
  // route that has moved, a body in an unexpected shape — so its own wording is more
  // use than any sentence chosen in this file.
  return readRefusalOr(error, 'Sign-in could not be completed. Please try again.');
}
