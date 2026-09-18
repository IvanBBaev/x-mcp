// The protocol facts a client meets BEFORE it calls a tool, and the one it meets when it
// gives up on a call (MCP-10). docs/13 §2 carried three of these as `probe-verified` only —
// run once by hand, pinned by nothing — because the server delegates all of them to the
// SDK: no line of `src/mcp/` reads `protocolVersion`, dispatches a method name, or turns a
// cancellation into an error code. That is exactly why they need a pin. An SDK bump can
// change any of them without touching a file this repo reviews, and the compatibility
// page would keep promising the old behaviour.
//
// Everything here runs over a real linked InMemoryTransport pair against the composed
// production object graph (MCP-2). The negotiation tests speak raw JSON-RPC on the client
// end rather than using the SDK `Client`, because that client always asks for the newest
// version — the whole point is to ask for each of the older ones.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  ErrorCode,
  LATEST_PROTOCOL_VERSION,
  McpError,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '@modelcontextprotocol/sdk/types.js';
import type {
  CallToolResult,
  InitializeResult,
  JSONRPCMessage,
  JSONRPCNotification,
  JSONRPCRequest,
  ListToolsResult,
} from '@modelcontextprotocol/sdk/types.js';

import { parseConfig } from '../../src/core/config.js';
import type { Dispatcher } from '../../src/core/ports.js';
import { composeServer } from '../../src/mcp/compose.js';
import type { Composition } from '../../src/mcp/compose.js';
import { SERVER_NAME, SERVER_VERSION } from '../../src/mcp/server.js';

import { loadFixture, mockHttp } from '../helpers/index.js';
import type { MockHttp } from '../helpers/index.js';

/**
 * The versions docs/13 §2 and §5 name, newest first. Kept as a literal — not derived from
 * the SDK — so that a dependency bump that adds or drops one fails HERE, where the failure
 * says which page to re-date, instead of silently widening or narrowing the promise.
 */
const DOCUMENTED_VERSIONS = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
  '2024-10-07',
] as const;

/** Methods the server does not advertise a capability for — every one must be `-32601`. */
const UNADVERTISED_METHODS = [
  'resources/list',
  'resources/templates/list',
  'resources/read',
  'resources/subscribe',
  'prompts/list',
  'prompts/get',
  'logging/setLevel',
  'completion/complete',
  'no/such/method',
] as const;

function appOnlyEnv(): Record<string, string> {
  return { X_MCP_AUTH_MODE: 'app-only', X_MCP_BEARER_TOKEN: 'AAAA' };
}

function composeFor(dispatcher: Dispatcher): Composition {
  return composeServer(parseConfig(appOnlyEnv()), { dispatcher });
}

function request(id: number, method: string, params?: Record<string, unknown>): JSONRPCRequest {
  return { jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) };
}

function notification(method: string): JSONRPCNotification {
  return { jsonrpc: '2.0', method };
}

function initialize(id: number, protocolVersion: string): JSONRPCRequest {
  return request(id, 'initialize', {
    protocolVersion,
    capabilities: {},
    clientInfo: { name: 'protocol-probe', version: '0.0.0' },
  });
}

