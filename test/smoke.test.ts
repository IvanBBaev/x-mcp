// Smoke test for the Wave-C keystones (T-101/102/103). It proves the frozen contracts
// compile and behave, and that the harness can stub the real global-fetch network path.
// Wave-1 agents build real tests on top of these helpers; this file must stay green.

import test from 'node:test';
import assert from 'node:assert/strict';

import { XError, authError, rateLimitError, policyError } from '../src/core/errors.js';
import { POLICY_CELLS, COST_CLASSES, defineTool } from '../src/core/tooldef.js';
import type { CostEstimate } from '../src/core/tooldef.js';
import { ZERO_RESULTS_NOTE } from '../src/core/render-shapes.js';
import type { Page, CompactPost } from '../src/core/render-shapes.js';
import { z } from 'zod';

import {
  fakeClock,
  fakeSleep,
  fakeRandom,
  inMemoryTokenStore,
  makePorts,
} from './helpers/index.js';
import { mockHttp, X_API_ORIGIN } from './helpers/index.js';

test('error taxonomy applies per-class defaults', () => {
  const rl = rateLimitError('Rate limit hit; retry after the window resets.', {
    data: { retry_after_seconds: 30 },
  });
  assert.equal(rl.kind, 'rate-limit');
  assert.equal(rl.retryable, true);
  assert.equal(rl.fix, 'agent');

  const auth = authError('No valid credentials; run `x-mcp-ai authorize`.');
  assert.equal(auth.retryable, false);
  assert.equal(auth.fix, 'operator');

  // policy defaults to operator-fixable, non-retryable.
  const pol = policyError('This operation is disabled by the active policy.');
  assert.equal(pol.fix, 'operator');
  assert.equal(pol.retryable, false);
});

test('XError.is guards across unknown boundaries and toPayload is agent-safe', () => {
  const err: unknown = rateLimitError('slow down', { data: { retry_after_seconds: 5 } });
  assert.ok(XError.is(err));
  const payload = err.toPayload();
  assert.deepEqual(payload, {
    error: {
      kind: 'rate-limit',
      message: 'slow down',
      retryable: true,
      fix: 'agent',
      retry_after_seconds: 5,
    },
  });
  // No cause/stack leak into the payload.
  assert.equal(Object.hasOwn(payload.error, 'cause'), false);
});

test('fake clock and sleep are deterministic and coupled', async () => {
  const clock = fakeClock(1000);
  const sleep = fakeSleep(clock);
  assert.equal(clock.now(), 1000);
  await sleep.fn(250);
  assert.equal(clock.now(), 1250);
  assert.deepEqual(sleep.calls, [250]);
});

test('fake random is repeatable', () => {
  const r = fakeRandom([0.1, 0.9]);
  assert.equal(r.float(), 0.1);
  assert.equal(r.float(), 0.9);
  assert.equal(r.float(), 0.1); // cycles
  assert.match(r.uuid(), /^00000000-0000-4000-8000-[0-9a-f]{12}$/);
  assert.equal(r.bytes(3).length, 3);
});

test('in-memory token store persists and serializes refreshes single-flight', async () => {
  const store = inMemoryTokenStore(null);
  assert.equal(await store.load(), null);
  await store.persist({ access_token: 'a', obtained_at: 0, expires_in: 7200 });
  const loaded = await store.load();
  assert.equal(loaded?.access_token, 'a');

  // Two lock holders must not interleave: the order is strictly serial.
  const order: string[] = [];
  const first = store.withLock(async () => {
    order.push('start-1');
    await Promise.resolve();
    order.push('end-1');
  });
  const second = store.withLock(() => {
    order.push('start-2');
    order.push('end-2');
    return Promise.resolve();
  });
  await Promise.all([first, second]);
  assert.deepEqual(order, ['start-1', 'end-1', 'start-2', 'end-2']);
});

test('makePorts wires a coherent bundle', () => {
  const ports = makePorts();
  assert.equal(typeof ports.clock.now(), 'number');
  assert.equal(typeof ports.random.uuid(), 'string');
});

test('defineTool infers input type and carries a valid policy + cost class', () => {
  const tool = defineTool({
    name: 'x_post_get',
    title: 'Get a post',
    description: 'Fetch a single post by id.',
    policy: 'read:content',
    availability: 'app+user',
    scopes: ['tweet.read'],
    cost: 'r:post',
    annotations: { title: 'Get a post', readOnlyHint: true },
    input: z.object({ id: z.string() }),
    phase: 1,
    handler: (input) => Promise.resolve({ data: { id: input.id } }),
  });
  assert.ok(POLICY_CELLS.includes(tool.policy));
  assert.ok(COST_CLASSES.includes(tool.cost as (typeof COST_CLASSES)[number]));
  assert.equal(tool.name, 'x_post_get');
});

test('cost resolver overrides USD for the URL-post case', () => {
  const resolve = (input: { text: string }): CostEstimate =>
    /https?:\/\//.test(input.text) ? { class: 'w:post', usd: 0.2 } : { class: 'w:post' };
  assert.deepEqual(resolve({ text: 'hello' }), { class: 'w:post' });
  assert.deepEqual(resolve({ text: 'see https://x.com' }), { class: 'w:post', usd: 0.2 });
});

test('Page envelope models zero results explicitly', () => {
  const empty: Page<CompactPost> = { items: [], result_count: 0, note: ZERO_RESULTS_NOTE };
  assert.equal(empty.result_count, 0);
  assert.equal(empty.note, 'No results matched this query.');
});

test('mockHttp stubs the real global-fetch path via the injected dispatcher', async () => {
  const http = mockHttp();
  http.pool
    .intercept({ path: '/2/tweets/1', method: 'GET' })
    .reply(200, { data: { id: '1', text: 'hi' } });

  const res = await fetch(`${X_API_ORIGIN}/2/tweets/1`, { dispatcher: http.dispatcher });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { data: { id: string } };
  assert.equal(body.data.id, '1');

  http.assertDone();
  await http.close();
});
