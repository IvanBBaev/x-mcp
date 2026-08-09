// Structured-output tests (T-310; docs/08 WP-3.8). The headline contract is REND-11:
// `structuredContent` and the text block are generated from the SAME render object, the
// per-tool `outputSchema` map covers every registered tool, and the schemas are PUBLIC
// API pinned by the contract fixture (test/fixtures/structured/output-schemas.json).
// Truthfulness is proven against REAL renderer output (core/render, api/ratelimit) using
// a minimal in-test JSON-Schema validator — no new dependency.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createRateLimitTracker } from '../../src/api/ratelimit.js';
import { parseConfig } from '../../src/core/config.js';
import { ZERO_RESULTS_NOTE } from '../../src/core/render-shapes.js';
import {
  renderDmPage,
  renderList,
  renderListPage,
  renderPostPage,
  renderPosts,
  renderUserPage,
  renderUsers,
} from '../../src/core/render.js';
import type {
  RawDmEvent,
  RawList,
  RawListResponse,
  RawSingleResponse,
  RawTweet,
  RawUser,
} from '../../src/core/render.js';
import type { ResultMeta } from '../../src/core/tooldef.js';
import { composeServer } from '../../src/mcp/compose.js';
import {
  TOOL_OUTPUT_SCHEMAS,
  assertOutputSchemaCoverage,
  renderStructuredResult,
  toolOutputSchema,
} from '../../src/mcp/structured.js';

import { loadFixture } from '../helpers/index.js';

const META: ResultMeta = { cost_usd: 0.005, session_total_usd: 0.015 };

// --- Minimal JSON-Schema validator ------------------------------------------------
// Supports exactly the subset the T-310 schemas use: type, enum, properties, required,
// items, additionalProperties (schema form), anyOf, and `#/$defs/...` refs resolved
// against the root schema. Returns a list of human-readable violations (empty = valid).

type Schema = Record<string, unknown>;

function hasType(value: unknown, type: string): boolean {
  switch (type) {
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    default:
      return false;
  }
}

function resolveRef(root: Schema, ref: string): Schema {
  assert.ok(ref.startsWith('#/$defs/'), `unsupported $ref form: ${ref}`);
  const defs = root['$defs'] as Record<string, Schema> | undefined;
  const target = defs?.[ref.slice('#/$defs/'.length)];
  assert.ok(target !== undefined, `unresolved $ref: ${ref}`);
  return target;
}

function validate(schema: Schema, value: unknown, root: Schema, path: string): string[] {
  if (typeof schema['$ref'] === 'string') {
    return validate(resolveRef(root, schema['$ref']), value, root, path);
  }
  if (Array.isArray(schema['anyOf'])) {
    const branches = schema['anyOf'].map((b) => validate(b as Schema, value, root, path));
    return branches.some((errs) => errs.length === 0) ? [] : [`${path}: no anyOf branch matched`];
  }

  const type = schema['type'];
  if (typeof type === 'string' && !hasType(value, type)) {
    return [`${path}: expected ${type}, got ${Array.isArray(value) ? 'array' : typeof value}`];
  }
  const errors: string[] = [];
  if (Array.isArray(schema['enum']) && !schema['enum'].includes(value)) {
    errors.push(`${path}: value ${JSON.stringify(value)} not in enum`);
  }

  if (type === 'object' && hasType(value, 'object')) {
    const obj = value as Record<string, unknown>;
    for (const key of (schema['required'] as readonly string[] | undefined) ?? []) {
      if (!(key in obj)) errors.push(`${path}.${key}: required property missing`);
    }
    const props = schema['properties'] as Record<string, Schema> | undefined;
    const additional = schema['additionalProperties'];
    for (const [key, child] of Object.entries(obj)) {
      const prop = props?.[key];
      if (prop !== undefined) {
        errors.push(...validate(prop, child, root, `${path}.${key}`));
      } else if (typeof additional === 'object' && additional !== null) {
        errors.push(...validate(additional as Schema, child, root, `${path}.${key}`));
      }
    }
  }
  if (type === 'array' && Array.isArray(value)) {
    const items = schema['items'];
    if (typeof items === 'object' && items !== null) {
      value.forEach((child, i) =>
        errors.push(...validate(items as Schema, child, root, `${path}[${i}]`)),
      );
    }
  }
  return errors;
}

