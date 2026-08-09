// Tests for the dm package (T-305): x_dm_events_list / x_dm_conversation_events_list /
// x_dm_participant_events_list / x_dm_send. Each network test builds a REAL http client
// (api/http) over an undici MockAgent and drives the handler end to end. Interceptors pin
// exact paths, methods, queries, and JSON bodies, so they stub AND assert the wire
// contract. Policy gating (POL-3/POL-4) is exercised through the policy engine's public
// API against the real ToolDefs — enforcement lives in core/policy, the tools only
// declare their cells.

import test from 'node:test';
import assert from 'node:assert/strict';

import { mapHttpError } from '../../src/api/errors.js';
import { createHttpClient } from '../../src/api/http.js';
import { XError } from '../../src/core/errors.js';
import {
  POLICY_PRESETS,
  classifyTool,
  deniedToolError,
  isSensitiveCell,
  resolvePolicy,
  resolvePolicyStrings,
} from '../../src/core/policy.js';
import { UNTRUSTED_CONTENT_NOTE } from '../../src/core/render.js';
import { ZERO_RESULTS_NOTE } from '../../src/core/render-shapes.js';
import type { CompactDm, Page } from '../../src/core/render-shapes.js';
import type { ToolContext } from '../../src/core/tooldef.js';
import {
  DM_BODIES_OMITTED_NOTE,
  DM_RETENTION_NOTE,
  dmTools,
  xDmConversationEventsList,
  xDmEventsList,
  xDmParticipantEventsList,
  xDmSend,
} from '../../src/tools/dm.js';

import { loadFixture, makePorts, mockHttp } from '../helpers/index.js';
import type { MockHttp } from '../helpers/index.js';

/** The wrapper shape of the error fixtures under test/fixtures/. */
interface ErrorFixture {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

/** The DM-event projection the endpoint layer sends (must mirror api/endpoints/dm). */
const DM_PROJECTION = {
  'dm_event.fields': 'id,text,event_type,created_at,dm_conversation_id,sender_id,attachments',
  expansions: 'sender_id,attachments.media_keys',
  'user.fields': 'username,name,verified',
  'media.fields': 'type,url,preview_image_url,alt_text',
};

/** The user.fields projection the users endpoints request (must mirror api/endpoints/users). */
const USERS_PROJECTION = {
  'user.fields':
    'created_at,description,location,public_metrics,protected,url,verified,username,name',
};

/** Build a ToolContext over a real http client bound to the mock dispatcher. */
function contextFor(mock: MockHttp): ToolContext {
  const ports = makePorts({ dispatcher: mock.dispatcher });
  const http = createHttpClient({
    sleep: ports.sleep,
    random: ports.random,
    dispatcher: mock.dispatcher,
    mapError: mapHttpError,
  });
  return { ports, http };
}

/** A context whose invoker fails loudly — proves a handler never reached the network. */
function noHttpCtx(): ToolContext {
  return {
    ports: makePorts(),
    http: {
      send: () => Promise.reject(new Error('endpoint must not be called for invalid input')),
    },
  };
}

// --- Contract axes ---------------------------------------------------------------

test('dmTools: the three reads share the read:dm axes; the send is write:dm (docs/03 rows)', () => {
  assert.deepEqual(dmTools, [
    xDmEventsList,
    xDmConversationEventsList,
    xDmParticipantEventsList,
    xDmSend,
  ]);
  const reads = [xDmEventsList, xDmConversationEventsList, xDmParticipantEventsList];
  for (const tool of reads) {
    assert.equal(tool.policy, 'read:dm');
    assert.equal(tool.availability, 'user-only');
    assert.equal(tool.cost, 'r:dm');
    assert.equal(tool.phase, 3);
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.openWorldHint, true);
    assert.deepEqual([...tool.scopes], ['dm.read', 'tweet.read', 'users.read']);
  }
  assert.equal(xDmSend.policy, 'write:dm');
  assert.equal(xDmSend.availability, 'user-only');
  assert.equal(xDmSend.cost, 'w:dm');
  assert.equal(xDmSend.phase, 3);
  assert.equal(xDmSend.annotations.readOnlyHint, false);
  assert.equal(xDmSend.annotations.destructiveHint, false);
  assert.equal(xDmSend.annotations.idempotentHint, false); // two sends = two messages
  assert.deepEqual([...xDmSend.scopes], ['dm.write', 'tweet.read', 'users.read']);
});

