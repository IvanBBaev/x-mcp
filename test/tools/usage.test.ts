// Tests for the platform-usage tool (T-317, WP-3.11). `x_usage_get` is a COMPOSITION-ROOT
// tool (INT-6): it reads the injected session budget, which the frozen `ToolContext` does not
// carry — so every test builds fake `UsageToolDeps`, calls `createUsageTools`, then drives the
// built handler directly against a REAL createHttpClient over an offline undici MockAgent
// (test/helpers/http.ts). Fixtures live in test/fixtures/usage/ and carry `_provenance`
// (DRIFT-4).
//
// undici 6.x matches an interceptor by string-comparing its `path` (with `query` merged in and
// the params sorted) against the incoming request's full path+query, so every intercept below
// pins the EXACT query the endpoint wrapper puts on the wire — including the clamped `days`.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createHttpClient } from '../../src/api/http.js';
import { XError } from '../../src/core/errors.js';
import type { AnyToolDef, EndpointInvoker, ToolContext } from '../../src/core/tooldef.js';
import type { SessionBudget } from '../../src/core/budget.js';
import { USAGE_FIELDS } from '../../src/api/endpoints/usage.js';
import type { RawUsageResponse } from '../../src/api/endpoints/usage.js';
import { createUsageTools } from '../../src/tools/usage.js';
import type { UsageReport, UsageToolDeps } from '../../src/tools/usage.js';
import {
  fakeClock,
  fakeRandom,
  fakeSleep,
  loadFixture,
  makePorts,
  mockHttp,
} from '../helpers/index.js';

/** Build a ToolContext whose `http` is the real client over the offline mock dispatcher. */
function makeCtx(http: ReturnType<typeof mockHttp>): ToolContext {
  const clock = fakeClock(0);
  const client = createHttpClient({
    sleep: fakeSleep(clock).fn,
    random: fakeRandom([0.5]),
    dispatcher: http.dispatcher,
  });
  return { ports: makePorts({ dispatcher: http.dispatcher }), http: client };
}

/** An `EndpointInvoker` that must never be called (validation must reject before any HTTP). */
const NO_HTTP: EndpointInvoker = {
  send: () => {
    throw new Error('handler must not make an API call in this path');
  },
};

/**
 * A fake budget exposing ONLY the read side the tool is allowed to see. `reserve` is
 * deliberately absent from `UsageToolDeps`, so a tool that tried to mutate the counter would
 * not compile (COST-1/COST-2).
 */
function fakeBudget(
  spent: number,
  limit?: number,
  mode: SessionBudget['mode'] = 'warn',
): UsageToolDeps['budget'] {
  return { limit, mode, total: () => spent };
}

function usageTool(deps: UsageToolDeps): AnyToolDef {
  const tools = createUsageTools(deps);
  const tool = tools.find((t) => t.name === 'x_usage_get');
  assert.ok(tool, 'x_usage_get should be built by createUsageTools');
  return tool;
}

/** The `usage.fields` set every request carries (mirrors api/endpoints/usage). */
const FIELD_PARAMS = { 'usage.fields': USAGE_FIELDS } as const;

const FIXTURE = 'usage/usage-tweets.json';
const DEGRADED_FIXTURE = 'usage/usage-degraded.json';

test('x_usage_get ships with the expected axes (P3 read:account, app+user, owned) — WP-3.11 go/no-go resolved GO by the T-010 fact-check', () => {
  const tool = usageTool({ budget: fakeBudget(0) });
  assert.equal(tool.name, 'x_usage_get');
  assert.equal(tool.policy, 'read:account');
  // docs/01 §3.5: the endpoint authenticates with an app bearer token on an approved
  // developer account — no tier gate — so it is app+user and never availability-excluded.
  assert.equal(tool.availability, 'app+user');
  assert.equal(tool.cost, 'owned');
  assert.equal(tool.phase, 3);
  assert.equal(tool.annotations.readOnlyHint, true);
  // The endpoint names no user-level OAuth scope; none is invented.
  assert.deepEqual([...tool.scopes], []);
});