/** Render `{ data, summary?, meta }` through the REAL renderer and validate it. */
function assertConforms(toolName: string, data: unknown, summary?: string): void {
  const schema = toolOutputSchema(toolName);
  assert.ok(schema !== undefined, `no outputSchema for ${toolName}`);
  const rendered = renderStructuredResult(
    summary !== undefined ? { data, summary, meta: META } : { data, meta: META },
  );
  const root = schema as unknown as Schema;
  assert.deepEqual(validate(root, rendered.structuredContent, root, '$'), [], toolName);
}

// --- REND-11: one render object, two views ----------------------------------------

test('REND-11: text block and structuredContent are built from the same render object', () => {
  const data = { items: [{ id: '1', author: '@a', text: 'hi' }] };
  const result = renderStructuredResult({ data, summary: '1 post(s)', meta: META });

  assert.equal(result.content.length, 1);
  const block = result.content[0];
  assert.ok(block !== undefined && block.type === 'text');
  // Verbatim parity: parsing the text yields exactly the structured payload.
  assert.deepEqual(JSON.parse(block.text), result.structuredContent);
  // Stronger than equality — IDENTITY: the structured view carries the very objects that
  // were serialized, so the two representations cannot diverge by construction (REND-11).
  const structured = result.structuredContent as Record<string, unknown>;
  assert.equal(structured['data'], data);
  assert.equal(structured['meta'], META);
  assert.equal(structured['summary'], '1 post(s)');
});

test('REND-11: optional summary is omitted (never null) in both views', () => {
  const result = renderStructuredResult({ data: { ok: true }, meta: META });
  const structured = result.structuredContent as Record<string, unknown>;
  assert.deepEqual(Object.keys(structured), ['data', 'meta']);
  const block = result.content[0];
  assert.ok(block !== undefined && block.type === 'text');
  assert.deepEqual(Object.keys(JSON.parse(block.text) as object), ['data', 'meta']);
});

test('REND-11: budget_warning in meta flows through the shared payload and conforms', () => {
  const meta: ResultMeta = { ...META, budget_warning: 'session credit 80% consumed' };
  const result = renderStructuredResult({ data: {}, meta });
  const structured = result.structuredContent as { meta: ResultMeta };
  assert.equal(structured.meta.budget_warning, 'session credit 80% consumed');
  // The envelope's meta subschema declares budget_warning, so the warning conforms.
  const root = TOOL_OUTPUT_SCHEMAS['x_post_create'] as unknown as Schema;
  const metaSchema = (root['properties'] as Record<string, Schema>)['meta'];
  assert.ok(metaSchema !== undefined);
  assert.deepEqual(validate(metaSchema, structured.meta, root, '$.meta'), []);
});

// --- Coverage: every registered tool advertises a schema (fail-at-startup) --------

test('REND-11/T-310: every tool the real composition registers has an outputSchema', () => {
  const config = parseConfig({ X_MCP_AUTH_MODE: 'app-only', X_MCP_BEARER_TOKEN: 'AAAA' });
  const names = composeServer(config)
    .registry.listForMcp()
    .map((tool) => tool.name);
  assert.equal(names.length, 41, 'the Phase-1/2/3 catalog registers 41 tools');
  assertOutputSchemaCoverage(names); // must not throw
  for (const name of names) {
    const schema = toolOutputSchema(name);
    assert.ok(schema !== undefined, name);
    assert.equal(schema.type, 'object', `${name}: structuredContent must be an object`);
    assert.deepEqual(schema.required, ['data', 'meta'], name);
  }
});

test('T-310: assertOutputSchemaCoverage fails structurally for an unmapped tool', () => {
  assert.throws(
    () => assertOutputSchemaCoverage(['x_post_get', 'x_never_registered']),
    /no outputSchema for tool "x_never_registered" \(REND-11, T-310\)/,
  );
});

// --- Contract pin: the schemas are public API (semver) ----------------------------

test('T-310 contract pin: TOOL_OUTPUT_SCHEMAS matches the fixture baseline exactly', () => {
  const fixture = loadFixture<{ schemas: Record<string, unknown> }>(
    'structured/output-schemas.json',
  );
  const sorted = Object.fromEntries(
    Object.keys(TOOL_OUTPUT_SCHEMAS)
      .sort()
      .map((name) => [name, TOOL_OUTPUT_SCHEMAS[name]]),
  );
  // Output schemas are PUBLIC API (REND-11): any diff below is a semver-visible contract
  // change and must be intentional — update the fixture only in a reviewed change.
  assert.deepEqual(JSON.parse(JSON.stringify(sorted)), fixture.schemas);
});

