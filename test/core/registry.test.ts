// Tests for core/registry.ts (T-113): the registry-as-data + the single request-pipeline
// choke point. The real policy/budget/rate-limit modules are built by sibling tasks, so
// everything here is exercised through FAKE gates declared in this file — the same
// collaborator interfaces the integrator wires the real modules into.
//
// Required corner cases are named/commented by ID: POL-1, POL-5, POL-7 (docs/04 §3.3),
// and MCP-4 (docs/07).

import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import { createRegistry, deriveAnnotations, withCallSignal } from '../../src/core/registry.js';
import type {
  BudgetGate,
  BudgetReservation,
  CallContext,
  PolicyGate,
  RateLimitGate,
  RegistryDeps,
} from '../../src/core/registry.js';
import { XError, budgetError, policyError, rateLimitError } from '../../src/core/errors.js';
import type {
  AnyToolDef,
  CostEstimate,
  CostSpec,
  EndpointInvoker,
  PolicyClass,
  ToolAnnotations,
  ToolContext,
  ToolHandler,
  XApiRequest,
} from '../../src/core/tooldef.js';
import { makePorts } from '../helpers/index.js';

// --- Fixtures & fakes ----------------------------------------------------------------

function makeTool(props: {
  name: string;
  policy: PolicyClass;
  description?: string;
  cost?: CostSpec<unknown>;
  input?: z.ZodType<unknown>;
  handler?: ToolHandler<unknown>;
  annotations?: ToolAnnotations;
}): AnyToolDef {
  return {
    name: props.name,
    title: props.name,
    description: props.description ?? `desc ${props.name}`,
    policy: props.policy,
    availability: 'app+user',
    scopes: [],
    cost: props.cost ?? 'local',
    annotations: props.annotations ?? { title: props.name },
    input: props.input ?? z.object({}),
    phase: 1,
    handler: props.handler ?? (() => Promise.resolve({ data: { ok: true } })),
  };
}

const fakeHttp: EndpointInvoker = {
  send: () => Promise.reject(new Error('no HTTP in registry tests')),
};

function fakePolicy(
  over: Partial<{
    isAllowed: (tool: AnyToolDef) => boolean;
    preset: string;
    hideDenied: boolean;
  }> = {},
): PolicyGate {
  return {
    preset: over.preset ?? 'read-only',
    hideDenied: over.hideDenied ?? false,
    isAllowed: over.isAllowed ?? (() => true),
    denyError: (tool) => {
      const cell = tool.policy;
      // POL-7 / SEC-F10, as narrowed by T-320 F2: a denial NAMES the blocked cell and never
      // the unlock env var — for every cell, sensitive or not. This fake used to branch on
      // sensitivity because the real `deniedToolError` did; it no longer does, and a fake that
      // kept the branch would let a regression in the real one pass unnoticed here.
      return policyError(`Blocked by policy: the "${cell}" capability is disabled.`, {
        data: { cell },
      });
    },
  };
}

function fakeBudget(
  over: Partial<{ reservation: BudgetReservation; checkError: XError }> = {},
): BudgetGate {
  return {
    check: () => {
      if (over.checkError) throw over.checkError;
    },
    reserve: () => over.reservation ?? { cost_usd: 0.005, session_total_usd: 0.005 },
  };
}

function fakeRateLimit(error?: XError): RateLimitGate {
  return {
    preflight: () => {
      if (error) throw error;
    },
  };
}

function deps(over: Partial<RegistryDeps> = {}): RegistryDeps {
  return {
    policy: over.policy ?? fakePolicy(),
    budget: over.budget ?? fakeBudget(),
    rateLimit: over.rateLimit ?? fakeRateLimit(),
  };
}

function callCtx(over: Partial<CallContext> = {}): CallContext {
  return { ports: makePorts(), http: fakeHttp, ...over };
}

/** Await a promise expected to reject with an XError and return it for inspection. */
async function rejected(p: Promise<unknown>): Promise<XError> {
  let caught: unknown;
  let threw = false;
  try {
    await p;
  } catch (err) {
    threw = true;
    caught = err;
  }
  assert.ok(threw, 'expected the call to reject');
  assert.ok(XError.is(caught), `expected an XError, got ${String(caught)}`);
  return caught;
}

