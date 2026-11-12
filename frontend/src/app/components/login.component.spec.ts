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
});