test('T-310/T-313: schemas are deterministic, JSON-pure, deeply frozen, and budget-sized', () => {
  const first = JSON.stringify(TOOL_OUTPUT_SCHEMAS);
  assert.equal(JSON.stringify(TOOL_OUTPUT_SCHEMAS), first, 'serialization is deterministic');
  // JSON-pure: a stringify/parse round-trip loses nothing (no undefined/functions/dates).
  assert.deepEqual(JSON.parse(first), TOOL_OUTPUT_SCHEMAS);
  // Deep-frozen: the advertised contract cannot be mutated at runtime.
  const postGet = TOOL_OUTPUT_SCHEMAS['x_post_get'];
  assert.ok(postGet !== undefined);
  assert.ok(Object.isFrozen(TOOL_OUTPUT_SCHEMAS));
  assert.ok(Object.isFrozen(postGet));
  assert.ok(Object.isFrozen(postGet.properties?.['data']));
  assert.throws(() => {
    (postGet as { type: string }).type = 'array';
  }, TypeError);
  // T-313 tripwire: the full schema payload lands in every tools/list response; keep the
  // serialized total under a hard ceiling so schema growth is a conscious decision. The
  // 41-tool Wave-3 map measures ~36 kB, so the ceiling is 49,152 (3 x 16,384);
  // shrinking it back down (listing pagination / schema slimming) is owned by T-313.
  assert.ok(first.length < 49152, `serialized schemas too large: ${first.length} bytes`);
});

// --- Truthfulness: REAL renderer output conforms to the advertised schemas --------

test('REND-11/REND-2/REND-7: a real partial batch render conforms to x_post_get', () => {
  const batch = renderPosts(loadFixture<RawListResponse<RawTweet>>('posts/partial-missing.json'));
  assert.ok(
    batch.missing !== undefined && batch.missing.length > 0,
    'fixture must exercise missing[]',
  );
  assertConforms('x_post_get', batch, '1 post(s)');
});

test('REND-11: a real batch user render conforms to x_user_get', () => {
  assertConforms(
    'x_user_get',
    renderUsers(loadFixture<RawListResponse<RawUser>>('users/two-by-id.json')),
    '2 user(s)',
  );
});

test('REND-11/REND-5: real search pages (full and zero-result) conform to x_search_recent', () => {
  const page = renderPostPage(loadFixture<RawListResponse<RawTweet>>('search/recent-page.json'));
  assert.equal(page.next_token, 'abc');
  assertConforms('x_search_recent', page, '3 result(s), more available.');

  const empty = renderPostPage(loadFixture<RawListResponse<RawTweet>>('search/recent-empty.json'));
  assert.equal(empty.note, ZERO_RESULTS_NOTE);
  assertConforms('x_search_recent', empty);
});

test('REND-11: the same page shape conforms to all three timeline schemas', () => {
  const page = renderPostPage(loadFixture<RawListResponse<RawTweet>>('search/recent-page.json'));
  for (const name of ['x_timeline_home', 'x_timeline_mentions', 'x_timeline_user']) {
    assertConforms(name, page);
  }
});

test('REND-9/REND-10: the raw-mode envelope conforms via the anyOf raw branch', () => {
  const raw = loadFixture<object>('search/recent-page.json');
  assertConforms('x_search_recent', raw, '3 raw result(s).');
  assertConforms('x_post_get', raw);
  assertConforms('x_post_counts_recent', raw);
});

test('REND-11: a real rate-limit tracker snapshot conforms to x_rate_limit_status', () => {
  const tracker = createRateLimitTracker({ now: () => 0 });
  tracker.record(
    'tweets#app',
    { 'x-rate-limit-limit': '15', 'x-rate-limit-remaining': '0', 'x-rate-limit-reset': '900' },
    429,
  );
  const status = tracker.status();
  assert.equal(status.buckets.length, 1);
  assertConforms('x_rate_limit_status', status, 'rate-limit: 1 bucket(s) tracked');
});

test('REND-11/AUTH-15: the degraded app-only auth report conforms to x_auth_status', () => {
  assertConforms(
    'x_auth_status',
    {
      auth_mode: 'app-only',
      scopes: [],
      availability: ['app+user', 'app-only'],
      policy: { preset: 'read-only', cells: { 'read:content': true, 'write:content': false } },
      note: 'app-only: user-context tools are unavailable',
    },
    'auth: app-only',
  );
});

