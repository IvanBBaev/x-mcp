// T-206 driver: a REAL process that acquires the cross-process refresh lock through the
// production file store and then parks forever, so the parent test can exercise the
// AUTH-5/AUTH-7 protocol against a genuinely live (and later genuinely dead) holder PID.
//
// The injected clock offset backdates this process's view of "now", so the lock it
// writes carries a timestamp that already sits past the LOCK_STALE_MS line from the
// parent's real-clock perspective — the ONLY way to age a lock without editing frozen
// timing constants, and exactly what the filestore's injectable Clock seam is for.
//
// When a token-endpoint base URL is given (anything but "-"), the child POSTs one
// refresh to it while holding the lock BEFORE signalling — modelling the kill-9 corner:
// the rotation is already spent server-side, the lock is held, and the process dies
// (SIGKILL from the parent) before the pair is ever persisted.
//
// Protocol (line-oriented, over stdio):
//   argv: <tokenFile> <clockOffsetMs> <tokenEndpointBaseUrl | "-">
//   stdout: "LOCKED"  — lock held (and the refresh POST completed, if requested);
//                       the process now hangs until the parent SIGKILLs it.

import { createFileTokenStore } from '../../../../src/api/oauth2/filestore.js';
import type { Sleep } from '../../../../src/core/ports.js';

function requireArg(index: number, name: string): string {
  const value = process.argv[index];
  if (value === undefined || value === '') {
    process.stderr.write(`lock-holder-child: missing required argv <${name}>\n`);
    process.exit(2);
  }
  return value;
}

async function main(): Promise<void> {
  const tokenFile = requireArg(2, 'tokenFile');
  const clockOffsetMs = Number(requireArg(3, 'clockOffsetMs'));
  const endpoint = requireArg(4, 'tokenEndpointBaseUrl');
  if (!Number.isFinite(clockOffsetMs)) {
    process.stderr.write('lock-holder-child: <clockOffsetMs> must be a finite number\n');
    process.exit(2);
  }

  const sleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const store = createFileTokenStore({
    path: tokenFile,
    clock: { now: () => Date.now() + clockOffsetMs },
    sleep,
    warn: (message) => process.stderr.write(`${message}\n`),
  });

  // The open stdin pipe keeps the event loop alive while we hang under the lock.
  process.stdin.resume();

  await store.withLock(async () => {
    if (endpoint !== '-') {
      // The "refresh already happened" half of the kill-9 scenario: spend the rotation
      // at the (stubbed) token endpoint, then die before persisting it.
      const response = await fetch(new URL('/2/oauth2/token', endpoint), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: 'refresh-initial',
          client_id: 'doomed-child',
        }).toString(),
      });
      await response.text(); // drain; the response is deliberately never persisted
    }
    process.stdout.write('LOCKED\n');
    await new Promise<never>(() => undefined); // park forever — SIGKILL is the only exit
  });
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`lock-holder-child failed: ${message}\n`);
  process.exit(1);
});
