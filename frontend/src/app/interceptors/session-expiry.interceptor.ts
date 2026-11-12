import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, throwError } from 'rxjs';
import { AuthService } from '../services/auth.service';

/**
 * A 401 from an owner-only call means the owner's session is gone (expired, or the
 * cookie was cleared): treat the user as anonymous and let the UI prompt for sign-in.
 *
 * /auth/* is exempt -- a wrong sign-in code is also a 401, and it is not a lost session.
 * Anonymous users never reach an owner-only call, so a 401 for them is ignored.
 */
export const sessionExpiryInterceptor: HttpInterceptorFn = (request, next) => {
  const auth = inject(AuthService);
  return next(request).pipe(
    catchError((error: unknown) => {
      if (
        error instanceof HttpErrorResponse &&
        error.status === 401 &&
        auth.mode() === 'owner' &&
        !request.url.includes('/auth/')
      ) {
        auth.markSessionExpired();
      }
      return throwError(() => error);
    }),
  );
};
