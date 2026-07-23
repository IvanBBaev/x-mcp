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

import { createRegistry, deriveAnnotations } from '../../src/core/registry.js';
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
  const isSensitive = (cell: string): boolean =>
    cell.endsWith(':dm') || cell.startsWith('destructive:') || cell.endsWith(':social-graph');
  return {
    preset: over.preset ?? 'read-only',
    hideDenied: over.hideDenied ?? false,
    isAllowed: over.isAllowed ?? (() => true),
    denyError: (tool) => {
      const cell = tool.policy;
      // POL-7 / SEC-F10: a sensitive cell NAMES the cell but never the unlock env var.
      const message = isSensitive(cell)
        ? `Blocked by policy: the "${cell}" capability is disabled.`
        : `Blocked by policy: the "${cell}" capability is disabled; set X_MCP_POLICY_ALLOW="${cell}" to enable it.`;
      return policyError(message, { data: { cell } });
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

test('POL-7 / POL-1: a denied tool is visible but its call is rejected with a policy error — no unlock hint for sensitive cells', async () => {
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

  // Contrast: a low-sensitivity cell MAY include the unlock hint.
  const eng = makeTool({ name: 'x_like_set', policy: 'write:engagement' });
  const reg2 = createRegistry([eng], deps({ policy: fakePolicy({ isAllowed: () => false }) }));
  const err2 = await rejected(reg2.call('x_like_set', {}, callCtx()));
  assert.equal(err2.kind, 'policy');
  assert.match(err2.message, /X_MCP_POLICY_ALLOW/);
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

  // The handler receives a full ToolContext: ports, the auth-scoped invoker, the signal.
  assert.ok(seenCtx);
  assert.equal(seenCtx.http, fakeHttp);
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
