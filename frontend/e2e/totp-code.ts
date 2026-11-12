import { createHmac } from 'node:crypto';

// An authenticator app, in Node. It is deliberately NOT a port of the server's Python: the end-to-end test
// is only worth something if the code it types in was produced by an independent implementation.
// (totp.spec.ts first checks this file against the RFC 6238 test vectors.)

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const PERIOD = 30; // seconds per step

/** RFC 4648 base32 to bytes. Spaces, hyphens and padding are ignored. */
export function base32Decode(text: string): Buffer {
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const character of text.replace(/[\s=-]/g, '').toUpperCase()) {
    const index = ALPHABET.indexOf(character);
    if (index < 0) {
      throw new Error('not base32');
    }
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >>> bits) & 0xff);
      buffer &= (1 << bits) - 1;
    }
  }
  return Buffer.from(bytes);
}

export function stepAt(unixMilliseconds: number): number {
  return Math.floor(unixMilliseconds / 1000 / PERIOD);
}

/** The 6-digit code an authenticator app shows for 30-second step number `step` (RFC 4226 / 6238, SHA-1). */
export function codeForStep(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(binary % 1_000_000).padStart(6, '0');
}

/** A well-formed code that is not valid now, nor one step either side of now. */
export function invalidCode(secret: string): string {
  const now = stepAt(Date.now());
  const valid = new Set([now - 1, now, now + 1].map((step) => codeForStep(secret, step)));
  return ['000000', '111111', '222222', '333333'].find((candidate) => !valid.has(candidate)) as string;
}

// The server accepts each step once, and only the current step and one either side of it. This spec signs in
// several times, so it keeps track of the steps it has used: a fresh code is the next unused step, and when
// both acceptable steps are spent it waits for the clock to move on.
let lastUsedStep = -1;

/** Records that a code for `step` was submitted by some other route (e.g. the "Fill code (dev)" button). */
export function markStepUsed(step: number): void {
  lastUsedStep = Math.max(lastUsedStep, step);
}

/** A code the server has not seen yet, claimed so the next call will not hand out the same step. */
export async function claimFreshCode(secret: string): Promise<string> {
  for (;;) {
    const current = stepAt(Date.now());
    const step = Math.max(current, lastUsedStep + 1);
    if (step <= current + 1) {
      lastUsedStep = step;
      return codeForStep(secret, step);
    }
    await new Promise((resolve) => setTimeout(resolve, 500)); // until the next 30-second step begins
  }
}
