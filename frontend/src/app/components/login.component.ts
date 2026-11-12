import { Component, ElementRef, afterNextRender, computed, inject, output, signal, viewChild } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../services/auth.service';

type Step = 'email' | 'code';

/**
 * Passwordless owner sign-in. Two forms, chosen by the server (GET /auth/me `login_method`):
 *
 *  - authenticator app: one step -- the 6-digit code the owner's app shows. Nothing is sent and no address
 *    is asked for;
 *  - email: the address, then the 6-digit code that was emailed. It never says whether an address is the
 *    owner's -- the server answers the same way for every address, and so does this form.
 */
@Component({
  selector: 'app-login',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="modal-overlay" (keydown.escape)="close()">
      <div class="modal modal-sm" role="dialog" aria-modal="true" aria-labelledby="login-title" data-testid="login-dialog">
        <h3 id="login-title">Owner sign in</h3>

        @if (auth.sessionExpired()) {
          <p class="login-note" data-testid="login-expired">Your session ended, so campaign content is locked. Sign in again to continue.</p>
        }

        @if (isTotp()) {
          <p class="hint login-neutral" data-testid="login-totp-hint">Open your authenticator app and enter the 6-digit code it shows for Combat Copilot.</p>

          <form (ngSubmit)="submitCode()" novalidate>
            <label for="login-code">6-digit code</label>
            <input #codeInput id="login-code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code"
                   maxlength="6" pattern="[0-9]*" class="w-100 mb-8 code-input"
                   [value]="code()" (input)="onCodeInput($event)" data-testid="login-code" />

            @if (message()) {
              <p class="login-message" [class.error]="isError()" [attr.role]="isError() ? 'alert' : 'status'" data-testid="login-message">{{ message() }}</p>
            }

            @if (auth.devHelper()) {
              <div class="login-links">
                <button type="button" class="btn btn-secondary btn-sm" (click)="fillDevCode()" data-testid="login-dev-fill">Fill code (dev)</button>
              </div>
            }

            <div class="modal-actions">
              <button type="button" class="btn btn-secondary" (click)="close()" data-testid="login-cancel">Cancel</button>
              <button type="submit" class="btn" [disabled]="busy() || code().length !== 6" data-testid="login-verify">Sign in</button>
            </div>
          </form>
        } @else if (step() === 'email') {
          <form (ngSubmit)="sendCode()" novalidate>
            <label for="login-email">Email</label>
            <input #emailInput id="login-email" name="email" type="email" autocomplete="email" class="w-100 mb-8"
                   [(ngModel)]="email" data-testid="login-email" />

            @if (message()) {
              <p class="login-message" [class.error]="isError()" [attr.role]="isError() ? 'alert' : 'status'" data-testid="login-message">{{ message() }}</p>
            }

            <div class="modal-actions">
              <button type="button" class="btn btn-secondary" (click)="close()" data-testid="login-cancel">Cancel</button>
              <button type="submit" class="btn" [disabled]="busy() || !email.trim()" data-testid="login-send">Send code</button>
            </div>
          </form>
        } @else {
          <p class="hint login-neutral" role="status" data-testid="login-neutral">If this email is authorized, a code was sent.</p>

          <form (ngSubmit)="submitCode()" novalidate>
            <label for="login-code">6-digit code</label>
            <input #codeInput id="login-code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code"
                   maxlength="6" pattern="[0-9]*" class="w-100 mb-8 code-input"
                   [value]="code()" (input)="onCodeInput($event)" data-testid="login-code" />

            @if (message()) {
              <p class="login-message" [class.error]="isError()" [attr.role]="isError() ? 'alert' : 'status'" data-testid="login-message">{{ message() }}</p>
            }

            <div class="login-links">
              <button type="button" class="link-button" (click)="useAnotherEmail()" data-testid="login-change-email">Use a different email</button>
              <button type="button" class="link-button" (click)="resend()" [disabled]="busy()" data-testid="login-resend">Send a new code</button>
              @if (auth.devHelper()) {
                <button type="button" class="btn btn-secondary btn-sm" (click)="fillDevCode()" data-testid="login-dev-fill">Fill code (dev)</button>
              }
            </div>

            <div class="modal-actions">
              <button type="button" class="btn btn-secondary" (click)="close()" data-testid="login-cancel">Cancel</button>
              <button type="submit" class="btn" [disabled]="busy() || code().length !== 6" data-testid="login-verify">Sign in</button>
            </div>
          </form>
        }
      </div>
    </div>
  `,
  styleUrl: './login.component.css',
})
export class LoginComponent {
  protected readonly auth = inject(AuthService);

  readonly closed = output<void>();
  readonly signedIn = output<void>();

  /** True when the server wants an authenticator-app code instead of an emailed one. */
  protected readonly isTotp = computed(() => this.auth.loginMethod() === 'totp');

  protected email = '';
  protected readonly step = signal<Step>('email');
  protected readonly code = signal('');
  protected readonly busy = signal(false);
  protected readonly message = signal('');
  protected readonly isError = signal(false);

  private readonly emailInput = viewChild<ElementRef<HTMLInputElement>>('emailInput');
  private readonly codeInput = viewChild<ElementRef<HTMLInputElement>>('codeInput');

  constructor() {
    afterNextRender(() => (this.isTotp() ? this.codeInput() : this.emailInput())?.nativeElement.focus());
  }

  protected close(): void {
    this.closed.emit();
  }

  protected sendCode(): void {
    this.requestCode(false);
  }

  protected resend(): void {
    this.requestCode(true);
  }

  private requestCode(isResend: boolean): void {
    const email = this.email.trim();
    if (!email || this.busy()) {
      return;
    }
    this.busy.set(true);
    this.setMessage('');
    this.auth.requestCode(email).subscribe({
      next: () => {
        this.busy.set(false);
        this.code.set('');
        this.step.set('code');
        if (isResend) {
          this.setMessage('If this email is authorized, a new code was sent.');
        }
        setTimeout(() => this.codeInput()?.nativeElement.focus());
      },
      error: (error: HttpErrorResponse) => {
        this.busy.set(false);
        this.setMessage(this.failureMessage(error, 'code requests'), true);
      },
    });
  }

  protected submitCode(): void {
    const code = this.code();
    if (code.length !== 6 || this.busy()) {
      return;
    }
    this.busy.set(true);
    this.setMessage('');
    const request = this.isTotp() ? this.auth.verifyTotp(code) : this.auth.verify(this.email.trim(), code);
    request.subscribe({
      next: () => {
        this.busy.set(false);
        this.signedIn.emit();
      },
      error: (error: HttpErrorResponse) => {
        this.busy.set(false);
        if (error.status === 401) {
          // The same answer for a wrong, expired, reused or never-issued code: the server does not say which.
          this.code.set('');
          this.setMessage(
            this.isTotp()
              ? 'That code is not valid. Use the code your authenticator app shows right now, and try again.'
              : 'That code is not valid or has expired. Check it and try again, or send a new code.',
            true,
          );
          setTimeout(() => this.codeInput()?.nativeElement.focus());
        } else {
          this.setMessage(this.failureMessage(error, 'attempts'), true);
        }
      },
    });
  }

  protected useAnotherEmail(): void {
    this.step.set('email');
    this.code.set('');
    this.setMessage('');
    setTimeout(() => this.emailInput()?.nativeElement.focus());
  }

  /**
   * Development servers only: fill in the code the console email sender logged -- or, with an authenticator
   * app, the code that would sign in right now.
   */
  protected fillDevCode(): void {
    this.auth.devLastCode(this.isTotp() ? undefined : this.email.trim()).subscribe((code) => {
      if (code) {
        this.code.set(code);
        this.setMessage('');
      } else {
        this.setMessage(
          this.isTotp()
            ? 'No development code is available right now. Wait a few seconds and try again.'
            : 'No development code is available for that email.',
          true,
        );
      }
    });
  }

  /** Digits only, at most six: tolerates pasting "123 456" or a code with stray characters. */
  protected onCodeInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    const digits = input.value.replace(/\D/g, '').slice(0, 6);
    input.value = digits;
    this.code.set(digits);
  }

  private setMessage(text: string, error = false): void {
    this.message.set(text);
    this.isError.set(error);
  }

  private failureMessage(error: HttpErrorResponse, what: string): string {
    if (error.status === 429) {
      const wait = this.waitText(Number(error.headers?.get('Retry-After')));
      return wait ? `Too many ${what}. Try again in ${wait}.` : `Too many ${what}. Try again later.`;
    }
    if (error.status === 0) {
      return 'Could not reach the server. Try again in a moment.';
    }
    return `Something went wrong (HTTP ${error.status}). Try again.`;
  }

  /** "1 minute", "15 minutes", "24 hours": the wait a Retry-After header asks for, rounded up. */
  private waitText(seconds: number): string {
    if (!(seconds > 0)) {
      return '';
    }
    const minutes = Math.ceil(seconds / 60);
    if (minutes < 120) {
      return `${minutes} minute${minutes === 1 ? '' : 's'}`;
    }
    return `${Math.ceil(minutes / 60)} hours`;
  }
}