test('REND-11/POST-5/COST-4: write-tool result shapes conform to their schemas', () => {
  assertConforms('x_post_create', {
    id: '111',
    url: 'https://x.com/i/status/111',
    note: 'URL post priced higher (COST-4).',
  });
  // POST-5: idempotent delete reports success with already_deleted.
  assertConforms('x_post_delete', {
    id: '111',
    deleted: true,
    already_deleted: true,
    note: 'The post was already gone.',
  });
  assertConforms('x_like_set', {
    post_id: '1',
    url: 'https://x.com/i/status/1',
    action: 'like',
    liked: true,
  });
  assertConforms('x_repost_set', {
    post_id: '1',
    url: 'https://x.com/i/status/1',
    action: 'unrepost',
    reposted: false,
  });
  assertConforms('x_bookmark_set', {
    post_id: '1',
    url: 'https://x.com/i/status/1',
    action: 'add',
    bookmarked: true,
  });
});

// --- Truthfulness: Wave-3 tools (graph, lists, media, dm, archive) ----------------

test('REND-11: a real user page conforms to every user-page tool schema', () => {
  const page = renderUserPage(loadFixture<RawListResponse<RawUser>>('graph/followers-page.json'));
  for (const name of ['x_followers_list', 'x_following_list', 'x_user_search', 'x_list_members']) {
    assertConforms(name, page);
    // REND-9/REND-10: the raw envelope conforms via the anyOf raw branch.
    assertConforms(name, loadFixture<object>('graph/followers-page.json'));
  }
  // REND-5 degraded page: a follower carrying only an id still renders and conforms.
  assertConforms(
    'x_followers_list',
    renderUserPage(loadFixture<RawListResponse<RawUser>>('graph/followers-degraded.json')),
  );
});

test('REND-11: real list renders conform to x_list_get and x_lists_owned', () => {
  const single = loadFixture<RawSingleResponse<RawList>>('lists/single.json');
  assertConforms('x_list_get', renderList(single.data ?? {}, single.includes), 'List.');
  assertConforms('x_list_get', single); // raw mode: the exact envelope
  const owned = renderListPage(loadFixture<RawListResponse<RawList>>('lists/owned-page.json'));
  assertConforms('x_lists_owned', owned, '2 result(s).');
});

test('REND-11/DM-3: real DM pages (full and minimized) conform, and NO raw branch exists', () => {
  const res = loadFixture<RawListResponse<RawDmEvent>>('dm/events-page.json');
  const full = renderDmPage(res, ['X returns at most the last 30 days of DM events.']);
  assert.ok(full.items.length > 0 && full.items[0]?.text !== undefined);
  // DM-3 default mode strips bodies/media down to ids, timestamps, and participants.
  const minimized = {
    ...full,
    items: full.items.map(({ id, sender, created_at, conversation_id }) => ({
      id,
      sender,
      ...(created_at !== undefined ? { created_at } : {}),
      ...(conversation_id !== undefined ? { conversation_id } : {}),
    })),
  };
  for (const name of [
    'x_dm_events_list',
    'x_dm_conversation_events_list',
    'x_dm_participant_events_list',
  ]) {
    assertConforms(name, full, '2 DM event(s), more available.');
    assertConforms(name, minimized);
    // DM-3: the DM reads have no raw option, so the schema advertises NO anyOf raw branch.
    const schema = toolOutputSchema(name) as unknown as Schema;
    const dataSchema = (schema['properties'] as Record<string, Schema>)['data'];
    assert.ok(dataSchema !== undefined && !('anyOf' in dataSchema), `${name}: no raw branch`);
  }
});

test('REND-11: real archive renders conform to x_search_archive and x_post_counts_archive', () => {
  const page = renderPostPage(loadFixture<RawListResponse<RawTweet>>('archive/archive-page.json'));
  assertConforms('x_search_archive', page);
  assertConforms('x_search_archive', loadFixture<object>('archive/archive-page.json')); // raw
  assertConforms('x_post_counts_archive', {
    counts: [{ start: '2014-06-20T00:00:00.000Z', end: '2014-06-21T00:00:00.000Z', count: 17 }],
    total: 17,
    next_token: '1dr8',
  });
  assertConforms('x_post_counts_archive', loadFixture<object>('archive/counts-archive.json'));
});

