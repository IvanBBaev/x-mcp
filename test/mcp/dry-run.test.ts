// Q14 — `dry_run` on the send tools, end to end through the REAL composition: the real
// policy, credential, rate-limit and budget gates, the real token store wiring and the SDK
// client (which validates every structuredContent against the served outputSchema). A dry
// run must preview exactly what a real call would send, quote its price with the same
// hard-mode refusal, and send, charge and load nothing (docs/07 DRY-1..DRY-5).

import test from 'node:test';
import assert from 'node:assert/strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { parseConfig } from '../../src/core/config.js';
import { composeServer } from '../../src/mcp/compose.js';
import type { Composition } from '../../src/mcp/compose.js';
import { mockHttp, userContextEnv, userTokenStore } from '../helpers/index.js';
import type { InMemoryTokenStore, MockHttp } from '../helpers/index.js';

/** The dry-run payload (`data`) every previewable tool returns. */
interface DryRunData {
  readonly dry_run: true;
  readonly requests: readonly {
    readonly method: string;
    readonly path: string;
    readonly query?: Record<string, string>;
    readonly body?: unknown;
  }[];
  readonly cost_usd: number;
  readonly session_total_usd: number;
  readonly budget_warning?: string;
  readonly note?: string;
}

interface Rendered<T> {
  readonly data: T;
  readonly summary?: string;
  readonly meta: { readonly cost_usd: number; readonly session_total_usd: number };
}

interface Harness {
  readonly client: Client;
  readonly composition: Composition;
  readonly tokens: InMemoryTokenStore;
  readonly mock: MockHttp;
  close(): Promise<void>;
}

/** A user-context composition that may publish and DM, with no interceptor queued. */
async function harness(extraEnv: Record<string, string> = {}): Promise<Harness> {
  const mock = mockHttp();
  const tokens = userTokenStore();
  const composition = composeServer(
    parseConfig(
      userContextEnv({ X_MCP_POLICY: 'publish', X_MCP_POLICY_ALLOW: 'write:dm', ...extraEnv }),
    ),
    { dispatcher: mock.dispatcher, tokens },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'dry-run-test', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), composition.server.connect(serverTransport)]);
  // The SDK client validates structuredContent against a tool's outputSchema only once it
  // has listed the tools, so list first: every dry run below is schema-checked by the SDK.
  await client.listTools();
  return {
    client,
    composition,
    tokens,
    mock,
    close: async () => {
      // No interceptor was queued, so any request that left the process failed loudly;
      // assertDone also proves none is left pending.
      mock.assertDone();
      await client.close();
      await mock.close();
    },
  };
}

async function call(client: Client, name: string, args: object): Promise<CallToolResult> {
  return (await client.callTool({
    name,
    arguments: args as Record<string, unknown>,
  })) as CallToolResult;
}

function payload<T>(result: CallToolResult): Rendered<T> {
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
  // REND-11: the text block and structuredContent are the same render object.
  const block = result.content[0];
  assert.ok(block !== undefined && block.type === 'text');
  const parsed = JSON.parse(block.text) as Rendered<T>;
  assert.deepEqual(result.structuredContent, parsed);
  return parsed;
}

function errorKind(result: CallToolResult): string {
  assert.equal(result.isError, true);
  const block = result.content[0];
  assert.ok(block !== undefined && block.type === 'text');
  return (JSON.parse(block.text) as { error: { kind: string } }).error.kind;
}

test('DRY-1: x_post_create dry run returns the exact POST /2/tweets body and the URL price', async () => {
  const h = await harness();
  const loadsBefore = h.tokens.loadCount();
  const out = payload<DryRunData>(
    await call(h.client, 'x_post_create', {
      text: 'read https://example.com',
      reply_to_id: 'https://x.com/someone/status/1234567890',
      reply_settings: 'following',
      dry_run: true,
    }),
  );
  assert.deepEqual(out.data.requests, [
    {
      method: 'POST',
      path: '/2/tweets',
      body: {
        text: 'read https://example.com',
        reply: { in_reply_to_tweet_id: '1234567890' }, // the status URL normalized to its id
        reply_settings: 'following',
      },
    },
  ]);
  assert.equal(out.data.dry_run, true);
  assert.equal(out.data.cost_usd, 0.2); // COST-4: a URL post is quoted at the URL rate
  assert.equal(out.data.session_total_usd, 0.2);
  assert.match(out.data.note ?? '', /URL/);
  assert.match(out.summary ?? '', /nothing sent or charged; a real call would cost \$0\.2\./);
  assert.deepEqual(out.meta, { cost_usd: 0, session_total_usd: 0 });
  // DRY-5: no token was loaded or refreshed — the invoker was never reached.
  assert.equal(h.tokens.loadCount(), loadsBefore);
  assert.equal(h.tokens.persistCount(), 0);
  await h.close();
});