test('DM-1: exactly the three DM-event lookups + send — no conversations-list pretense', () => {
  // v2 has no list-conversations endpoint; the package must not pretend otherwise.
  assert.deepEqual(
    dmTools.map((tool) => tool.name),
    [
      'x_dm_events_list',
      'x_dm_conversation_events_list',
      'x_dm_participant_events_list',
      'x_dm_send',
    ],
  );
  for (const tool of dmTools) {
    assert.doesNotMatch(tool.name, /conversations_list/);
    assert.doesNotMatch(tool.description, /list (of )?conversations/i);
    assert.doesNotMatch(tool.title, /list conversations/i);
  }
});

// --- x_dm_events_list ------------------------------------------------------------

test('x_dm_events_list: GET /2/dm_events renders minimized events — no bodies by default (DM-3)', async () => {
  const mock = mockHttp();
  mock.pool
    .intercept({ path: '/2/dm_events', method: 'GET', query: DM_PROJECTION })
    .reply(200, loadFixture<Record<string, unknown>>('dm/events-page.json'));

  const out = await xDmEventsList.handler({}, contextFor(mock));
  const page = out.data as Page<Record<string, unknown>>;

  // DM-3: ids, timestamps, and participants only — no `text`, no `media`.
  assert.deepEqual(page.items, [
    {
      id: '1900000000000000002',
      sender: '@dana_dm',
      created_at: '2026-07-29T10:05:00.000Z',
      conversation_id: '9-777',
    },
    {
      id: '1900000000000000001',
      sender: '@me_handle',
      created_at: '2026-07-29T10:00:00.000Z',
      conversation_id: '9-777',
    },
  ]);
  assert.equal(page.result_count, 2);
  assert.equal(page.next_token, 'dmtok1'); // PAGE-1: response cursor surfaced verbatim
  assert.ok(page.note);
  assert.ok(page.note.includes(DM_RETENTION_NOTE)); // DM-2
  assert.ok(page.note.includes(DM_BODIES_OMITTED_NOTE)); // DM-3 opt-in hint
  assert.equal(out.summary, '2 DM event(s), more available.');
  mock.assertDone();
  await mock.close();
});

test('DM-2: the 30-day retention note is on EVERY DM read — even an empty page (REND-1)', async () => {
  const mock = mockHttp();
  mock.pool
    .intercept({ path: '/2/dm_events', method: 'GET', query: DM_PROJECTION })
    .reply(200, loadFixture<Record<string, unknown>>('dm/events-empty.json'));

  const out = await xDmEventsList.handler({}, contextFor(mock));
  const page = out.data as Page<unknown>;

  assert.equal(page.result_count, 0);
  assert.deepEqual(page.items, []);
  assert.ok(page.note);
  assert.ok(page.note.includes(ZERO_RESULTS_NOTE)); // REND-1: empty is explicit, not an error
  assert.match(page.note, /X returns at most the last 30 days of DM events/); // DM-2 verbatim
  mock.assertDone();
  await mock.close();
});

test('DM-3: include_text: true returns sanitized bodies under the REND-6 untrusted note', async () => {
  const mock = mockHttp();
  mock.pool
    .intercept({ path: '/2/dm_events', method: 'GET', query: DM_PROJECTION })
    .reply(200, loadFixture<Record<string, unknown>>('dm/events-page.json'));

  const out = await xDmEventsList.handler({ include_text: true }, contextFor(mock));
  const page = out.data as Page<CompactDm>;

  assert.equal(page.items[0]?.text, 'All on track for Friday. Sending the checklist tomorrow.');
  assert.equal(page.items[1]?.text, 'Hey - quick check-in about the launch.');
  assert.ok(page.note);
  // REND-6: bodies and sender names are third-party content — the strongest treatment.
  assert.ok(page.note.includes(UNTRUSTED_CONTENT_NOTE));
  assert.ok(page.note.includes(DM_RETENTION_NOTE)); // DM-2 still present with bodies
  assert.ok(!page.note.includes(DM_BODIES_OMITTED_NOTE));
  mock.assertDone();
  await mock.close();
});

