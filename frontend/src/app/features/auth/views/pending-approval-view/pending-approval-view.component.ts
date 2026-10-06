import { ChangeDetectionStrategy, Component, computed, inject, OnInit } from '@angular/core';
import { RouterLink } from '@angular/router';

import { AuthService } from '../../../../core/services/auth.service';
import { AuthLayoutComponent } from '../../components/auth-layout/auth-layout.component';
import { ButtonComponent } from '../../../../shared/components/button/button.component';
import { IconComponent } from '../../../../shared/components/icon/icon.component';

/**
 * Shown after a correct sign-in for an account that is not switched on.
 *
 * A distinct screen rather than an error, because nothing is wrong. The password was
 * right, the account exists, and it is waiting on an administrator — a 401 here would
 * tell somebody to reset a password that is perfectly fine, and a spinner would leave
 * them refreshing a page that is never going to change.
 *
 * Reached on the server's `202`, which it sends **only when the password was
 * correct**. That is what makes it safe to show: the person has already proved the
 * account is theirs, so telling them its state discloses nothing to anybody else. A
 * wrong password gets one generic answer whether the address is unknown, taken or
 * waiting, so this screen cannot be used to find out who works here.
 *
 * What it must not do is pretend to be progress. There is no countdown and no
 * "checking" — the answer will not arrive on its own, and a screen that looks like it
 * is about to change is worse than one that plainly says it will not.
 */
@Component({
  selector: 'app-pending-approval-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AuthLayoutComponent, ButtonComponent, IconComponent, RouterLink],
  template: `
    <app-auth-layout>
      <div class="flex flex-col items-center gap-4 text-center">
        <span
          class="flex size-11 items-center justify-center rounded-full bg-warning/10
            text-warning"
        >
          <app-icon name="clock" [size]="20" />
        </span>

        <h1 class="font-headings text-xl font-semibold text-foreground">
          Waiting for approval
        </h1>

        <p class="max-w-sm text-sm leading-relaxed text-muted-foreground">
          @if (firstName()) {
            Thanks {{ firstName() }} — your request has been received and an administrator
            has to approve it before you can use the assistant.
          } @else {
            Your request has been received and an administrator has to approve it
            before you can use the assistant. Try signing in again once you have
            heard back.
          }
        </p>

        @if (pending()?.requested_role; as asked) {
          <p class="max-w-sm text-sm leading-relaxed text-muted-foreground">
            You asked for
            <span class="font-medium text-foreground">
              {{ asked === 'admin' ? 'administrator' : 'employee' }}
            </span>
            access. An administrator decides what you are given, so it may not be what
            you asked for.
          </p>
        }

        <a routerLink="/login" class="mt-2">
          <button app-button type="button" variant="outline" size="lg">
            Back to sign in
          </button>
        </a>
      </div>
    </app-auth-layout>
  `,
})
export class PendingApprovalViewComponent implements OnInit {
  private readonly auth = inject(AuthService);

  constructor() {
    this.auth.refreshPendingFromCookie();
  }

  async ngOnInit(): Promise<void> {
    await this.auth.maybeBootstrap();
    this.auth.refreshPendingFromCookie();
  }

  /**
   * What the server said about the request, read from the service.
   *
   * Not from the URL, and not from navigation state: neither survives a refresh, and a
   * screen that renders blank on reload is worse than one that says what it knows. The
   * service holds it for exactly as long as this answer is worth reading.
   */
  readonly pending = this.auth.lastPending;

  /**
   * The first name, or nothing.
   *
   * First rather than the whole name because this is the first thing read on the
   * screen, and "Waiting for approval, Kwame" is warmer than a form-letter reading
   * somebody's full legal name at them.
   */
  protected readonly firstName = computed(() => {
    const name = this.pending()?.name.trim() ?? '';

    return name ? name.split(/\s+/)[0] : '';
  });
}