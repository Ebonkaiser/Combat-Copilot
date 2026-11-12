// Test-only constants shared by playwright.config.ts and the specs that run against the second stack.
//
// Two isolated stacks run side by side, because the sign-in method is a property of the whole backend:
//   email stack          web 4210 -> api 8010   sign-in by an emailed code (modes.spec.ts, theme-contrast.spec.ts)
//   authenticator stack  web 4211 -> api 8011   sign-in by an authenticator-app code (totp.spec.ts)

export const TOTP_API_PORT = 8011;
export const TOTP_WEB_PORT = 4211;

// Base32 of "12345678901234567890": the key behind the RFC 6238 test vectors. Never used anywhere real.
export const TOTP_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