// --- Registry-as-data ----------------------------------------------------------------

test('POL-1: registry-as-data — lookup/size, duplicate-name and unknown-cell guards fail structurally', () => {
  const a = makeTool({ name: 'x_post_get', policy: 'read:content' });
  const b = makeTool({ name: 'x_post_create', policy: 'write:content' });
  const reg = createRegistry([a, b], deps());

  assert.equal(reg.size, 2);
  assert.equal(reg.get('x_post_get'), a);
  assert.equal(reg.get('missing'), undefined);
  assert.deepEqual(
    reg.all().map((t) => t.name),
    ['x_post_get', 'x_post_create'],
  );

  // A duplicate name is a wiring bug surfaced at construction, never at call time.
  assert.throws(() => createRegistry([a, a], deps()), /duplicate tool name/);

  // POL-1: a tool "missing classification" (an invalid policy cell) cannot register.
  const bad = makeTool({ name: 'x_bad', policy: 'read:nonsense' as PolicyClass });
  assert.throws(() => createRegistry([bad], deps()), /unknown policy cell/);
});

// --- MCP annotations (MCP-4) ---------------------------------------------------------

test('MCP-4: annotations derive from the policy class, overriding a tool’s declared hints', () => {
  // A read tool that lies (declares destructive) still derives readOnly, never destructive.
  const read = makeTool({
    name: 'x_post_get',
    policy: 'read:content',
    annotations: { title: 'Get', destructiveHint: true },
  });
  const del = makeTool({ name: 'x_list_delete', policy: 'destructive:content' });
  const bookmark = makeTool({ name: 'x_bookmark_set', policy: 'write:engagement' });
  const write = makeTool({ name: 'x_post_create', policy: 'write:content' });

  assert.deepEqual(deriveAnnotations(read), {
    title: 'Get',
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  });
  assert.deepEqual(deriveAnnotations(del), {
    title: 'x_list_delete',
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: true,
    idempotentHint: false, // destructive:* is destructive & NON-idempotent
  });
  assert.deepEqual(deriveAnnotations(bookmark), {
    title: 'x_bookmark_set',
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: true,
    idempotentHint: true, // a merged `*_set` write is idempotent
  });
  assert.deepEqual(deriveAnnotations(write), {
    title: 'x_post_create',
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: true,
  });

  // openWorldHint is universal, and listForMcp surfaces the DERIVED set.
  const reg = createRegistry([read, del, bookmark, write], deps());
  for (const rt of reg.listForMcp()) assert.equal(rt.annotations.openWorldHint, true);
});

// --- Destructive-classification consistency (POL-5) ----------------------------------

test('POL-5: destructive classifications stay consistent with the taxonomy', () => {
  // The catalog's destructive tools must classify as destructive:* — the registry derives
  // destructiveHint from that cell, so a drift between a tool's name and its cell is caught.
  const cases: Array<[string, PolicyClass]> = [
    ['x_list_delete', 'destructive:content'],
    ['x_block_set', 'destructive:social-graph'],
    ['x_unfollow', 'destructive:social-graph'],
  ];
  for (const [name, policy] of cases) {
    const ann = deriveAnnotations(makeTool({ name, policy }));
    assert.equal(ann.destructiveHint, true, `${name} must be destructive`);
    assert.equal(ann.idempotentHint, false, `${name} must be non-idempotent`);
    assert.equal(ann.readOnlyHint, false);
  }
});

// --- Denied-tool resolution (POL-7) --------------------------------------------------

test('POL-7: denied tools stay listed + annotated; X_MCP_HIDE_DENIED drops them entirely', () => {
  const allowed = makeTool({ name: 'x_post_get', policy: 'read:content' });
  const denied = makeTool({ name: 'x_dm_send', policy: 'write:dm', description: 'Send a DM.' });
  const policy = fakePolicy({ preset: 'read-only', isAllowed: (t) => t.name !== 'x_dm_send' });

  const reg = createRegistry([allowed, denied], deps({ policy }));
  const listed = reg.listForMcp();
  assert.equal(listed.length, 2); // denied tool stays VISIBLE (POL-1 / POL-7)

  const dm = listed.find((t) => t.name === 'x_dm_send');
  assert.ok(dm);
  assert.equal(dm.denied, true);
  assert.equal(dm.description, 'Send a DM. (disabled by policy `read-only`)');

  const get = listed.find((t) => t.name === 'x_post_get');
  assert.equal(get?.denied, false);
  assert.equal(get?.description, 'desc x_post_get');

  // X_MCP_HIDE_DENIED removes denied tools from registration entirely.
  const hidden = createRegistry(
    [allowed, denied],
    deps({ policy: fakePolicy({ isAllowed: (t) => t.name !== 'x_dm_send', hideDenied: true }) }),
  );
  assert.deepEqual(
    hidden.listForMcp().map((t) => t.name),
    ['x_post_get'],
  );
});