test('x_usage_get: happy path reports posts read vs the cap, the daily series (REND-9 ISO dates) and the per-app split', async () => {
  const http = mockHttp();
  http.pool
    .intercept({ path: '/2/usage/tweets', method: 'GET', query: { ...FIELD_PARAMS } })
    .reply(200, loadFixture<RawUsageResponse>(FIXTURE));

  const out = await usageTool({ budget: fakeBudget(0.125, 5) }).handler({}, makeCtx(http));
  const report = out.data as UsageReport;

  assert.equal(report.platform.project_id, '1441234567890123456');
  // The endpoint returns the counters as JSON strings; they surface as numbers (DRIFT-1).
  assert.equal(report.platform.posts_read, 125_000);
  assert.equal(report.platform.cap, 2_000_000);
  assert.equal(report.platform.percent_used, 6.3);
  assert.equal(report.platform.cap_reset_day, 10);
  // REND-9: both a full stamp and a date-only string normalise to ISO-8601 UTC.
  assert.deepEqual(report.platform.daily, [
    { date: '2026-07-29T00:00:00.000Z', posts_read: 80_000 },
    { date: '2026-07-30T00:00:00.000Z', posts_read: 45_000 },
  ]);
  assert.deepEqual(report.platform.by_app, [{ client_app_id: '27847302', posts_read: 125_000 }]);
  assert.equal(out.summary, '125000 of 2000000 posts read (6.3%); local session estimate $0.125.');

  http.assertDone();
  await http.close();
});

test('COST-1: the operator-set credit budget is reported but not settable — the input schema accepts no limit/mode key', async () => {
  const tool = usageTool({ budget: fakeBudget(4.5, 5, 'hard') });

  // A strict schema with only `days`/`raw`: nothing an agent sends can raise, clear, or
  // switch the cap — the tool has no write path to the budget at all.
  for (const attempt of [
    { limit_usd: 999 },
    { budget: { limit: 999 } },
    { mode: 'warn' },
    { reset: true },
  ]) {
    assert.equal(
      tool.input.safeParse(attempt).success,
      false,
      `must reject ${JSON.stringify(attempt)}`,
    );
  }
  assert.equal(tool.input.safeParse({}).success, true);

  const http = mockHttp();
  http.pool
    .intercept({ path: '/2/usage/tweets', method: 'GET', query: { ...FIELD_PARAMS } })
    .reply(200, loadFixture<RawUsageResponse>(FIXTURE));
  const report = (await tool.handler({}, makeCtx(http))).data as UsageReport;

  assert.equal(report.session_budget.limit_usd, 5);
  assert.equal(report.session_budget.mode, 'hard');
  assert.match(report.note, /operator-set and cannot be changed from within this session/);

  http.assertDone();
  await http.close();
});

test('COST-2: platform counts never seed the local session estimate — the two figures stay independent', async () => {
  const http = mockHttp();
  http.pool
    .intercept({ path: '/2/usage/tweets', method: 'GET', query: { ...FIELD_PARAMS } })
    .reply(200, loadFixture<RawUsageResponse>(FIXTURE));

  // A fresh process: the platform reports 125 000 posts read this cycle, the local counter is
  // still zero. Reading usage must NOT import the platform figure into the estimate.
  const report = (await usageTool({ budget: fakeBudget(0) }).handler({}, makeCtx(http)))
    .data as UsageReport;

  assert.equal(report.platform.posts_read, 125_000);
  assert.equal(report.session_budget.spent_usd, 0);
  assert.equal(report.session_budget.limit_usd, undefined); // uncapped stays uncapped
  assert.equal(report.session_budget.percent_used, undefined);
  assert.match(report.note, /never seeded or corrected from these platform counts/);

  http.assertDone();
  await http.close();
});