test('PAGE-1/PAGE-3: page_token bridges to pagination_token verbatim; max_results clamps to 100', async () => {
  const mock = mockHttp();
  // Intercept pins max_results=100 (clamped), not 250 (requested): a match proves the
  // clamp reached the wire, since undici string-compares the full sorted query.
  mock.pool
    .intercept({
      path: '/2/dm_events',
      method: 'GET',
      query: { ...DM_PROJECTION, max_results: '100', pagination_token: 'dmtok1' },
    })
    .reply(200, loadFixture<Record<string, unknown>>('dm/events-empty.json'));

  const out = await xDmEventsList.handler(
    { max_results: 250, page_token: 'dmtok1' },
    contextFor(mock),
  );
  const page = out.data as Page<unknown>;
  assert.ok(page.note);
  assert.match(page.note, /max_results adjusted to 100/); // PAGE-3 note
  mock.assertDone();
  await mock.close();
});

// --- x_dm_conversation_events_list -----------------------------------------------

test('x_dm_conversation_events_list: GET /2/dm_conversations/:id/dm_events', async () => {
  const mock = mockHttp();
  mock.pool
    .intercept({ path: '/2/dm_conversations/9-777/dm_events', method: 'GET', query: DM_PROJECTION })
    .reply(200, loadFixture<Record<string, unknown>>('dm/events-page.json'));

  const out = await xDmConversationEventsList.handler(
    { conversation_id: '9-777' },
    contextFor(mock),
  );
  const page = out.data as Page<{ conversation_id?: string }>;
  assert.equal(page.result_count, 2);
  assert.equal(page.items[0]?.conversation_id, '9-777');
  assert.ok(page.note);
  assert.ok(page.note.includes(DM_RETENTION_NOTE)); // DM-2
  mock.assertDone();
  await mock.close();
});

test('a malformed conversation_id rejects (validation) before ANY request', async () => {
  // The stub invoker rejects loudly, so a passing test proves nothing was spent.
  for (const bad of ['not-an-id', '123-', '@dana_dm', '1-2-3']) {
    await assert.rejects(
      () => xDmConversationEventsList.handler({ conversation_id: bad }, noHttpCtx()),
      (err: unknown) => {
        assert.ok(XError.is(err));
        assert.equal(err.kind, 'validation');
        return true;
      },
    );
  }
});

// --- x_dm_participant_events_list ------------------------------------------------

test('x_dm_participant_events_list: GET /2/dm_conversations/with/:participant_id/dm_events', async () => {
  const mock = mockHttp();
  mock.pool
    .intercept({
      path: '/2/dm_conversations/with/777/dm_events',
      method: 'GET',
      query: DM_PROJECTION,
    })
    .reply(200, loadFixture<Record<string, unknown>>('dm/events-page.json'));

  const out = await xDmParticipantEventsList.handler({ participant: '777' }, contextFor(mock));
  const page = out.data as Page<unknown>;
  assert.equal(page.result_count, 2);
  mock.assertDone();
  await mock.close();
});

test('REND-8: a @handle participant resolves to its numeric id before the DM read', async () => {
  const mock = mockHttp();
  mock.pool
    .intercept({ path: '/2/users/by/username/dana_dm', method: 'GET', query: USERS_PROJECTION })
    .reply(200, { data: { id: '777', username: 'dana_dm', name: 'Dana' } });
  mock.pool
    .intercept({
      path: '/2/dm_conversations/with/777/dm_events',
      method: 'GET',
      query: DM_PROJECTION,
    })
    .reply(200, loadFixture<Record<string, unknown>>('dm/events-empty.json'));

  const out = await xDmParticipantEventsList.handler({ participant: '@dana_dm' }, contextFor(mock));
  assert.equal((out.data as Page<unknown>).result_count, 0);
  mock.assertDone();
  await mock.close();
});

