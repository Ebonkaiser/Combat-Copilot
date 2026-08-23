// Relative path: nginx serves this build and the backend from the same
// origin (reverse-proxying /api/ to the backend inside the same container),
// so no absolute host:port needs to be baked in at build time.
export const environment = {
  production: true,
  apiUrl: '/api',
};