test('POL-7 / POL-1: a denied tool is visible but its call is rejected with a policy error — no unlock hint for ANY cell', async () => {
  const dm = makeTool({ name: 'x_dm_send', policy: 'write:dm' });
  const reg = createRegistry([dm], deps({ policy: fakePolicy({ isAllowed: () => false }) }));

  // POL-1: the denied tool is still listed.
  assert.equal(reg.listForMcp().length, 1);

  // POL-7: the call is terminal, typed policy, operator-fixable, non-retryable.
  const err = await rejected(reg.call('x_dm_send', {}, callCtx()));
  assert.equal(err.kind, 'policy');
  assert.equal(err.retryable, false);
  assert.equal(err.fix, 'operator');
  assert.equal(err.data.cell, 'write:dm');
  // SEC-F10: the sensitive-cell error must NOT hand back the unlock env var/value.
  assert.doesNotMatch(err.message, /X_MCP_POLICY_ALLOW/);

  // T-320 F2: neither does a LOW-SENSITIVITY one. This assertion used to be the mirror image
  // — `assert.match(..., /X_MCP_POLICY_ALLOW/)`, pinning the hint as intended behaviour. It was
  // the leaking half of a two-call escalation: `x_auth_status` hands over the whole policy
  // matrix, so any denial that spells out the env var and its syntax completes the recipe for a
  // cell the agent could not otherwise unlock. Withholding only counts if it is total.
  const eng = makeTool({ name: 'x_like_set', policy: 'write:engagement' });
  const reg2 = createRegistry([eng], deps({ policy: fakePolicy({ isAllowed: () => false }) }));
  const err2 = await rejected(reg2.call('x_like_set', {}, callCtx()));
  assert.equal(err2.kind, 'policy');
  assert.equal(err2.data.cell, 'write:engagement'); // still actionable via `data.cell`…
  assert.doesNotMatch(err2.message, /X_MCP/); // …without naming any env var.
});

// --- The pipeline gauntlet -----------------------------------------------------------

test('the pipeline runs the gauntlet in order (validate → policy → budget → rate-limit → handler → reserve) and attaches ResultMeta', async () => {
  const order: string[] = [];
  let seenCtx: ToolContext | undefined;
  let checkEstimate: CostEstimate | undefined;
  let reserveEstimate: CostEstimate | undefined;

  const tool = makeTool({
    name: 'x_post_create',
    policy: 'write:content',
    cost: 'w:post',
    input: z.object({}).transform((v) => {
      order.push('validate');
      return v;
    }),
    handler: (_input, ctx) => {
      order.push('handler');
      seenCtx = ctx;
      return Promise.resolve({ data: { id: '1' }, summary: 'created' });
    },
  });

  const policy: PolicyGate = {
    preset: 'default',
    hideDenied: false,
    isAllowed: () => {
      order.push('policy');
      return true;
    },
    denyError: () => policyError('unused'),
  };
  const budget: BudgetGate = {
    check: (e) => {
      order.push('budget-check');
      checkEstimate = e;
    },
    reserve: (e) => {
      order.push('reserve');
      reserveEstimate = e;
      return { cost_usd: 0.02, session_total_usd: 0.5 };
    },
  };
  const rateLimit: RateLimitGate = {
    preflight: () => {
      order.push('rate');
    },
  };

  const reg = createRegistry([tool], { policy, budget, rateLimit });
  const ctrl = new AbortController();
  const result = await reg.call('x_post_create', {}, callCtx({ signal: ctrl.signal }));

  assert.deepEqual(order, ['validate', 'policy', 'budget-check', 'rate', 'handler', 'reserve']);
  assert.deepEqual(result.data, { id: '1' });
  assert.equal(result.summary, 'created');
  assert.deepEqual(result.meta, { cost_usd: 0.02, session_total_usd: 0.5 });

  // The estimate is resolved once from the cost class and used for both check and reserve.
  assert.deepEqual(checkEstimate, { class: 'w:post' });
  assert.deepEqual(reserveEstimate, { class: 'w:post' });

  // The handler receives a full ToolContext: ports, an invoker, the signal. The invoker is
  // NOT the raw one — MCP-7 binds the call signal to it (see the MCP-7 tests below).
  assert.ok(seenCtx);
  assert.notEqual(seenCtx.http, fakeHttp);
  assert.equal(seenCtx.signal, ctrl.signal);
  assert.equal(typeof seenCtx.ports.clock.now(), 'number');
});