test('COST-3: the session block carries spend, mode, remaining and percent of the cap', async () => {
  const http = mockHttp();
  http.pool
    .intercept({ path: '/2/usage/tweets', method: 'GET', query: { ...FIELD_PARAMS } })
    .reply(200, loadFixture<RawUsageResponse>(FIXTURE));

  const report = (
    await usageTool({ budget: fakeBudget(4.5, 5, 'hard') }).handler({}, makeCtx(http))
  ).data as UsageReport;

  assert.deepEqual(report.session_budget, {
    spent_usd: 4.5,
    mode: 'hard',
    limit_usd: 5,
    remaining_usd: 0.5,
    percent_used: 90,
  });

  http.assertDone();
  await http.close();
});

test('COST-7: the monthly 2 M read cap is reported as the platform states it, and stated to be untracked between sessions', async () => {
  const http = mockHttp();
  http.pool
    .intercept({ path: '/2/usage/tweets', method: 'GET', query: { ...FIELD_PARAMS } })
    .reply(200, loadFixture<RawUsageResponse>(FIXTURE));

  const report = (await usageTool({ budget: fakeBudget(0) }).handler({}, makeCtx(http)))
    .data as UsageReport;

  assert.equal(report.platform.cap, 2_000_000);
  assert.match(report.note, /not tracked between sessions/);
  // The platform figures are counts, never money — no dollar field leaks into `platform`.
  assert.equal(
    Object.keys(report.platform).some((k) => k.includes('usd')),
    false,
  );
  assert.match(report.note, /not money/);

  http.assertDone();
  await http.close();
});

test('x_usage_get: an over-range `days` is clamped to 90 on the wire and the clamp is stated', async () => {
  const http = mockHttp();
  // The intercept pins days=90 (clamped), not 400 (requested): a match proves the clamp
  // reached the wire, since undici string-compares the full sorted query.
  http.pool
    .intercept({ path: '/2/usage/tweets', method: 'GET', query: { ...FIELD_PARAMS, days: '90' } })
    .reply(200, loadFixture<RawUsageResponse>(FIXTURE));

  const report = (await usageTool({ budget: fakeBudget(0) }).handler({ days: 400 }, makeCtx(http)))
    .data as UsageReport;

  assert.match(report.note, /days 400 lowered to the maximum of 90\./);

  http.assertDone();
  await http.close();
});

test('x_usage_get: an under-range `days` is raised to 1 on the wire', async () => {
  const http = mockHttp();
  http.pool
    .intercept({ path: '/2/usage/tweets', method: 'GET', query: { ...FIELD_PARAMS, days: '1' } })
    .reply(200, loadFixture<RawUsageResponse>(FIXTURE));

  const report = (await usageTool({ budget: fakeBudget(0) }).handler({ days: 0 }, makeCtx(http)))
    .data as UsageReport;

  assert.match(report.note, /days 0 raised to the minimum of 1\./);

  http.assertDone();
  await http.close();
});

test('x_usage_get: an in-range `days` rides the wire verbatim with no clamp note', async () => {
  const http = mockHttp();
  // The intercept pins days=30 exactly as requested: nothing was rewritten.
  http.pool
    .intercept({ path: '/2/usage/tweets', method: 'GET', query: { ...FIELD_PARAMS, days: '30' } })
    .reply(200, loadFixture<RawUsageResponse>(FIXTURE));

  const report = (await usageTool({ budget: fakeBudget(0) }).handler({ days: 30 }, makeCtx(http)))
    .data as UsageReport;

  // No clamp happened, so the note must not claim one.
  assert.doesNotMatch(report.note, /raised|lowered/);

  http.assertDone();
  await http.close();
});

