// Relative path, same as production: in development `ng serve` proxies /api to
// the FastAPI backend (see proxy.conf.json), so the browser only ever talks to
// ONE origin and the session cookie is a plain same-origin cookie.
export const environment = {
  production: false,
  apiUrl: '/api',
};
