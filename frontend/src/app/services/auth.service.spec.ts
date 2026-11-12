import { TestBed, fakeAsync, tick } from '@angular/core/testing';
import { HttpClientTestingModule, HttpTestingController } from '@angular/common/http/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { AuthService } from './auth.service';

describe('AuthService', () => {
  let auth: AuthService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [HttpClientTestingModule] });
    auth = TestBed.inject(AuthService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('starts anonymous, with nothing loaded yet', () => {
    expect(auth.mode()).toBe('anonymous');
    expect(auth.email()).toBeNull();
    expect(auth.loaded()).toBeFalse();
    expect(auth.sessionExpired()).toBeFalse();
    expect(auth.devHelper()).toBeFalse();
    expect(auth.loginMethod()).toBe('email');
  });

  describe('load', () => {
    it('learns that the server wants an authenticator-app code', () => {
      auth.load().subscribe();

      http.expectOne('/api/auth/me').flush({ mode: 'anonymous', owner_login_enabled: true, login_method: 'totp', dev: false });

      expect(auth.loginMethod()).toBe('totp');
    });

    it('learns that the server emails a code', () => {
      auth.loginMethod.set('totp');
      auth.load().subscribe();

      http.expectOne('/api/auth/me').flush({ mode: 'anonymous', owner_login_enabled: true, login_method: 'email' });

      expect(auth.loginMethod()).toBe('email');
    });

    it('treats a server that does not say (an older one) as email', () => {
      auth.loginMethod.set('totp');
      auth.load().subscribe();

      http.expectOne('/api/auth/me').flush({ mode: 'anonymous', owner_login_enabled: true });

      expect(auth.loginMethod()).toBe('email');
    });

    it('treats an unknown method as email rather than showing a form that cannot work', () => {
      auth.load().subscribe();

      http.expectOne('/api/auth/me').flush({ mode: 'anonymous', owner_login_enabled: true, login_method: 'sms' });

      expect(auth.loginMethod()).toBe('email');
    });

    it('applies an anonymous /auth/me answer', () => {
      let answered: boolean | undefined;
      auth.load().subscribe((value) => (answered = value));

      const req = http.expectOne('/api/auth/me');
      expect(req.request.method).toBe('GET');
      req.flush({ mode: 'anonymous', owner_login_enabled: true, dev: false });

      expect(answered).toBeTrue();
      expect(auth.mode()).toBe('anonymous');
      expect(auth.ownerLoginEnabled()).toBeTrue();
      expect(auth.devHelper()).toBeFalse();
      expect(auth.loaded()).toBeTrue();
    });

    it('applies an owner /auth/me answer, including the dev flag', () => {
      auth.load().subscribe();

      http.expectOne('/api/auth/me').flush({ mode: 'owner', email: 'owner@example.test', owner_login_enabled: true, dev: true });

      expect(auth.mode()).toBe('owner');
      expect(auth.email()).toBe('owner@example.test');
      expect(auth.devHelper()).toBeTrue();
    });

    it('ignores an email on an anonymous answer', () => {
      auth.load().subscribe();

      http.expectOne('/api/auth/me').flush({ mode: 'anonymous', email: 'leak@example.test', owner_login_enabled: false });

      expect(auth.email()).toBeNull();
      expect(auth.ownerLoginEnabled()).toBeFalse();
    });

    it('never errors: a failed request leaves the state alone and emits false', () => {
      let answered: boolean | undefined;
      let failed = false;
      auth.load().subscribe({ next: (value) => (answered = value), error: () => (failed = true) });

      http.expectOne('/api/auth/me').flush('bad gateway', { status: 502, statusText: 'Bad Gateway' });

      expect(failed).toBeFalse();
      expect(answered).toBeFalse();
      expect(auth.loaded()).toBeFalse();
      expect(auth.mode()).toBe('anonymous');
    });

    it('gives up after four seconds so the app never waits on a hung backend', fakeAsync(() => {
      let answered: boolean | undefined;
      auth.load().subscribe((value) => (answered = value));
      const req = http.expectOne('/api/auth/me');

      tick(3999);
      expect(answered).toBeUndefined();
      tick(2);

      expect(answered).toBeFalse();
      expect(req.cancelled).toBeTrue();
    }));
  });

  describe('sign-in', () => {
    it('requestCode POSTs the email and resolves without exposing the answer', () => {
      let done = false;
      auth.requestCode('owner@example.test').subscribe(() => (done = true));

      const req = http.expectOne('/api/auth/request-code');
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual({ email: 'owner@example.test' });
      req.flush({ status: 'sent_if_allowed' }, { status: 202, statusText: 'Accepted' });

      expect(done).toBeTrue();
      expect(auth.mode()).toBe('anonymous');
    });

    it('requestCode passes a rate-limit error through to the caller', () => {
      let error: HttpErrorResponse | undefined;
      auth.requestCode('owner@example.test').subscribe({ error: (e) => (error = e) });

      http.expectOne('/api/auth/request-code').flush({ detail: 'Too many requests' }, { status: 429, statusText: 'Too Many Requests' });

      expect(error?.status).toBe(429);
    });

    it('verify POSTs email and code, then becomes owner and clears an earlier expiry flag', () => {
      auth.markSessionExpired();
      auth.verify('owner@example.test', '123456').subscribe();

      const req = http.expectOne('/api/auth/verify');
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual({ email: 'owner@example.test', code: '123456' });
      req.flush({ mode: 'owner', email: 'owner@example.test' });

      expect(auth.mode()).toBe('owner');
      expect(auth.email()).toBe('owner@example.test');
      expect(auth.sessionExpired()).toBeFalse();
      expect(auth.loaded()).toBeTrue();
    });

    it('a rejected code leaves the user anonymous', () => {
      let error: HttpErrorResponse | undefined;
      auth.verify('owner@example.test', '000000').subscribe({ error: (e) => (error = e) });

      http.expectOne('/api/auth/verify').flush({ detail: 'Invalid or expired code' }, { status: 401, statusText: 'Unauthorized' });

      expect(error?.status).toBe(401);
      expect(auth.mode()).toBe('anonymous');
      expect(auth.sessionExpired()).toBeFalse();
    });
  });

  describe('sign-in with an authenticator app', () => {
    it('verifyTotp POSTs the code alone -- no address -- and becomes the owner the server names', () => {
      auth.markSessionExpired();
      auth.verifyTotp('123456').subscribe();

      const req = http.expectOne('/api/auth/verify');
      expect(req.request.method).toBe('POST');
      expect(req.request.body).toEqual({ code: '123456' });
      expect('email' in req.request.body).toBeFalse();
      req.flush({ mode: 'owner', email: 'owner@example.test' });

      expect(auth.mode()).toBe('owner');
      expect(auth.email()).toBe('owner@example.test');
      expect(auth.sessionExpired()).toBeFalse();
      expect(auth.loaded()).toBeTrue();
    });

    it('does not invent an address if the server does not name one', () => {
      auth.verifyTotp('123456').subscribe();

      http.expectOne('/api/auth/verify').flush({ mode: 'owner' });

      expect(auth.mode()).toBe('owner');
      expect(auth.email()).toBeNull();
    });

    it('a rejected code leaves the user anonymous and passes the error on', () => {
      let error: HttpErrorResponse | undefined;
      auth.verifyTotp('000000').subscribe({ error: (e) => (error = e) });

      http.expectOne('/api/auth/verify').flush({ detail: 'Invalid or expired code' }, { status: 401, statusText: 'Unauthorized' });

      expect(error?.status).toBe(401);
      expect(auth.mode()).toBe('anonymous');
    });

    it('a lockout reaches the caller with its Retry-After', () => {
      let error: HttpErrorResponse | undefined;
      auth.verifyTotp('123456').subscribe({ error: (e) => (error = e) });

      http.expectOne('/api/auth/verify').flush(
        { detail: 'Too many attempts' },
        { status: 429, statusText: 'Too Many Requests', headers: { 'Retry-After': '900' } },
      );

      expect(error?.status).toBe(429);
      expect(error?.headers.get('Retry-After')).toBe('900');
      expect(auth.mode()).toBe('anonymous');
    });
  });

  describe('logout and expiry', () => {
    it('logout POSTs and returns to anonymous', () => {
      auth.mode.set('owner');
      auth.email.set('owner@example.test');
      auth.logout().subscribe();

      const req = http.expectOne('/api/auth/logout');
      expect(req.request.method).toBe('POST');
      req.flush({ mode: 'anonymous' });

      expect(auth.mode()).toBe('anonymous');
      expect(auth.email()).toBeNull();
      expect(auth.sessionExpired()).toBeFalse();
    });

    it('a failed logout leaves the user signed in (the cookie is still valid server-side)', () => {
      auth.mode.set('owner');
      auth.logout().subscribe({ error: () => undefined });

      http.expectOne('/api/auth/logout').flush('down', { status: 503, statusText: 'Service Unavailable' });

      expect(auth.mode()).toBe('owner');
    });

    it('markSessionExpired drops to anonymous and raises the flag', () => {
      auth.mode.set('owner');
      auth.email.set('owner@example.test');

      auth.markSessionExpired();

      expect(auth.mode()).toBe('anonymous');
      expect(auth.email()).toBeNull();
      expect(auth.sessionExpired()).toBeTrue();
    });
  });

  describe('devLastCode', () => {
    it('returns the code the development server logged', () => {
      let code: string | null | undefined;
      auth.devLastCode('owner@example.test').subscribe((value) => (code = value));

      const req = http.expectOne((r) => r.url === '/api/auth/dev/last-code');
      expect(req.request.params.get('email')).toBe('owner@example.test');
      req.flush({ code: '482915' });

      expect(code).toBe('482915');
    });

    it('asks without an address when there is none (authenticator app)', () => {
      let code: string | null | undefined;
      auth.devLastCode().subscribe((value) => (code = value));

      const req = http.expectOne((r) => r.url === '/api/auth/dev/last-code');
      expect(req.request.params.keys().length).toBe(0);
      req.flush({ code: '123456' });

      expect(code).toBe('123456');
    });

    it('returns null when the helper is not available', () => {
      let code: string | null | undefined;
      auth.devLastCode('owner@example.test').subscribe((value) => (code = value));

      http.expectOne((r) => r.url === '/api/auth/dev/last-code').flush({ detail: 'Not Found' }, { status: 404, statusText: 'Not Found' });

      expect(code).toBeNull();
    });
  });
});