test('REND-11: Wave-3 write confirmations conform to their schemas', () => {
  // pending_follow appears only for protected targets; both variants must conform.
  assertConforms('x_follow_set', { user_id: '34', action: 'follow', following: true });
  assertConforms('x_follow_set', {
    user_id: '34',
    action: 'follow',
    following: false,
    pending_follow: true,
  });
  assertConforms('x_mute_set', { user_id: '12', action: 'unmute', muting: false });
  assertConforms('x_block_set', { user_id: '12', action: 'block', blocking: true });
  assertConforms('x_list_create', { list_id: '190', name: 'AI builders', private: false });
  assertConforms('x_list_update', { list_id: '190', updated: true });
  assertConforms('x_list_delete', { list_id: '190', deleted: true });
  assertConforms('x_list_member_set', {
    list_id: '190',
    user_id: '101',
    action: 'add',
    is_member: true,
  });
  assertConforms('x_list_follow_set', { list_id: '190', action: 'follow', following: true });
  assertConforms('x_list_pin_set', { list_id: '190', action: 'unpin', pinned: false });
  // DRIFT-1: a bare 2xx send confirmation carries no ids — both variants must conform.
  assertConforms('x_dm_send', { sent: true, conversation_id: '9-777', event_id: '19' });
  assertConforms('x_dm_send', { sent: true });
});

test('REND-11/MEDIA-3: media upload and status result shapes conform', () => {
  assertConforms('x_media_upload', {
    media_id: '7100',
    media_key: '3_7100',
    processing_state: 'pending',
    media_type: 'video/mp4',
    media_category: 'tweet_video',
    size_bytes: 9_500_000,
    segments: 2,
    expires_after_secs: 86_400,
    alt_text_set: true,
  });
  // Image FINALIZE without processing_info: only the always-present fields.
  assertConforms('x_media_upload', {
    media_id: '7100',
    processing_state: 'succeeded',
    media_type: 'image/png',
    media_category: 'tweet_image',
    size_bytes: 12_345,
    segments: 1,
  });
  assertConforms('x_media_status', {
    media_id: '7100',
    processing_state: 'in_progress',
    progress_percent: 45,
    check_after_secs: 10,
  });
  assertConforms('x_media_status', { media_id: '7100', processing_state: 'succeeded' });
});

// --- The validator has teeth (guards the truthfulness tests above) ----------------

test('T-310: the in-test validator rejects non-conforming payloads', () => {
  const like = TOOL_OUTPUT_SCHEMAS['x_like_set'] as unknown as Schema;
  const bad = renderStructuredResult({
    data: { post_id: '1', url: 'u', action: 'smash', liked: 'yes' },
    meta: META,
  }).structuredContent;
  const errors = validate(like, bad, like, '$');
  assert.ok(
    errors.some((e) => e.includes('not in enum')),
    'enum violation must be caught',
  );
  assert.ok(
    errors.some((e) => e.includes('expected boolean')),
    'type violation must be caught',
  );

  // A payload missing the required `meta` envelope field must fail for every tool.
  const create = TOOL_OUTPUT_SCHEMAS['x_post_create'] as unknown as Schema;
  assert.ok(
    validate(create, { data: { id: '1', url: 'u' } }, create, '$').some((e) =>
      e.includes('$.meta: required property missing'),
    ),
  );
  // Non-object data fails BOTH anyOf branches (compact and raw) of a raw-capable tool.
  const postGet = TOOL_OUTPUT_SCHEMAS['x_post_get'] as unknown as Schema;
  const scalarData = renderStructuredResult({ data: 42, meta: META }).structuredContent;
  assert.ok(
    validate(postGet, scalarData, postGet, '$').some((e) => e.includes('no anyOf branch')),
    'scalar data must fail every anyOf branch',
  );
  // The batch schema's $ref chain resolves and enforces item shapes: validate the COMPACT
  // branch alone (the raw branch deliberately accepts any object — REND-9/REND-10).
  const dataSchema = (postGet['properties'] as Record<string, Schema>)['data'];
  assert.ok(dataSchema !== undefined);
  const compactBranch = (dataSchema['anyOf'] as Schema[])[0];
  assert.ok(compactBranch !== undefined);
  assert.ok(
    validate(compactBranch, { items: [{ id: '1', author: '@a' }] }, postGet, '$.data').some((e) =>
      e.includes('.text: required property missing'),
    ),
    'a compact post without text must not conform to the compact branch',
  );
});
