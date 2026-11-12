import { signal } from '@angular/core';
import { of } from 'rxjs';
import { LoginMethod, Mode } from '../models/auth.model';

/**
 * A stand-in for AuthService with the same signals and no HTTP, for component tests:
 * set the signals directly to put the app in a mode, and inspect the spies.
 * Like the real service, markSessionExpired() drops to anonymous and raises the flag.
 */
export class FakeAuthService {
  mode = signal<Mode>('anonymous');
  email = signal<string | null>(null);
  ownerLoginEnabled = signal(true);
  loginMethod = signal<LoginMethod>('email');
  devHelper = signal(false);
  loaded = signal(true);
  sessionExpired = signal(false);

  load = jasmine.createSpy('load').and.callFake(() => of(true));
  requestCode = jasmine.createSpy('requestCode').and.callFake(() => of(undefined));
  verify = jasmine.createSpy('verify').and.callFake(() => of(undefined));
  verifyTotp = jasmine.createSpy('verifyTotp').and.callFake(() => of(undefined));
  logout = jasmine.createSpy('logout').and.callFake(() => {
    this.mode.set('anonymous');
    this.email.set(null);
    return of(undefined);
  });
  markSessionExpired = jasmine.createSpy('markSessionExpired').and.callFake(() => {
    this.mode.set('anonymous');
    this.email.set(null);
    this.sessionExpired.set(true);
  });
  devLastCode = jasmine.createSpy('devLastCode').and.callFake(() => of('123456'));

  becomeOwner(email = 'owner@example.test'): void {
    this.mode.set('owner');
    this.email.set(email);
  }
}