test('x_usage_get: a fractional `days` is a typed validation error and no request is sent', async () => {
  const tool = usageTool({ budget: fakeBudget(0) });
  const ctx: ToolContext = { ports: makePorts(), http: NO_HTTP };

  await assert.rejects(
    () => tool.handler({ days: 2.5 }, ctx),
    (err: unknown) => {
      assert.ok(err instanceof XError);
      assert.equal(err.kind, 'validation');
      assert.match(err.message, /whole number/);
      return true;
    },
  );
  // The zod schema rejects it too, so the registry never reaches the handler in production.
  assert.equal(tool.input.safeParse({ days: 2.5 }).success, false);
});

test('x_usage_get: raw: true returns the exact API envelope instead of the compact report', async () => {
  const http = mockHttp();
  const fixture = loadFixture<RawUsageResponse>(FIXTURE);
  http.pool
    .intercept({ path: '/2/usage/tweets', method: 'GET', query: { ...FIELD_PARAMS } })
    .reply(200, fixture);

  const out = await usageTool({ budget: fakeBudget(0) }).handler({ raw: true }, makeCtx(http));

  assert.deepEqual(out.data, fixture);
  assert.equal(out.summary, 'Raw usage response.');

  http.assertDone();
  await http.close();
});

test('DRIFT-1: a 200 without a `data` block degrades to a stated UNKNOWN, never a silent zero', async () => {
  const http = mockHttp();
  http.pool
    .intercept({ path: '/2/usage/tweets', method: 'GET', query: { ...FIELD_PARAMS } })
    .reply(200, loadFixture<RawUsageResponse>(DEGRADED_FIXTURE));

  const out = await usageTool({ budget: fakeBudget(0.02, 1) }).handler({}, makeCtx(http));
  const report = out.data as UsageReport;

  assert.equal(report.platform.cap, undefined);
  assert.equal(report.platform.percent_used, undefined);
  assert.equal(report.platform.daily, undefined);
  assert.match(report.note, /UNKNOWN, not zero/);
  // REND-2: the platform's own reason for the empty report is quoted rather than swallowed.
  assert.match(report.note, /Platform reason: Not authorized for usage/);
  // The local estimate is process state, so it still renders while the platform half is blank.
  assert.equal(report.session_budget.spent_usd, 0.02);
  assert.equal(out.summary, 'platform usage unknown; local session estimate $0.02.');

  http.assertDone();
  await http.close();
});

// --- T-320 F3, second half: the SUCCESS path quotes platform text too -------------------
//
// `platformReason` lifts `errors[].title`/`.detail` out of a degraded 200 and into the report
// note, so it is a third-party-text path into the model's context exactly like the error
// payload is — and it gets the same treatment. "It is X's own text, not a user's" is the
// assumption that left the error path unguarded; origin is not a property of the bytes.

/** U+202E RIGHT-TO-LEFT OVERRIDE — reorders everything after it in a rendered transcript. */
const RLO = '‮';
/** U+200B ZERO WIDTH SPACE and a C1 control: invisible, and both survive JSON transport. */
const ZWSP = '​';
const C1 = '';

test('F3: a degraded 200 has its platform reason stripped of bidi and invisible code points', async () => {
  const http = mockHttp();
  http.pool
    .intercept({ path: '/2/usage/tweets', method: 'GET', query: { ...FIELD_PARAMS } })
    .reply(200, {
      errors: [{ title: `Not${RLO}authorized${ZWSP}`, detail: `No${C1}record.` }],
    });

  const out = await usageTool({ budget: fakeBudget(0.02, 1) }).handler({}, makeCtx(http));
  const note = (out.data as UsageReport).note;

  assert.match(note, /Platform reason: Notauthorized: Norecord\./);
  for (const cp of [RLO, ZWSP, C1]) assert.equal(note.includes(cp), false);

  http.assertDone();
  await http.close();
});