/** A JSON-RPC response as it arrives on the wire — success or error, never both. */
interface WireResponse {
  readonly id: number;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

/**
 * The client end of a linked pair, driven as raw frames. Frames are queued as they arrive
 * and `response(id)` resolves the one with that id whatever else came in between, so a
 * test never depends on arrival order.
 */
interface RawPeer {
  send(message: JSONRPCMessage): Promise<void>;
  response(id: number): Promise<WireResponse>;
  close(): Promise<void>;
}

async function rawPeer(composition: Composition): Promise<RawPeer> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const inbox: WireResponse[] = [];
  const waiters: (() => void)[] = [];
  clientTransport.onmessage = (message) => {
    inbox.push(message as unknown as WireResponse);
    for (const wake of waiters.splice(0)) wake();
  };
  await clientTransport.start();
  await composition.server.connect(serverTransport);
  return {
    send: (message) => clientTransport.send(message),
    async response(id) {
      for (;;) {
        const hit = inbox.find((message) => message.id === id);
        if (hit !== undefined) return hit;
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
    },
    close: () => clientTransport.close(),
  };
}

/** Every tool name the registry would advertise — the oracle each negotiated listing must match. */
function registryNames(composition: Composition): string[] {
  return composition.registry.listForMcp().map((tool) => tool.name);
}

// --- Version negotiation ---------------------------------------------------------------

test('MCP-10: the SDK speaks exactly the versions docs/13 names — a bump re-dates the page', () => {
  assert.deepEqual([...SUPPORTED_PROTOCOL_VERSIONS], [...DOCUMENTED_VERSIONS]);
  assert.equal(LATEST_PROTOCOL_VERSION, DOCUMENTED_VERSIONS[0]);
});

for (const version of DOCUMENTED_VERSIONS) {
  test(`MCP-10: initialize with ${version} is echoed back and the whole surface follows`, async () => {
    const mock = mockHttp();
    const composition = composeFor(mock.dispatcher);
    const peer = await rawPeer(composition);
    try {
      await peer.send(initialize(1, version));
      const handshake = await peer.response(1);
      assert.equal(handshake.error, undefined, JSON.stringify(handshake.error));
      const result = handshake.result as InitializeResult;
      // The echo is the whole contract: a client that asked for an older version must be
      // told it got that version, not the newest one the server happens to know.
      assert.equal(result.protocolVersion, version);
      assert.deepEqual(result.capabilities, { tools: {} });
      assert.deepEqual(result.serverInfo, { name: SERVER_NAME, version: SERVER_VERSION });
      assert.equal(typeof result.instructions, 'string');

      // Nothing about the listing bends to the negotiated version — an older client sees
      // every tool, with the same schemas and annotations, in one page.
      await peer.send(notification('notifications/initialized'));
      await peer.send(request(2, 'tools/list'));
      const listing = (await peer.response(2)).result as ListToolsResult;
      assert.deepEqual(
        listing.tools.map((tool) => tool.name),
        registryNames(composition),
      );
      assert.equal(listing.nextCursor, undefined);
      for (const tool of listing.tools) {
        assert.ok(tool.inputSchema, `${tool.name} lost its inputSchema under ${version}`);
        assert.ok(tool.outputSchema, `${tool.name} lost its outputSchema under ${version}`);
        assert.ok(tool.annotations, `${tool.name} lost its annotations under ${version}`);
      }
    } finally {
      await peer.close();
      await mock.close();
    }
  });
}

test('MCP-10: an unrecognised protocol version is answered with the newest one, not an error', async () => {
  // A client from the future, and one that is simply wrong. The spec leaves the decision
  // to the client: the server names a version it does speak and the client either
  // continues on it or disconnects. What it must NOT do is refuse the handshake.
  for (const requested of ['2099-01-01', 'not-a-date']) {
    const mock = mockHttp();
    const peer = await rawPeer(composeFor(mock.dispatcher));
    try {
      await peer.send(initialize(1, requested));
      const handshake = await peer.response(1);
      assert.equal(handshake.error, undefined, `${requested} must not be refused`);
      const result = handshake.result as InitializeResult;
      assert.equal(result.protocolVersion, LATEST_PROTOCOL_VERSION, requested);
      assert.deepEqual(result.capabilities, { tools: {} });
    } finally {
      await peer.close();
      await mock.close();
    }
  }
});

// --- Unadvertised methods ---------------------------------------------------------------

test('MCP-10: every method behind an unadvertised capability is -32601, ping answers, and the session survives', async () => {
  const mock = mockHttp();
  const composition = composeFor(mock.dispatcher);
  const peer = await rawPeer(composition);
  try {
    await peer.send(initialize(1, LATEST_PROTOCOL_VERSION));
    await peer.response(1);
    await peer.send(notification('notifications/initialized'));

    // Each one is a JSON-RPC ERROR, not an empty result: a client that probes for
    // resources or prompts must learn there are none, not an empty list it would poll.
    let id = 10;
    for (const method of UNADVERTISED_METHODS) {
      id += 1;
      await peer.send(request(id, method));
      const reply = await peer.response(id);
      assert.equal(reply.result, undefined, `${method} must not succeed`);
      assert.equal(reply.error?.code, ErrorCode.MethodNotFound, method);
      assert.equal(reply.error?.message, 'Method not found', method);
    }

    // `ping` is the one extra method every client may rely on (SDK built-in).
    await peer.send(request(2, 'ping'));
    assert.deepEqual((await peer.response(2)).result, {});

    // Nine refused methods later the session is intact: the listing is still whole.
    await peer.send(request(3, 'tools/list'));
    const listing = (await peer.response(3)).result as ListToolsResult;
    assert.deepEqual(
      listing.tools.map((tool) => tool.name),
      registryNames(composition),
    );
  } finally {
    await peer.close();
    await mock.close();
  }
});

// --- Cancellation, end to end -----------------------------------------------------------

/** The dispatch-handler callbacks an abort ends in, under either undici handler protocol. */
interface AbortSink {
  onError?(err: Error): void;
  onResponseError?(controller: unknown, err: Error): void;
}

/**
 * Wrap a dispatcher so the test can see the abort that `fetch` relays into it. Node's
 * bundled `fetch` drives a dispatcher with the v1 protocol on Node 22 (`onError`) and the
 * v2 protocol on newer runtimes (`onResponseError`); on both, an aborted request ends in
 * that one callback with the abort reason, so that is where the observation goes. The
 * handler is shadowed with `Object.create`, not copied, so `fetch`'s own `this`-bound
 * state stays on the object it expects.
 */
function observingAborts(
  inner: Dispatcher,
  seen: unknown[],
  dispatched: { count: number },
): Dispatcher {
  const dispatcher = {
    dispatch(opts: unknown, handler: AbortSink): boolean {
      dispatched.count += 1;
      const spy = Object.create(handler) as AbortSink;
      if (typeof handler.onError === 'function') {
        spy.onError = function (this: AbortSink, err: Error) {
          seen.push(err);
          handler.onError?.call(this, err);
        };
      }
      if (typeof handler.onResponseError === 'function') {
        spy.onResponseError = function (this: AbortSink, controller: unknown, err: Error) {
          seen.push(err);
          handler.onResponseError?.call(this, controller, err);
        };
      }
      return (inner as unknown as { dispatch(o: unknown, h: AbortSink): boolean }).dispatch(
        opts,
        spy,
      );
    },
    close: () => (inner as unknown as { close(): Promise<void> }).close(),
    destroy: () => (inner as unknown as { destroy(): Promise<void> }).destroy(),
  };
  return dispatcher as unknown as Dispatcher;
}

/** Poll until `condition` holds; fail loudly instead of hanging if it never does. */
async function until(condition: () => boolean, what: string, deadlineMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    assert.ok(Date.now() - start < deadlineMs, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const POST_QUERY = {
  'tweet.fields':
    'created_at,public_metrics,referenced_tweets,attachments,note_tweet,entities,author_id',
  expansions:
    'author_id,referenced_tweets.id,referenced_tweets.id.author_id,attachments.media_keys',
  'user.fields': 'username,name,verified',
  'media.fields': 'type,url,preview_image_url,alt_text',
} as const;

function interceptPosts(mock: MockHttp) {
  return mock.pool.intercept({
    path: '/2/tweets',
    method: 'GET',
    query: { ids: '111,222', ...POST_QUERY },
  });
}

test('MCP-10: notifications/cancelled tears down the in-flight HTTP request, rejects with -32001, and the session stays usable', async () => {
  const mock = mockHttp();
  const aborts: unknown[] = [];
  const dispatched = { count: 0 };
  const composition = composeFor(observingAborts(mock.dispatcher, aborts, dispatched));
  // A reply that will not come for five seconds. If the abort never reaches the
  // dispatcher this timer keeps ticking and the wait below fails — the test cannot pass
  // by merely ignoring a late response.
  interceptPosts(mock).reply(200, loadFixture<object>('posts/two-posts.json')).delay(5_000);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'protocol-probe', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), composition.server.connect(serverTransport)]);
  try {
    const controller = new AbortController();
    const pending = client.callTool(
      { name: 'x_post_get', arguments: { ids: ['111', '222'] } },
      undefined,
      {
        signal: controller.signal,
      },
    );
    // Cancel only once the request is genuinely on the wire — that is the case the row
    // describes, and the only one where "tears down the in-flight request" means anything.
    await until(() => dispatched.count === 1, 'the HTTP request to reach the dispatcher');
    const started = Date.now();
    controller.abort('operator gave up');

    // What the client sees: the SDK rejects locally with -32001 and sends
    // `notifications/cancelled`. Well inside the mock's five-second delay.
    await assert.rejects(pending, (err: unknown) => {
      assert.ok(err instanceof McpError);
      assert.equal(err.code, ErrorCode.RequestTimeout);
      assert.match(err.message, /operator gave up/);
      return true;
    });
    assert.ok(Date.now() - started < 1_000, 'cancellation must not wait for the reply');

    // What the platform sees: the notification crossed the pair, aborted the SDK's
    // per-request signal, and that signal reached `fetch` — the dispatcher's error
    // callback fired with the abort, so the delayed reply was cancelled, not ignored.
    await until(() => aborts.length === 1, 'the abort to reach the dispatcher');

    // The session is intact: the listing is whole and a fresh call round-trips.
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name),
      registryNames(composition),
    );
    interceptPosts(mock).reply(200, loadFixture<object>('posts/two-posts.json'));
    const result = (await client.callTool({
      name: 'x_post_get',
      arguments: { ids: ['111', '222'] },
    })) as CallToolResult;
    assert.notEqual(result.isError, true);
    assert.equal(dispatched.count, 2);
    mock.assertDone();
  } finally {
    await client.close();
    await mock.close();
  }
});
