import { defineConfig } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// End-to-end + accessibility (axe) tests. They drive the real Angular app against
// the real FastAPI backend, using the Chrome that is already installed
// (channel: 'chrome') -- no Playwright browser download needed, and GitHub's
// ubuntu runners ship Chrome as well.
//
// The stack is hermetic and isolated:
//  - its own ports, so it never attaches to a developer's `ng serve` / uvicorn;
//  - FAKE_AI=1: an offline echo "narrator" and hashing embeddings, so no Gemini key
//    is needed (GOOGLE_API_KEY is blanked to prove it) and the narration text shows
//    exactly which lore reached the model;
//  - the synthetic fixture campaign (tests/fixtures/campaigns), never real content;
//  - a throwaway database and vector store in the OS temp directory.
const API_PORT = 8010;
const WEB_PORT = 4210;
const OWNER_EMAIL = 'owner@example.test'; // keep in step with e2e/helpers.ts

const scratch = join(tmpdir(), `combat-copilot-e2e-${Date.now()}`);
mkdirSync(scratch, { recursive: true });

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    channel: 'chrome',
    headless: true,
    viewport: { width: 1280, height: 800 },
  },
  webServer: [
    {
      command: `python -m uvicorn server:app --host 127.0.0.1 --port ${API_PORT}`,
      cwd: '..',
      // Waits for HTTP 200, i.e. until the knowledge base has finished loading.
      url: `http://127.0.0.1:${API_PORT}/health`,
      reuseExistingServer: !process.env['CI'],
      timeout: 180_000,
      env: {
        ENV: 'development',
        FAKE_AI: '1',
        OWNER_EMAILS: OWNER_EMAIL,
        SESSION_SECRET: 'e2e-only-session-secret-0123456789abcdef',
        ALLOWED_ORIGINS: `http://localhost:${WEB_PORT}`,
        CAMPAIGNS_DIR: './tests/fixtures/campaigns',
        STATE_DB_PATH: join(scratch, 'state.db'),
        CHROMA_DIR: join(scratch, 'chroma'),
        GOOGLE_API_KEY: '',
      },
    },
    {
      command: `npx ng serve --port ${WEB_PORT} --proxy-config proxy.e2e.conf.json`,
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: !process.env['CI'],
      timeout: 180_000,
    },
  ],
});