test('F3: an oversized platform reason is capped rather than flooding the context', async () => {
  const http = mockHttp();
  http.pool
    .intercept({ path: '/2/usage/tweets', method: 'GET', query: { ...FIELD_PARAMS } })
    .reply(200, { errors: [{ title: 'x'.repeat(5_000), detail: 'y'.repeat(5_000) }] });

  const out = await usageTool({ budget: fakeBudget(0, 1) }).handler({}, makeCtx(http));
  const note = (out.data as UsageReport).note;

  // FIELD_CAPS.errorText is 500 code points per field, applied to each independently, so the
  // quoted reason cannot exceed ~1 kB however long the platform's strings are.
  assert.equal(note.includes('x'.repeat(600)), false);
  assert.equal(note.includes('y'.repeat(600)), false);
  assert.match(note, /Platform reason: x+…\[truncated\]: y+…\[truncated\]/u);

  http.assertDone();
  await http.close();
});

// --- DRIFT-1 hard cases: every optional/ill-typed field the endpoint can send ----------

test('DRIFT-1: a degraded 200 with no errors[] at all (or an empty error object) invents no platform reason', async () => {
  // REND-2 quoting is best-effort: when the platform explains nothing, the note must say
  // UNKNOWN and stop — a fabricated "Platform reason:" line would be worse than silence.
  const http = mockHttp();

  http.pool
    .intercept({ path: '/2/usage/tweets', method: 'GET', query: { ...FIELD_PARAMS } })
    .reply(200, {});
  const bare = await usageTool({ budget: fakeBudget(0.02, 1) }).handler({}, makeCtx(http));
  assert.match((bare.data as UsageReport).note, /UNKNOWN, not zero/);
  assert.doesNotMatch((bare.data as UsageReport).note, /Platform reason/);
  assert.equal(bare.summary, 'platform usage unknown; local session estimate $0.02.');

  // An `errors: [{}]` entry sanitizes to an empty reason — same outcome as no entry.
  http.pool
    .intercept({ path: '/2/usage/tweets', method: 'GET', query: { ...FIELD_PARAMS } })
    .reply(200, { errors: [{}] });
  const empty = await usageTool({ budget: fakeBudget(0.02, 1) }).handler({}, makeCtx(http));
  assert.match((empty.data as UsageReport).note, /UNKNOWN, not zero/);
  assert.doesNotMatch((empty.data as UsageReport).note, /Platform reason/);

  http.assertDone();
  await http.close();
});

test('a zero platform cap (and a zero budget limit) is reported as stated but never divided by', async () => {
  // COST-7 says the cap is surfaced exactly as the platform states it — even a nonsense 0.
  // A 0 denominator must simply drop percent_used (both platform- and budget-side), never
  // yield Infinity/NaN into a JSON report.
  const http = mockHttp();
  http.pool
    .intercept({ path: '/2/usage/tweets', method: 'GET', query: { ...FIELD_PARAMS } })
    .reply(200, { data: { project_usage: '125000', project_cap: '0' } });

  const out = await usageTool({ budget: fakeBudget(0.5, 0, 'hard') }).handler({}, makeCtx(http));
  const report = out.data as UsageReport;

  assert.equal(report.platform.posts_read, 125_000);
  assert.equal(report.platform.cap, 0); // stated, not "corrected"
  assert.equal(Object.hasOwn(report.platform, 'percent_used'), false);
  // A limit of $0 renders the full budget block with everything already spent-through —
  // and no percent_used key rather than a division by zero.
  assert.deepEqual(report.session_budget, {
    spent_usd: 0.5,
    mode: 'hard',
    limit_usd: 0,
    remaining_usd: 0,
  });
  // The summary keeps the "of 0" wording and just omits the percentage.
  assert.equal(out.summary, '125000 of 0 posts read; local session estimate $0.5.');

  http.assertDone();
  await http.close();
});