test('participant "me" rejects (validation) before ANY request — a DM needs the OTHER user', async () => {
  await assert.rejects(
    () => xDmParticipantEventsList.handler({ participant: 'me' }, noHttpCtx()),
    (err: unknown) => {
      assert.ok(XError.is(err));
      assert.equal(err.kind, 'validation');
      assert.match(err.message, /OTHER user/);
      return true;
    },
  );
});

// --- x_dm_send -------------------------------------------------------------------

test('x_dm_send to a participant: POST /2/dm_conversations/with/:id/messages with the text body', async () => {
  const mock = mockHttp();
  mock.pool
    .intercept({
      path: '/2/dm_conversations/with/777/messages',
      method: 'POST',
      body: '{"text":"hello"}',
    })
    .reply(201, loadFixture<Record<string, unknown>>('dm/send-created.json'));

  const out = await xDmSend.handler({ participant: '777', text: 'hello' }, contextFor(mock));
  assert.deepEqual(out.data, {
    sent: true,
    conversation_id: '9-777',
    event_id: '1900000000000000009',
  });
  assert.equal(out.summary, 'Sent DM to conversation 9-777.');
  mock.assertDone();
  await mock.close();
});

test('x_dm_send to a conversation: POST /2/dm_conversations/:id/messages', async () => {
  const mock = mockHttp();
  mock.pool
    .intercept({
      path: '/2/dm_conversations/9-777/messages',
      method: 'POST',
      body: '{"text":"see you tomorrow"}',
    })
    .reply(201, loadFixture<Record<string, unknown>>('dm/send-created.json'));

  const out = await xDmSend.handler(
    { conversation_id: '9-777', text: 'see you tomorrow' },
    contextFor(mock),
  );
  const data = out.data as { sent: boolean; conversation_id?: string };
  assert.equal(data.sent, true);
  assert.equal(data.conversation_id, '9-777');
  mock.assertDone();
  await mock.close();
});

test('x_dm_send: a 2xx confirmation without the documented envelope still reports sent (DRIFT-1)', async () => {
  const mock = mockHttp();
  mock.pool
    .intercept({
      path: '/2/dm_conversations/with/777/messages',
      method: 'POST',
      body: '{"text":"ping"}',
    })
    .reply(201, {});

  const out = await xDmSend.handler({ participant: '777', text: 'ping' }, contextFor(mock));
  assert.deepEqual(out.data, { sent: true });
  assert.equal(out.summary, 'Sent DM.');
  mock.assertDone();
  await mock.close();
});

test('x_dm_send: both targets, no target, and a bad conversation_id all reject pre-network', async () => {
  // Both targets.
  await assert.rejects(
    () =>
      xDmSend.handler({ participant: '777', conversation_id: '9-777', text: 'hi' }, noHttpCtx()),
    (err: unknown) => {
      assert.ok(XError.is(err));
      assert.equal(err.kind, 'validation');
      assert.match(err.message, /exactly ONE target/);
      return true;
    },
  );
  // No target.
  await assert.rejects(
    () => xDmSend.handler({ text: 'hi' }, noHttpCtx()),
    (err: unknown) => {
      assert.ok(XError.is(err));
      assert.equal(err.kind, 'validation');
      assert.match(err.message, /conversation_id or participant/);
      return true;
    },
  );
  // Malformed conversation id.
  await assert.rejects(
    () => xDmSend.handler({ conversation_id: 'nope', text: 'hi' }, noHttpCtx()),
    (err: unknown) => {
      assert.ok(XError.is(err));
      assert.equal(err.kind, 'validation');
      return true;
    },
  );
});

