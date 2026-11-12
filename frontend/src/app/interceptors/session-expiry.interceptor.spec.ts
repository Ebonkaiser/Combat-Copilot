import { TestBed } from '@angular/core/testing';
import { HttpClient, HttpErrorResponse, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { sessionExpiryInterceptor } from './session-expiry.interceptor';
import { AuthService } from '../services/auth.service';
import { FakeAuthService } from '../testing/fake-auth';

describe('sessionExpiryInterceptor', () => {
  let http: HttpClient;
  let httpMock: HttpTestingController;
  let auth: FakeAuthService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([sessionExpiryInterceptor])),
        provideHttpClientTesting(),
        { provide: AuthService, useClass: FakeAuthService },
      ],
    });
    http = TestBed.inject(HttpClient);
    httpMock = TestBed.inject(HttpTestingController);
    auth = TestBed.inject(AuthService) as unknown as FakeAuthService;
  });

  afterEach(() => httpMock.verify());

  function failWith(url: string, status: number): HttpErrorResponse | undefined {
    let error: HttpErrorResponse | undefined;
    http.get(url).subscribe({ error: (e) => (error = e) });
    httpMock.expectOne(url).flush({ detail: 'nope' }, { status, statusText: 'Error' });
    return error;
  }

  it('treats a 401 from an owner-only call as an ended session', () => {
    auth.becomeOwner();

    const error = failWith('/api/campaigns', 401);

    expect(auth.markSessionExpired).toHaveBeenCalledTimes(1);
    expect(auth.mode()).toBe('anonymous');
    expect(error?.status).toBe(401); // the caller still sees the error
  });

  it('does not treat a rejected sign-in code (401 on /auth/*) as an ended session', () => {
    auth.becomeOwner();

    failWith('/api/auth/verify', 401);

    expect(auth.markSessionExpired).not.toHaveBeenCalled();
    expect(auth.mode()).toBe('owner');
  });

  it('ignores a 401 for an anonymous user', () => {
    failWith('/api/campaigns', 401);

    expect(auth.markSessionExpired).not.toHaveBeenCalled();
  });

  for (const status of [403, 404, 429, 500, 0]) {
    it(`ignores a ${status} even for an owner`, () => {
      auth.becomeOwner();

      failWith('/api/campaigns', status);

      expect(auth.markSessionExpired).not.toHaveBeenCalled();
    });
  }

  it('lets successful responses through untouched', () => {
    auth.becomeOwner();
    let body: unknown;

    http.get('/api/campaigns').subscribe((value) => (body = value));
    httpMock.expectOne('/api/campaigns').flush([{ id: 'a' }]);

    expect(body).toEqual([{ id: 'a' }]);
    expect(auth.markSessionExpired).not.toHaveBeenCalled();
  });
});