test('DRIFT-1: counters already typed as JSON numbers are accepted; a non-finite one never leaks', async () => {
  const http = mockHttp();

  // The docs say the counters come back as strings, but a number-typed counter must not
  // be refused if the platform drifts to proper JSON numbers.
  http.pool
    .intercept({ path: '/2/usage/tweets', method: 'GET', query: { ...FIELD_PARAMS } })
    .reply(200, { data: { project_usage: 125, project_cap: 200 } });
  const typed = await usageTool({ budget: fakeBudget(0) }).handler({}, makeCtx(http));
  const typedReport = typed.data as UsageReport;
  assert.equal(typedReport.platform.posts_read, 125);
  assert.equal(typedReport.platform.cap, 200);
  assert.equal(typedReport.platform.percent_used, 62.5);
  assert.equal(typed.summary, '125 of 200 posts read (62.5%); local session estimate $0.');

  // `1e999` parses to Infinity — a raw string body so the mock cannot re-serialize it.
  // Infinity must not surface in the report (it is not JSON-encodable) nor feed a percent.
  http.pool
    .intercept({ path: '/2/usage/tweets', method: 'GET', query: { ...FIELD_PARAMS } })
    .reply(200, '{"data":{"project_usage":1e999,"project_cap":"200"}}');
  const inf = await usageTool({ budget: fakeBudget(0) }).handler({}, makeCtx(http));
  const infReport = inf.data as UsageReport;
  assert.equal(Number.isFinite(infReport.platform.posts_read), true);
  assert.equal(infReport.platform.posts_read, 0);
  assert.equal(infReport.platform.cap, 200);
  assert.equal(Object.hasOwn(infReport.platform, 'percent_used'), false);

  http.assertDone();
  await http.close();
});

test('DRIFT-1: an unparseable cap string drops the cap — the summary falls back to posts read alone', async () => {
  const http = mockHttp();
  http.pool
    .intercept({ path: '/2/usage/tweets', method: 'GET', query: { ...FIELD_PARAMS } })
    .reply(200, { data: { project_usage: '125000', project_cap: 'unlimited' } });

  const out = await usageTool({ budget: fakeBudget(0) }).handler({}, makeCtx(http));
  const report = out.data as UsageReport;

  // "unlimited" is not a number: the cap key is ABSENT (never 0, never NaN)…
  assert.equal(Object.hasOwn(report.platform, 'cap'), false);
  assert.equal(report.platform.posts_read, 125_000);
  // …and with data present but no cap, the summary states the count without an "of".
  assert.equal(out.summary, '125000 posts read; local session estimate $0.');

  http.assertDone();
  await http.close();
});

test('REND-9 / DRIFT-1: malformed daily and per-app entries are skipped or zeroed, never invented', async () => {
  const http = mockHttp();
  http.pool
    .intercept({ path: '/2/usage/tweets', method: 'GET', query: { ...FIELD_PARAMS } })
    .reply(200, {
      data: {
        project_usage: '10',
        daily_project_usage: [
          { date: 'not-a-date', usage: '5' }, // no ISO date → the whole entry is dropped
          { date: '2026-08-30' }, // valid date, absent usage → an honest 0
        ],
        daily_client_app_usage: [
          { usage: [{ date: '2026-08-30', usage: '7' }] }, // no client_app_id → dropped
          { client_app_id: 'app-1' }, // no usage array → total 0
          {
            client_app_id: 'app-2',
            usage: [{ date: '2026-08-30' }, { date: '2026-08-31', usage: '3' }],
          }, // a day without usage adds 0, the parseable day still counts
        ],
      },
    });

  const report = (await usageTool({ budget: fakeBudget(0) }).handler({}, makeCtx(http)))
    .data as UsageReport;

  // REND-9: only the entry with a real date survives, normalised to ISO-8601 UTC.
  assert.deepEqual(report.platform.daily, [{ date: '2026-08-30T00:00:00.000Z', posts_read: 0 }]);
  // An unattributable per-app row is dropped; missing usage never becomes NaN.
  assert.deepEqual(report.platform.by_app, [
    { client_app_id: 'app-1', posts_read: 0 },
    { client_app_id: 'app-2', posts_read: 3 },
  ]);

  http.assertDone();
  await http.close();
});
