// Q15 — the persisted spend ledger, end to end through the REAL composition: the ledger is
// built only when the operator configured it (LEDGER-1), a real send persists its price
// (LEDGER-2), a hard daily cap refuses before anything is sent or charged (LEDGER-3), and a
// dry run quotes against the ledger without writing to it (LEDGER-9). The store is the
// in-memory `overrides.ledgerStore` seam; the network is the undici MockAgent.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { parseConfig } from '../../src/core/config.js';
import type { LedgerEntry, LedgerStore } from '../../src/core/ledger.js';
import { composeServer } from '../../src/mcp/compose.js';
import type { Composition } from '../../src/mcp/compose.js';
import { loadFixture, mockHttp, userContextEnv, userTokenStore } from '../helpers/index.js';
import type { MockHttp } from '../helpers/index.js';

/** A shared in-memory "file": every store over the same array sees every append. */
function memStore(lines: LedgerEntry[]): LedgerStore & { readonly appends: () => number } {
  let offset = 0;
  let appends = 0;
  return {
    readNew: () => {
      const entries = lines.slice(offset);
      offset = lines.length;
      return { reset: false, entries };
    },
    append: (entry) => {
      appends += 1;
      lines.push(entry);
    },
    appends: () => appends,
  };
}

interface Harness {
  readonly client: Client;
  readonly composition: Composition;
  readonly mock: MockHttp;
  close(): Promise<void>;
}

async function harness(env: Record<string, string>, store?: LedgerStore): Promise<Harness> {
  const mock = mockHttp();
  const composition = composeServer(
    parseConfig(
      userContextEnv({ X_MCP_POLICY: 'publish', X_MCP_POLICY_ALLOW: 'write:dm', ...env }),
    ),
    {
      dispatcher: mock.dispatcher,
      tokens: userTokenStore(),
      ...(store !== undefined ? { ledgerStore: store } : {}),
    },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'spend-ledger-test', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), composition.server.connect(serverTransport)]);
  await client.listTools();
  return {
    client,
    composition,
    mock,
    close: async () => {
      mock.assertDone();
      await client.close();
      await mock.close();
    },
  };
}

async function sendDm(client: Client, dryRun = false): Promise<CallToolResult> {
  return (await client.callTool({
    name: 'x_dm_send',
    arguments: { participant: '777', text: 'hello', ...(dryRun ? { dry_run: true } : {}) },
  })) as CallToolResult;
}

function text(result: CallToolResult): string {
  const block = result.content[0];
  assert.ok(block !== undefined && block.type === 'text');
  return block.text;
}

function interceptDm(mock: MockHttp): void {
  mock.pool
    .intercept({
      path: '/2/dm_conversations/with/777/messages',
      method: 'POST',
      body: '{"text":"hello"}',
    })
    .reply(201, loadFixture<Record<string, unknown>>('dm/send-created.json'));
}

const today = (): number => Date.now();

test('LEDGER-1: without any ledger variable the composition never touches a ledger store', async () => {
  const lines: LedgerEntry[] = [];
  const store = memStore(lines);
  const h = await harness({}, store);
  interceptDm(h.mock);
  const result = await sendDm(h.client);
  assert.notEqual(result.isError, true, text(result));
  assert.equal(h.composition.budget.total(), 0.015);
  assert.equal(store.appends(), 0);
  await h.close();
});

test('LEDGER-2: a real send persists the same price the session budget charged', async () => {
  const lines: LedgerEntry[] = [];
  const h = await harness({ X_MCP_DAILY_BUDGET: '5' }, memStore(lines));
  interceptDm(h.mock);
  const result = await sendDm(h.client);
  assert.notEqual(result.isError, true, text(result));
  assert.equal(h.composition.budget.total(), 0.015);
  assert.equal(
    lines.reduce((acc, l) => acc + l.usd, 0),
    0.015,
  );
  await h.close();
});

test('LEDGER-3: a hard daily cap already reached refuses locally — nothing sent or charged', async () => {
  const lines: LedgerEntry[] = [{ at: today(), usd: 0.995 }];
  const store = memStore(lines);
  const h = await harness({ X_MCP_DAILY_BUDGET: '1', X_MCP_BUDGET_MODE: 'hard' }, store);
  const result = await sendDm(h.client); // no interceptor: a request would fail loudly
  assert.equal(result.isError, true);
  const error = (JSON.parse(text(result)) as { error: { kind: string; message: string } }).error;
  assert.equal(error.kind, 'budget');
  assert.match(error.message, /over the daily budget of \$1/);
  assert.equal(h.composition.budget.total(), 0);
  assert.equal(store.appends(), 0);
  await h.close();
});

test('LEDGER-9: a dry run is refused by the same hard cap and writes nothing either way', async () => {
  const lines: LedgerEntry[] = [{ at: today(), usd: 0.995 }];
  const store = memStore(lines);
  const hard = await harness({ X_MCP_DAILY_BUDGET: '1', X_MCP_BUDGET_MODE: 'hard' }, store);
  const refused = await sendDm(hard.client, true);
  assert.equal(refused.isError, true);
  await hard.close();

  // A second process over the same file: its own store (own read offset), same lines.
  const second = memStore(lines);
  const warn = await harness({ X_MCP_DAILY_BUDGET: '1' }, second);
  const quoted = await sendDm(warn.client, true);
  assert.notEqual(quoted.isError, true, text(quoted));
  assert.match(
    text(quoted),
    /"budget_warning":"Persisted daily spend \$1\.01 .*has exceeded the operator-set daily budget of \$1/,
  );
  await warn.close();
  assert.equal(store.appends() + second.appends(), 0);
  assert.equal(lines.length, 1);
});