test('validation runs before any gate; an unknown tool name is a typed validation error', async () => {
  let policyChecked = false;
  const tool = makeTool({
    name: 'x_post_get',
    policy: 'read:content',
    input: z.object({ id: z.string() }),
  });
  const policy = fakePolicy({
    isAllowed: () => {
      policyChecked = true;
      return true;
    },
  });
  const reg = createRegistry([tool], deps({ policy }));

  const err = await rejected(reg.call('x_post_get', { id: 123 }, callCtx()));
  assert.equal(err.kind, 'validation');
  assert.equal(err.fix, 'agent');
  assert.equal(policyChecked, false); // validation short-circuits before the policy gate

  const unknown = await rejected(reg.call('x_nope', {}, callCtx()));
  assert.equal(unknown.kind, 'validation');
});

test('budget: hard-mode pre-flight refuses (nothing reserved); warn-mode surfaces budget_warning', async () => {
  let handlerRan = false;
  let reserved = false;
  const tool = makeTool({
    name: 'x_post_create',
    policy: 'write:content',
    handler: () => {
      handlerRan = true;
      return Promise.resolve({ data: {} });
    },
  });

  // Hard-mode over cap: the pre-flight check throws; the handler never runs; nothing is reserved.
  const hard = createRegistry(
    [tool],
    deps({
      budget: {
        check: () => {
          throw budgetError('Session budget exhausted.');
        },
        reserve: () => {
          reserved = true;
          return { cost_usd: 0, session_total_usd: 0 };
        },
      },
    }),
  );
  const err = await rejected(hard.call('x_post_create', {}, callCtx()));
  assert.equal(err.kind, 'budget');
  assert.equal(handlerRan, false);
  assert.equal(reserved, false);

  // Warn-mode: the reservation carries a warning that flows into ResultMeta.
  const warn = createRegistry(
    [tool],
    deps({
      budget: fakeBudget({
        reservation: {
          cost_usd: 0.02,
          session_total_usd: 0.95,
          budget_warning: 'Approaching cap (95%).',
        },
      }),
    }),
  );
  const res = await warn.call('x_post_create', {}, callCtx());
  assert.equal(res.meta.budget_warning, 'Approaching cap (95%).');
  assert.equal(res.meta.session_total_usd, 0.95);
});

test('rate-limit preflight refuses a known-exhausted window before the handler runs', async () => {
  let handlerRan = false;
  const tool = makeTool({
    name: 'x_search',
    policy: 'read:content',
    handler: () => {
      handlerRan = true;
      return Promise.resolve({ data: {} });
    },
  });
  const reg = createRegistry(
    [tool],
    deps({
      rateLimit: fakeRateLimit(
        rateLimitError('Rate limited; retry after the window resets.', {
          data: { retry_after_seconds: 30 },
        }),
      ),
    }),
  );
  const err = await rejected(reg.call('x_search', {}, callCtx()));
  assert.equal(err.kind, 'rate-limit');
  assert.equal(err.retryable, true);
  assert.equal(handlerRan, false);
});