test('DM-4: sending to a non-follower / DMs-closed target is a typed forbidden with the platform reason', async () => {
  const fx = loadFixture<ErrorFixture>('dm/403-dm-not-permitted.json');
  const mock = mockHttp();
  mock.pool
    .intercept({
      path: '/2/dm_conversations/with/777/messages',
      method: 'POST',
      body: '{"text":"hello?"}',
    })
    .reply(fx.status, fx.body as Record<string, unknown>, { headers: fx.headers });

  await assert.rejects(
    () => xDmSend.handler({ participant: '777', text: 'hello?' }, contextFor(mock)),
    (err: unknown) => {
      assert.ok(XError.is(err));
      assert.equal(err.kind, 'forbidden');
      // The platform reason passes through in data (DRIFT-2), never as the message itself.
      assert.match(String(err.data.platform_detail), /not authorized to send a Direct Message/);
      return true;
    },
  );
  mock.assertDone();
  await mock.close();
});

test('DM-4: the ~1,440/24-h send cap (a RATE-6-style window) is declared on the tool', () => {
  assert.match(xDmSend.description, /1,440/);
  assert.match(xDmSend.description, /24 hours/);
});

// --- Policy gating (POL-3 / POL-4) ------------------------------------------------

test('POL-3/POL-4: NO preset — including full — grants read:dm or write:dm', () => {
  for (const preset of POLICY_PRESETS) {
    const policy = resolvePolicy({ preset });
    for (const tool of dmTools) {
      assert.equal(
        classifyTool(policy, tool).allowed,
        false,
        `${tool.name} must be denied under preset "${preset}"`,
      );
    }
  }
});

test('POL-3: an explicit ALLOW override enables DM cells on any preset; DENY still wins', () => {
  // POL-4: `read:dm` is reachable on the default read-only preset only via explicit opt-in.
  const opted = resolvePolicyStrings({
    policy: 'read-only',
    allow: 'read:dm,write:dm',
  });
  assert.equal(classifyTool(opted, xDmEventsList).allowed, true);
  assert.equal(classifyTool(opted, xDmSend).allowed, true);

  // deny > allow (POL-2/3): the same cell in ALLOW and DENY stays denied, even on `full`.
  const denied = resolvePolicyStrings({ policy: 'full', allow: 'write:dm', deny: 'write:dm' });
  assert.equal(classifyTool(denied, xDmSend).allowed, false);
  assert.equal(classifyTool(denied, xDmEventsList).allowed, false); // read:dm never granted
});

test('POL-7: DM cells are SENSITIVE — a denial never names the unlock env var', () => {
  assert.equal(isSensitiveCell('read:dm'), true);
  assert.equal(isSensitiveCell('write:dm'), true);
  for (const cell of ['read:dm', 'write:dm'] as const) {
    const err = deniedToolError(cell, 'full');
    assert.doesNotMatch(err.message, /X_MCP_POLICY_ALLOW/);
    assert.match(err.message, new RegExp(cell)); // the blocked cell IS named
  }
});

// --- Input schema boundary --------------------------------------------------------

test('input schemas: empty/oversized text, unknown keys, and bad shapes all reject', () => {
  // .strict(): unknown keys are refused, not silently dropped.
  assert.equal(xDmEventsList.input.safeParse({ raw: true }).success, false);
  assert.equal(
    xDmSend.input.safeParse({ participant: '777', text: 'hi', priority: 'high' }).success,
    false,
  );

  // Text bounds: 1..10,000 characters.
  assert.equal(xDmSend.input.safeParse({ participant: '777', text: '' }).success, false);
  assert.equal(
    xDmSend.input.safeParse({ participant: '777', text: 'x'.repeat(10_001) }).success,
    false,
  );
  assert.equal(xDmSend.input.safeParse({ participant: '777' }).success, false); // text required

  // Required references.
  assert.equal(xDmConversationEventsList.input.safeParse({}).success, false);
  assert.equal(xDmParticipantEventsList.input.safeParse({ participant: '' }).success, false);

  // The happy shapes parse.
  assert.equal(xDmEventsList.input.safeParse({}).success, true);
  assert.equal(
    xDmEventsList.input.safeParse({ max_results: 50, page_token: 't', include_text: true }).success,
    true,
  );
  assert.equal(
    xDmConversationEventsList.input.safeParse({ conversation_id: '9-777' }).success,
    true,
  );
  assert.equal(xDmSend.input.safeParse({ conversation_id: '9-777', text: 'ok' }).success, true);
});
