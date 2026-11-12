import { ComponentFixture, TestBed } from '@angular/core/testing';
import { HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { Subject, of, throwError } from 'rxjs';
import { LoginComponent } from './login.component';
import { AuthService } from '../services/auth.service';
import { FakeAuthService } from '../testing/fake-auth';

describe('LoginComponent', () => {
  let fixture: ComponentFixture<LoginComponent>;
  let auth: FakeAuthService;
  let closed: number;
  let signedIn: number;

  const el = <T extends HTMLElement = HTMLElement>(testId: string): T | null =>
    fixture.nativeElement.querySelector(`[data-testid="${testId}"]`);

  function type(testId: string, value: string): void {
    const input = el<HTMLInputElement>(testId) as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }

  function click(testId: string): void {
    el<HTMLButtonElement>(testId)?.click();
    fixture.detectChanges();
  }

  async function submitEmail(email = 'owner@example.test'): Promise<void> {
    type('login-email', email);
    await fixture.whenStable();
    fixture.detectChanges();
    click('login-send');
  }

  const httpError = (status: number, headers: Record<string, string> = {}) =>
    throwError(() => new HttpErrorResponse({ status, headers: new HttpHeaders(headers) }));

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [LoginComponent],
      providers: [{ provide: AuthService, useClass: FakeAuthService }],
    }).compileComponents();

    auth = TestBed.inject(AuthService) as unknown as FakeAuthService;
    fixture = TestBed.createComponent(LoginComponent);
    closed = 0;
    signedIn = 0;
    fixture.componentInstance.closed.subscribe(() => closed++);
    fixture.componentInstance.signedIn.subscribe(() => signedIn++);
    fixture.detectChanges();
  });

  describe('the dialog', () => {
    it('is an accessible modal dialog', () => {
      const dialog = el('login-dialog') as HTMLElement;

      expect(dialog.getAttribute('role')).toBe('dialog');
      expect(dialog.getAttribute('aria-modal')).toBe('true');
      expect(fixture.nativeElement.querySelector('#login-title').textContent).toContain('Owner sign in');
      expect(dialog.getAttribute('aria-labelledby')).toBe('login-title');
    });

    it('focuses the email field when it opens', async () => {
      await fixture.whenStable();

      expect(document.activeElement).toBe(el('login-email'));
    });

    it('closes on Cancel', () => {
      click('login-cancel');

      expect(closed).toBe(1);
    });

    it('closes on Escape', () => {
      (fixture.nativeElement.querySelector('.modal-overlay') as HTMLElement)
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

      expect(closed).toBe(1);
    });

    it('explains an ended session when that is why it opened', () => {
      expect(el('login-expired')).toBeNull();

      auth.sessionExpired.set(true);
      fixture.detectChanges();

      expect(el('login-expired')?.textContent).toContain('session ended');
    });
  });

  describe('step 1: email', () => {
    it('asks for an email and cannot send until one is typed', async () => {
      expect(el<HTMLInputElement>('login-email')?.type).toBe('email');
      expect(el<HTMLButtonElement>('login-send')?.disabled).toBeTrue();

      type('login-email', 'owner@example.test');
      await fixture.whenStable();
      fixture.detectChanges();

      expect(el<HTMLButtonElement>('login-send')?.disabled).toBeFalse();
    });

    it('requests a code for the trimmed address and moves on to the code step', async () => {
      await submitEmail('  owner@example.test  ');

      expect(auth.requestCode).toHaveBeenCalledOnceWith('owner@example.test');
      expect(el('login-code')).not.toBeNull();
      expect(el('login-email')).toBeNull();
    });

    it('shows the same neutral message whatever the address (the server never says)', async () => {
      await submitEmail('stranger@example.test');

      expect(el('login-neutral')?.textContent?.trim()).toBe('If this email is authorized, a code was sent.');
    });

    it('reports a rate limit with how long to wait', async () => {
      auth.requestCode.and.returnValue(httpError(429, { 'Retry-After': '600' }));

      await submitEmail();

      expect(el('login-message')?.textContent).toContain('Too many code requests');
      expect(el('login-message')?.textContent).toContain('10 minutes');
      expect(el('login-message')?.getAttribute('role')).toBe('alert');
      expect(el('login-code')).toBeNull(); // stays on the email step
    });

    it('reports an unreachable server', async () => {
      auth.requestCode.and.returnValue(httpError(0));

      await submitEmail();

      expect(el('login-message')?.textContent).toContain('Could not reach the server');
    });

    it('does not send twice while a request is in flight', async () => {
      const pending = new Subject<void>();
      auth.requestCode.and.returnValue(pending);

      await submitEmail();
      click('login-send');

      expect(auth.requestCode).toHaveBeenCalledTimes(1);
      expect(el<HTMLButtonElement>('login-send')?.disabled).toBeTrue();
    });
  });

  describe('step 2: code', () => {
    beforeEach(async () => {
      await submitEmail();
    });

    it('asks for a one-time code with the right input hints', () => {
      const input = el<HTMLInputElement>('login-code') as HTMLInputElement;

      expect(input.getAttribute('autocomplete')).toBe('one-time-code');
      expect(input.getAttribute('inputmode')).toBe('numeric');
      expect(input.maxLength).toBe(6);
      expect(fixture.nativeElement.querySelector('label[for="login-code"]').textContent).toContain('6-digit code');
    });

    it('keeps only digits, at most six, even if something else is typed or pasted', () => {
      type('login-code', '12a 34-56789');

      expect(el<HTMLInputElement>('login-code')?.value).toBe('123456');
    });

    it('cannot sign in until six digits are entered', () => {
      type('login-code', '12345');
      expect(el<HTMLButtonElement>('login-verify')?.disabled).toBeTrue();

      type('login-code', '123456');
      expect(el<HTMLButtonElement>('login-verify')?.disabled).toBeFalse();
    });

    it('verifies the code for the address and reports the sign-in', () => {
      type('login-code', '482915');

      click('login-verify');

      expect(auth.verify).toHaveBeenCalledOnceWith('owner@example.test', '482915');
      expect(signedIn).toBe(1);
    });

    it('submits on Enter too', () => {
      type('login-code', '482915');

      (fixture.nativeElement.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit'));
      fixture.detectChanges();

      expect(auth.verify).toHaveBeenCalledTimes(1);
    });

    it('a wrong code gets one neutral answer, clears the field and does not sign in', () => {
      auth.verify.and.returnValue(httpError(401));
      type('login-code', '000000');

      click('login-verify');

      expect(signedIn).toBe(0);
      expect(el('login-message')?.textContent).toContain('not valid or has expired');
      expect(el('login-message')?.getAttribute('role')).toBe('alert');
      expect(el<HTMLInputElement>('login-code')?.value).toBe('');
    });

    it('reports too many attempts with the wait', () => {
      auth.verify.and.returnValue(httpError(429, { 'Retry-After': '60' }));
      type('login-code', '000000');

      click('login-verify');

      expect(el('login-message')?.textContent).toContain('Too many attempts');
      expect(el('login-message')?.textContent).toContain('1 minute.');
      expect(signedIn).toBe(0);
    });

    it('reports other failures plainly', () => {
      auth.verify.and.returnValue(httpError(500));
      type('login-code', '000000');

      click('login-verify');

      expect(el('login-message')?.textContent).toContain('HTTP 500');
    });

    it('goes back to the email step to use a different address', () => {
      click('login-change-email');

      expect(el('login-email')).not.toBeNull();
      expect(el('login-code')).toBeNull();
    });

    it('can ask for a new code, with a neutral confirmation', () => {
      click('login-resend');

      expect(auth.requestCode).toHaveBeenCalledTimes(2);
      expect(el('login-message')?.textContent).toContain('If this email is authorized, a new code was sent.');
      expect(el('login-message')?.getAttribute('role')).toBe('status');
    });
  });

  describe('development helper', () => {
    it('is not offered on a normal server', async () => {
      auth.devHelper.set(false);
      await submitEmail();

      expect(el('login-dev-fill')).toBeNull();
    });

    it('fills in the code the development server logged', async () => {
      auth.devHelper.set(true);
      auth.devLastCode.and.returnValue(of('482915'));
      await submitEmail();

      click('login-dev-fill');

      expect(auth.devLastCode).toHaveBeenCalledOnceWith('owner@example.test');
      expect(el<HTMLInputElement>('login-code')?.value).toBe('482915');
      expect(el<HTMLButtonElement>('login-verify')?.disabled).toBeFalse();
    });

    it('says so when there is no code to fill in', async () => {
      auth.devHelper.set(true);
      auth.devLastCode.and.returnValue(of(null));
      await submitEmail();

      click('login-dev-fill');

      expect(el('login-message')?.textContent).toContain('No development code');
      expect(el<HTMLInputElement>('login-code')?.value).toBe('');
    });
  });

  describe('with an authenticator app', () => {
    // The server says login_method "totp": one step, just the code. Nothing is emailed and no address is asked for.
    beforeEach(() => {
      auth.loginMethod.set('totp');
      fixture = TestBed.createComponent(LoginComponent);
      closed = 0;
      signedIn = 0;
      fixture.componentInstance.closed.subscribe(() => closed++);
      fixture.componentInstance.signedIn.subscribe(() => signedIn++);
      fixture.detectChanges();
    });

    it('asks for the app\'s code straight away: no address, no "send code" step', () => {
      expect(el('login-code')).not.toBeNull();
      expect(el('login-totp-hint')?.textContent).toContain('authenticator app');
      for (const absent of ['login-email', 'login-send', 'login-neutral', 'login-change-email', 'login-resend']) {
        expect(el(absent)).withContext(absent).toBeNull();
      }
    });

    it('is still an accessible modal dialog, and focuses the code field when it opens', async () => {
      await fixture.whenStable();

      expect((el('login-dialog') as HTMLElement).getAttribute('role')).toBe('dialog');
      expect(document.activeElement).toBe(el('login-code'));
    });

    it('has the one-time-code input hints', () => {
      const input = el<HTMLInputElement>('login-code') as HTMLInputElement;

      expect(input.getAttribute('autocomplete')).toBe('one-time-code');
      expect(input.getAttribute('inputmode')).toBe('numeric');
      expect(input.maxLength).toBe(6);
      expect(fixture.nativeElement.querySelector('label[for="login-code"]').textContent).toContain('6-digit code');
    });

    it('keeps only digits, at most six (an app shows "123 456")', () => {
      type('login-code', '123 456');
      expect(el<HTMLInputElement>('login-code')?.value).toBe('123456');

      type('login-code', '12a 34-56789');
      expect(el<HTMLInputElement>('login-code')?.value).toBe('123456');
    });

    it('cannot sign in until six digits are entered', () => {
      type('login-code', '12345');
      expect(el<HTMLButtonElement>('login-verify')?.disabled).toBeTrue();

      type('login-code', '123456');
      expect(el<HTMLButtonElement>('login-verify')?.disabled).toBeFalse();
    });

    it('signs in with the code alone and reports it', () => {
      type('login-code', '482915');

      click('login-verify');

      expect(auth.verifyTotp).toHaveBeenCalledOnceWith('482915');
      expect(auth.verify).not.toHaveBeenCalled();
      expect(auth.requestCode).not.toHaveBeenCalled();
      expect(signedIn).toBe(1);
    });

    it('submits on Enter too', () => {
      type('login-code', '482915');

      (fixture.nativeElement.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit'));
      fixture.detectChanges();

      expect(auth.verifyTotp).toHaveBeenCalledOnceWith('482915');
    });

    it('does not submit twice while a request is in flight', () => {
      const pending = new Subject<void>();
      auth.verifyTotp.and.returnValue(pending);
      type('login-code', '482915');

      click('login-verify');
      click('login-verify');

      expect(auth.verifyTotp).toHaveBeenCalledTimes(1);
      expect(el<HTMLButtonElement>('login-verify')?.disabled).toBeTrue();
    });

    it('a wrong code gets one neutral answer in the app\'s words, clears the field and does not sign in', () => {
      auth.verifyTotp.and.returnValue(httpError(401));
      type('login-code', '000000');

      click('login-verify');

      expect(signedIn).toBe(0);
      expect(el('login-message')?.textContent).toContain('authenticator app');
      expect(el('login-message')?.textContent).toContain('not valid');
      expect(el('login-message')?.textContent).not.toContain('expired'); // that is the emailed-code wording
      expect(el('login-message')?.getAttribute('role')).toBe('alert');
      expect(el<HTMLInputElement>('login-code')?.value).toBe('');
    });

    it('explains a lockout with how long to wait, in minutes and then in hours', () => {
      const asked = (retryAfter: string): string => {
        auth.verifyTotp.and.returnValue(httpError(429, { 'Retry-After': retryAfter }));
        type('login-code', '123456');
        click('login-verify');
        return el('login-message')?.textContent ?? '';
      };

      expect(asked('900')).toContain('Too many attempts. Try again in 15 minutes.');
      expect(asked('60')).toContain('in 1 minute.');
      expect(asked('5400')).toContain('in 90 minutes.');
      expect(asked('7200')).toContain('in 2 hours.');
      expect(asked('86400')).toContain('in 24 hours.');
      expect(signedIn).toBe(0);
    });

    it('says to try again later when the lockout comes without a usable wait', () => {
      const withoutAUsableWait: Record<string, string>[] = [{}, { 'Retry-After': '0' }, { 'Retry-After': 'soon' }];
      for (const headers of withoutAUsableWait) {
        auth.verifyTotp.and.returnValue(httpError(429, headers));
        type('login-code', '123456');
        click('login-verify');

        expect(el('login-message')?.textContent).withContext(JSON.stringify(headers)).toContain('Too many attempts. Try again later.');
      }
    });

    it('reports an unreachable server and other failures plainly', () => {
      auth.verifyTotp.and.returnValue(httpError(0));
      type('login-code', '123456');
      click('login-verify');
      expect(el('login-message')?.textContent).toContain('Could not reach the server');

      auth.verifyTotp.and.returnValue(httpError(500));
      type('login-code', '123456');
      click('login-verify');
      expect(el('login-message')?.textContent).toContain('HTTP 500');
    });

    it('closes on Cancel and on Escape, and explains an ended session', () => {
      click('login-cancel');
      (fixture.nativeElement.querySelector('.modal-overlay') as HTMLElement)
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(closed).toBe(2);

      expect(el('login-expired')).toBeNull();
      auth.sessionExpired.set(true);
      fixture.detectChanges();
      expect(el('login-expired')?.textContent).toContain('session ended');
    });

    describe('development helper', () => {
      it('is not offered on a normal server', () => {
        auth.devHelper.set(false);
        fixture.detectChanges();

        expect(el('login-dev-fill')).toBeNull();
      });

      it('fills in the code that would sign in right now, asking for no address', () => {
        auth.devHelper.set(true);
        auth.devLastCode.and.returnValue(of('482915'));
        fixture.detectChanges();

        click('login-dev-fill');

        expect(auth.devLastCode).toHaveBeenCalledOnceWith(undefined);
        expect(el<HTMLInputElement>('login-code')?.value).toBe('482915');
        expect(el<HTMLButtonElement>('login-verify')?.disabled).toBeFalse();
      });

      it('says so when there is no code to fill in just now', () => {
        auth.devHelper.set(true);
        auth.devLastCode.and.returnValue(of(null));
        fixture.detectChanges();

        click('login-dev-fill');

        expect(el('login-message')?.textContent).toContain('No development code is available right now');
        expect(el<HTMLInputElement>('login-code')?.value).toBe('');
      });
    });

    it('switches back to the email form if the server says so', () => {
      auth.loginMethod.set('email');
      fixture.detectChanges();

      expect(el('login-email')).not.toBeNull();
      expect(el('login-totp-hint')).toBeNull();
    });
  });
});
