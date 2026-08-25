// T-206 driver: one REAL x-mcp-ai token-manager process for the CONC-4 two-process
// interleaved-refresh test. The parent test spawns two of these over one shared token
// file; each builds the production stack (file store → refresh machine → fetch-based
// RefreshHttp against the parent's stubbed token endpoint) with a REAL clock and REAL
// sleeps, so the cross-process file lock and the reload-under-lock/adopt step are
// exercised for real.
//
// Protocol (line-oriented, over stdio):
//   argv: <tokenFile> <tokenEndpointBaseUrl> <clientId>
//   stdout: "READY"            — stack constructed, waiting for the start barrier
//   stdin:  "GO"               — the parent releases both children at once
//   stdout: "RESULT {json}"    — {token, state} after getAccessToken() resolved; exit 0
//   stdout: "ERROR {json}"     — {message} when getAccessToken() rejected; exit 1

import { createInterface } from 'node:readline';

import { createFileTokenStore } from '../../../../src/api/oauth2/filestore.js';
import { createRefreshMachine } from '../../../../src/api/oauth2/machine.js';
import { createFetchRefreshHttp } from '../../../../src/api/oauth2/index.js';
import type { Clock, Sleep } from '../../../../src/core/ports.js';

function requireArg(index: number, name: string): string {
  const value = process.argv[index];
  if (value === undefined || value === '') {
    process.stderr.write(`refresh-child: missing required argv <${name}>\n`);
    process.exit(2);
  }
  return value;
}

/** Block until the parent writes the "GO" barrier line on stdin. */
async function waitForGo(): Promise<void> {
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    if (line.trim() === 'GO') {
      rl.close();
      return;
    }
  }
  throw new Error('stdin closed before the GO barrier arrived');
}

async function main(): Promise<void> {
  const tokenFile = requireArg(2, 'tokenFile');
  const baseUrl = requireArg(3, 'tokenEndpointBaseUrl');
  const clientId = requireArg(4, 'clientId');

  // Real time and real waiting: this process must contend for the lock like production.
  const clock: Clock = { now: () => Date.now() };
  const sleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const store = createFileTokenStore({
    path: tokenFile,
    clock,
    sleep,
    warn: (message) => process.stderr.write(`${message}\n`),
  });
  const machine = createRefreshMachine({
    clock,
    store,
    refreshHttp: createFetchRefreshHttp({ baseUrl, clientId }),
  });

  process.stdout.write('READY\n');
  await waitForGo();

  const token = await machine.getAccessToken();
  // Exit from the write callback so the pipe is provably flushed before death: a
  // process.exit() racing buffered stdout is a classic cross-platform flake source.
  process.stdout.write(`RESULT ${JSON.stringify({ token, state: machine.state() })}\n`, () => {
    process.exit(0);
  });
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stdout.write(`ERROR ${JSON.stringify({ message })}\n`, () => {
    process.exit(1);
  });
});