test('DRY-2: a dry run moves no ledger — the session budget stays at $0', async () => {
  const h = await harness();
  payload<DryRunData>(await call(h.client, 'x_post_create', { text: 'hello', dry_run: true }));
  payload<DryRunData>(
    await call(h.client, 'x_dm_send', { participant: '777', text: 'hi', dry_run: true }),
  );
  assert.equal(h.composition.budget.total(), 0);
  await h.close();
});

test('DRY-1: x_thread_create dry run previews one request per post with parent placeholders', async () => {
  const h = await harness();
  const out = payload<DryRunData>(
    await call(h.client, 'x_thread_create', {
      posts: ['one', 'two https://example.com', 'three'],
      reply_to_id: '1111111111',
      dry_run: true,
    }),
  );
  assert.deepEqual(
    out.data.requests.map((r) => r.body),
    [
      { text: 'one', reply: { in_reply_to_tweet_id: '1111111111' } },
      { text: 'two https://example.com', reply: { in_reply_to_tweet_id: '<id of post 1>' } },
      { text: 'three', reply: { in_reply_to_tweet_id: '<id of post 2>' } },
    ],
  );
  assert.equal(out.data.cost_usd, 0.23); // 0.015 + 0.20 (URL) + 0.015, priced per post
  assert.match(out.data.note ?? '', /<id of post k>/);
  assert.match(out.data.note ?? '', /charged upfront/); // the cost note rides along
  assert.match(out.summary ?? '', /^Dry run: 3 requests previewed/);
  await h.close();
});

test('DRY-1: x_dm_send dry run previews the exact path for a conversation and a numeric id', async () => {
  const h = await harness();
  const conv = payload<DryRunData>(
    await call(h.client, 'x_dm_send', { conversation_id: ' 9-777 ', text: 'hi', dry_run: true }),
  );
  assert.deepEqual(conv.data.requests, [
    { method: 'POST', path: '/2/dm_conversations/9-777/messages', body: { text: 'hi' } },
  ]);
  assert.equal(conv.data.cost_usd, 0.015);
  assert.equal(conv.data.note, undefined);

  const direct = payload<DryRunData>(
    await call(h.client, 'x_dm_send', { participant: '777', text: 'hi', dry_run: true }),
  );
  assert.deepEqual(direct.data.requests, [
    { method: 'POST', path: '/2/dm_conversations/with/777/messages', body: { text: 'hi' } },
  ]);
  await h.close();
});

test('DRY-1: an unresolved @handle DM target is a placeholder — the dry run makes no lookup', async () => {
  const h = await harness();
  const out = payload<DryRunData>(
    await call(h.client, 'x_dm_send', { participant: '@Alice', text: 'hi', dry_run: true }),
  );
  assert.equal(out.data.requests.length, 1);
  assert.equal(out.data.requests[0]?.path, '/2/dm_conversations/with/<id of @Alice>/messages');
  assert.match(out.data.note ?? '', /GET \/2\/users\/by\/username/);
  await h.close();
});

test('DRY-1: a @handle the process already resolved previews its real id', async () => {
  const h = await harness();
  // The handle → id memo is filled by any earlier lookup in this process.
  h.composition.resolver.cache.set({ id: '4242', handle: 'alice' });
  const out = payload<DryRunData>(
    await call(h.client, 'x_dm_send', { participant: 'alice', text: 'hi', dry_run: true }),
  );
  assert.equal(out.data.requests[0]?.path, '/2/dm_conversations/with/4242/messages');
  assert.equal(out.data.note, undefined);
  await h.close();
});

test('DRY-3: a hard budget refuses the dry run with the same typed budget error', async () => {
  const h = await harness({ X_MCP_CREDIT_BUDGET: '0.1', X_MCP_BUDGET_MODE: 'hard' });
  assert.equal(
    errorKind(
      await call(h.client, 'x_post_create', { text: 'see https://example.com', dry_run: true }),
    ),
    'budget',
  );
  // A dry run that fits is still quoted — with the warning the real call would get.
  const near = payload<DryRunData>(
    await call(h.client, 'x_thread_create', {
      posts: ['a', 'b', 'c', 'd', 'e', 'f'],
      dry_run: true,
    }),
  );
  assert.equal(near.data.cost_usd, 0.09);
  assert.match(near.data.budget_warning ?? '', /90%/);
  await h.close();
});

test('DRY-3: policy and schema refusals are unchanged by dry_run', async () => {
  const h = await harness({ X_MCP_POLICY: 'read-only', X_MCP_POLICY_ALLOW: '' });
  assert.equal(
    errorKind(await call(h.client, 'x_post_create', { text: 'hi', dry_run: true })),
    'policy',
  );
  assert.equal(
    errorKind(await call(h.client, 'x_post_create', { text: '', dry_run: true })),
    'validation',
  );
  await h.close();
});
