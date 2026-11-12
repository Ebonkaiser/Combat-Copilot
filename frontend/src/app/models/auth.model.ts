export type Mode = 'anonymous' | 'owner';

/**
 * How the owner proves who they are: `email` (a 6-digit code is emailed after typing the address) or `totp`
 * (the 6-digit code from an authenticator app; nothing is sent, so the form asks for nothing else).
 */
export type LoginMethod = 'email' | 'totp';

/** GET /auth/me */
export interface AuthMe {
  mode: Mode;
  email?: string;
  /** False when the server has no owner configured: the sign-in control is hidden. */
  owner_login_enabled: boolean;
  /** Absent on a server that predates authenticator sign-in: treated as `email`. */
  login_method?: LoginMethod;
  /** True only for a development server that can hand out a sign-in code: enables "Fill code (dev)". */
  dev?: boolean;
}