test('handler errors: an XError propagates unchanged; a non-XError is wrapped as api without leaking its message (REND-7)', async () => {
  const leaky = makeTool({
    name: 'x_a',
    policy: 'read:content',
    handler: () => Promise.reject(new Error('secret @victim bio text')),
  });
  const reg = createRegistry([leaky], deps());
  const err = await rejected(reg.call('x_a', {}, callCtx()));
  assert.equal(err.kind, 'api');
  assert.doesNotMatch(err.message, /secret @victim bio text/);

  const typed = makeTool({
    name: 'x_b',
    policy: 'read:content',
    handler: () => Promise.reject(rateLimitError('too fast')),
  });
  const reg2 = createRegistry([typed], deps());
  const err2 = await rejected(reg2.call('x_b', {}, callCtx()));
  assert.equal(err2.kind, 'rate-limit'); // passed through untouched
});

// --- Cooperative cancellation (MCP-7) -------------------------------------------------
//
// The registry is THE choke point: it binds the `tools/call` signal to the invoker it hands
// the handler, so cancellation reaches every in-flight request of every tool without any
// endpoint or tool opting in (docs/07 MCP-7, generalizing ARCH-F7 beyond media).

/** An invoker that records the requests it is handed and answers with a fixed payload. */
function recordingHttp(sink: XApiRequest[]): EndpointInvoker {
  return {
    send<T>(req: XApiRequest): Promise<T> {
      sink.push(req);
      return Promise.resolve({ ok: true } as unknown as T);
    },
  };
}

test('MCP-7: the call signal is bound to the invoker — EVERY request a handler sends carries it', async () => {
  const sent: XApiRequest[] = [];
  // A multi-request handler: the media-style INIT → APPEND×2 → FINALIZE conversation is the
  // reason the binding lives on the invoker and not on one call site.
  const tool = makeTool({
    name: 'x_media_upload',
    policy: 'write:content',
    handler: async (_input, ctx) => {
      await ctx.http.send({ method: 'POST', path: '/2/media/upload', body: { command: 'INIT' } });
      await ctx.http.send({ method: 'POST', path: '/2/media/upload', body: { segment: 0 } });
      await ctx.http.send({ method: 'POST', path: '/2/media/upload', body: { segment: 1 } });
      await ctx.http.send({
        method: 'POST',
        path: '/2/media/upload',
        body: { command: 'FINALIZE' },
        scopes: ['media.write'],
      });
      return { data: { ok: true } };
    },
  });

  const ctrl = new AbortController();
  const reg = createRegistry([tool], deps());
  await reg.call('x_media_upload', {}, callCtx({ http: recordingHttp(sent), signal: ctrl.signal }));

  assert.equal(sent.length, 4);
  for (const req of sent) {
    assert.ok(req.signal, 'every request must carry a cancellation signal');
    assert.equal(req.signal.aborted, false);
  }
  // One abort tears down every segment request — including ones already on the wire.
  ctrl.abort();
  for (const req of sent) assert.equal(req.signal?.aborted, true);

  // The wrapper is transparent: it only ADDS `signal`, it never rewrites the request.
  assert.equal(sent[0]?.method, 'POST');
  assert.equal(sent[0]?.path, '/2/media/upload');
  assert.deepEqual(sent[1]?.body, { segment: 0 });
  assert.deepEqual(sent[3]?.scopes, ['media.write']);
});

test('MCP-7: a call with no host signal gets the raw invoker back — zero wrapping, no signal on the wire', async () => {
  const sent: XApiRequest[] = [];
  const raw = recordingHttp(sent);
  let seenHttp: EndpointInvoker | undefined;
  const tool = makeTool({
    name: 'x_post_get',
    policy: 'read:content',
    handler: async (_input, ctx) => {
      seenHttp = ctx.http;
      await ctx.http.send({ method: 'GET', path: '/2/tweets/1' });
      return { data: { ok: true } };
    },
  });

  const reg = createRegistry([tool], deps());
  await reg.call('x_post_get', {}, callCtx({ http: raw }));

  assert.equal(seenHttp, raw); // identity: nothing to bind, so nothing is wrapped
  assert.equal(sent[0]?.signal, undefined);
});

