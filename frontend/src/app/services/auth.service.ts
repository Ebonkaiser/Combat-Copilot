import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, catchError, map, of, tap, timeout } from 'rxjs';
import { environment } from '../../environments/environment';
import { AuthMe, LoginMethod, Mode } from '../models/auth.model';

/**
 * Who is using the app. The server decides: the session lives in an HttpOnly
 * cookie this code cannot read, so `mode` only ever mirrors what /auth/me (or a
 * successful sign-in) last said. Nothing here grants access by itself -- the
 * backend re-checks the cookie on every request.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = environment.apiUrl;

  readonly mode = signal<Mode>('anonymous');
  readonly email = signal<string | null>(null);
  readonly ownerLoginEnabled = signal(false);
  /** What the sign-in form asks for. `email` until the server says otherwise. */
  readonly loginMethod = signal<LoginMethod>('email');
  /** Development server that can hand out a sign-in code: the login form offers "Fill code (dev)". */
  readonly devHelper = signal(false);
  /** True once /auth/me has answered at least once; until then `mode` is only a default. */
  readonly loaded = signal(false);
  /** A signed-in owner's session was found to have ended. Cleared by the next sign-in. */
  readonly sessionExpired = signal(false);

  /** GET /auth/me. Never errors: if the backend cannot answer, the state stays as it was and this emits false. */
  load(): Observable<boolean> {
    return this.http.get<AuthMe>(`${this.baseUrl}/auth/me`).pipe(
      timeout(4000),
      tap((me) => this.apply(me)),
      map(() => true),
      catchError(() => of(false)),
    );
  }

  private apply(me: AuthMe): void {
    this.mode.set(me.mode);
    this.email.set(me.mode === 'owner' ? (me.email ?? null) : null);
    this.ownerLoginEnabled.set(!!me.owner_login_enabled);
    this.loginMethod.set(me.login_method === 'totp' ? 'totp' : 'email');
    this.devHelper.set(!!me.dev);
    this.loaded.set(true);
  }

  /** POST /auth/request-code. The answer is always "202 sent if allowed": it never says whether the address is the owner's. */
  requestCode(email: string): Observable<void> {
    return this.http.post(`${this.baseUrl}/auth/request-code`, { email }).pipe(map(() => undefined));
  }

  /** POST /auth/verify with an emailed code. On success the server has set the session cookie. */
  verify(email: string, code: string): Observable<void> {
    return this.signIn({ email, code }, email);
  }

  /**
   * POST /auth/verify with the code from the owner's authenticator app. No address is sent: the owner is
   * the one address the server was set up with, and it comes back in the answer.
   */
  verifyTotp(code: string): Observable<void> {
    return this.signIn({ code }, null);
  }

  private signIn(body: { email?: string; code: string }, fallbackEmail: string | null): Observable<void> {
    return this.http.post<{ mode: Mode; email?: string }>(`${this.baseUrl}/auth/verify`, body).pipe(
      tap((result) => {
        this.mode.set('owner');
        this.email.set(result.email ?? fallbackEmail);
        this.sessionExpired.set(false);
        this.loaded.set(true);
      }),
      map(() => undefined),
    );
  }

  logout(): Observable<void> {
    return this.http.post(`${this.baseUrl}/auth/logout`, {}).pipe(
      tap(() => {
        this.mode.set('anonymous');
        this.email.set(null);
        this.sessionExpired.set(false);
      }),
      map(() => undefined),
    );
  }

  /** A request found the session gone (HTTP 401 from an owner call): drop to anonymous and flag it for the UI. */
  markSessionExpired(): void {
    this.mode.set('anonymous');
    this.email.set(null);
    this.sessionExpired.set(true);
  }

  /**
   * Development helper: the code the console email sender "sent" for `email`, or -- with an authenticator
   * app, where there is no address -- the code that would sign in right now. Emits null when unavailable.
   */
  devLastCode(email?: string): Observable<string | null> {
    return this.http
      .get<{ code: string }>(`${this.baseUrl}/auth/dev/last-code`, { params: email ? { email } : {} })
      .pipe(
        map((result) => result.code),
        catchError(() => of(null)),
      );
  }
}
