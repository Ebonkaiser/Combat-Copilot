import {
  ApplicationConfig,
  PLATFORM_ID,
  inject,
  provideAppInitializer,
  provideZoneChangeDetection,
} from '@angular/core';
import { isPlatformServer } from '@angular/common';
import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { sessionExpiryInterceptor } from './interceptors/session-expiry.interceptor';
import { AuthService } from './services/auth.service';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideHttpClient(withFetch(), withInterceptors([sessionExpiryInterceptor])),
    // Learn who is using the app before the first render, so a signed-in owner never
    // flashes the anonymous header. Capped by load()'s own timeout and never fails.
    // The build-time prerender has no backend (and no cookie) to ask: anonymous is right there.
    provideAppInitializer(() => {
      if (isPlatformServer(inject(PLATFORM_ID))) {
        return Promise.resolve();
      }
      return firstValueFrom(inject(AuthService).load()).then(() => undefined);
    }),
  ],
};