test('MCP-7: an explicit per-request signal is COMBINED with the call signal, never replaced', async () => {
  // Either side firing must tear the request down; neither layer can silently disable the
  // other's cancellation. Two independent wrappers, one per direction.
  const callSide = new AbortController();
  const sentA: XApiRequest[] = [];
  const boundA = withCallSignal(recordingHttp(sentA), callSide.signal);
  const ownA = new AbortController();
  await boundA.send({ method: 'GET', path: '/2/tweets/1', signal: ownA.signal });
  const combinedA = sentA[0]?.signal;
  assert.ok(combinedA);
  assert.equal(combinedA.aborted, false);
  callSide.abort(); // the host cancelled the tools/call
  assert.equal(combinedA.aborted, true);

  const callSideB = new AbortController();
  const sentB: XApiRequest[] = [];
  const boundB = withCallSignal(recordingHttp(sentB), callSideB.signal);
  const ownB = new AbortController();
  await boundB.send({ method: 'GET', path: '/2/tweets/2', signal: ownB.signal });
  const combinedB = sentB[0]?.signal;
  assert.ok(combinedB);
  assert.equal(combinedB.aborted, false);
  ownB.abort(); // the endpoint's own sub-timeout fired
  assert.equal(combinedB.aborted, true);
  assert.equal(callSideB.signal.aborted, false); // and it did NOT abort the whole call
});

test('MCP-7: a call cancelled before it starts does nothing at all — no gate, no handler, no charge', async () => {
  const seen: string[] = [];
  let handlerRan = false;
  const tool = makeTool({
    name: 'x_post_create',
    policy: 'write:content',
    input: z.object({ text: z.string() }),
    handler: () => {
      handlerRan = true;
      return Promise.resolve({ data: {} });
    },
  });
  const policy = fakePolicy({
    isAllowed: () => {
      seen.push('policy');
      return true;
    },
  });
  const budget: BudgetGate = {
    check: () => {
      seen.push('budget-check');
    },
    reserve: () => {
      seen.push('reserve');
      return { cost_usd: 0.015, session_total_usd: 0.015 };
    },
  };
  const rateLimit: RateLimitGate = {
    preflight: () => {
      seen.push('rate');
    },
  };

  const ctrl = new AbortController();
  ctrl.abort();
  const reg = createRegistry([tool], { policy, budget, rateLimit });
  // Note the input is INVALID too: cancellation short-circuits even ahead of validation.
  const err = await rejected(
    reg.call('x_post_create', { text: 7 }, callCtx({ signal: ctrl.signal })),
  );

  assert.equal(err.kind, 'network'); // the frozen taxonomy's answer — no new class invented
  assert.match(err.message, /cancelled by the MCP host/);
  assert.equal(handlerRan, false);
  assert.deepEqual(seen, []); // not a single gate ran, so nothing was charged (INT-2)
});

test('MCP-7: a raw AbortError escaping a handler renders as the cancellation error, not "failed unexpectedly"', async () => {
  const ctrl = new AbortController();
  const tool = makeTool({
    name: 'x_post_get',
    policy: 'read:content',
    handler: (_input, ctx) => {
      ctrl.abort(); // the host cancels while the handler is mid-flight
      ctx.signal?.throwIfAborted(); // a handler that merely honours the signal (MEDIA-7)
      return Promise.resolve({ data: {} });
    },
  });
  const reg = createRegistry([tool], deps());
  const err = await rejected(reg.call('x_post_get', {}, callCtx({ signal: ctrl.signal })));

  assert.equal(err.kind, 'network');
  assert.equal(err.retryable, true); // a cancelled READ is safely re-issuable
  assert.match(err.message, /cancelled by the MCP host/);
  assert.doesNotMatch(err.message, /failed unexpectedly/);
});

test('MCP-7 → POST-4: a cancelled WRITE is non-retryable and warns the platform may have applied it', async () => {
  const ctrl = new AbortController();
  const write = makeTool({
    name: 'x_post_create',
    policy: 'write:content',
    handler: () => {
      ctrl.abort();
      // A `DOMException` named AbortError, exactly as fetch/fs teardown produces it.
      return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
    },
  });
  const reg = createRegistry([write], deps());
  const err = await rejected(reg.call('x_post_create', {}, callCtx({ signal: ctrl.signal })));

  assert.equal(err.kind, 'network');
  assert.equal(err.retryable, false); // POST-4: never blind-retry an ambiguous write
  assert.match(err.message, /may nevertheless have been applied/);
  assert.match(err.message, /POST-4/);
});
