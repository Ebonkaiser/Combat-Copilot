export type Mode = 'anonymous' | 'owner';

/** GET /auth/me */
export interface AuthMe {
  mode: Mode;
  email?: string;
  /** False when the server has no owner configured: the sign-in control is hidden. */
  owner_login_enabled: boolean;
  /** True only for a development server with the console email provider: enables "Fill code (dev)". */
  dev?: boolean;
}
