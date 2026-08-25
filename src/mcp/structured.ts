// Structured tool output (T-310; docs/08 WP-3.8; docs/09 §5 Wave 3). Two halves:
//
//   • `renderStructuredResult` — the tools/call success renderer. It builds the
//     `{ data, summary?, meta }` payload object ONCE and hands the very same object to
//     both the text content block and `structuredContent` (REND-11: the two views are
//     generated from the same render object and can never disagree).
//   • `TOOL_OUTPUT_SCHEMAS` / `toolOutputSchema` — a static, hand-written JSON Schema per
//     tool result shape, advertised as `outputSchema` in tools/list. The schemas mirror
//     the FROZEN compact render shapes (core/render-shapes, docs/02 §5.2) — `required`
//     lists exactly the non-optional fields of the frozen TS contracts, optional fields
//     are omitted-not-null. They are deep-frozen, deterministic, and deliberately terse
//     (near-zero descriptions): serialized schemas land in every tools/list response and
//     count against the context budget (T-313).
//
// The schemas join the PUBLIC API under semver rules: the contract baseline lives in
// test/fixtures/structured/output-schemas.json and the pin test fails on any drift.
//
// Error results stay text-only (`isError: true`, no structuredContent): the MCP spec and
// the SDK's client-side Ajv validation both exempt error results from outputSchema
// conformance, so `renderError` in mcp/server is untouched.
//
// Raw mode (REND-9/REND-10): raw-capable read tools return the uncompacted API envelope
// under `raw: true`, so their `data` schema is an `anyOf` of the compact shape and a
// permissive object branch — the advertised schema stays truthful for both modes.
//
// NOT here (T-311 owns them): cancellation generalization (MCP-7) and the parallel-call
// safety additions (MCP-8) — this module holds no state and adds no seams they need.

import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

import type { ToolResult } from '../core/registry.js';

/** The wire type tools/list advertises: a JSON Schema object (SDK passthrough shape). */
export type OutputSchema = NonNullable<Tool['outputSchema']>;

/** A JSON-serializable schema node. Loose on purpose — outputSchema is wire JSON. */
type SchemaNode = { readonly [key: string]: unknown };

// --- Building blocks -------------------------------------------------------------

const STR: SchemaNode = { type: 'string' };
const NUM: SchemaNode = { type: 'number' };
const BOOL: SchemaNode = { type: 'boolean' };

/** ResultMeta (core/tooldef, COST-3): advisory credit accounting on every result. */
const META: SchemaNode = {
  type: 'object',
  properties: { cost_usd: NUM, session_total_usd: NUM, budget_warning: STR },
  required: ['cost_usd', 'session_total_usd'],
};

/** The `raw: true` branch (REND-9/REND-10): the exact, uncompacted X API envelope. */
const RAW_ENVELOPE: SchemaNode = {
  type: 'object',
  description: 'Uncompacted X API envelope (raw: true).',
};

/** `anyOf` of the compact shape and the raw envelope, for raw-capable read tools. */
function compactOrRaw(compact: SchemaNode): SchemaNode {
  return { anyOf: [compact, RAW_ENVELOPE] };
}

/** `Page<T>` (frozen; REND-5/REND-10): `next_token`/`note` present only when meaningful. */
function pageOf(item: SchemaNode): SchemaNode {
  return {
    type: 'object',
    properties: {
      items: { type: 'array', items: item },
      result_count: NUM,
      next_token: STR,
      note: STR,
    },
    required: ['items', 'result_count'],
  };
}

/** `BatchResult<T>` (frozen; REND-2): resolved items plus classified `missing` entries. */
function batchOf(item: SchemaNode): SchemaNode {
  return {
    type: 'object',
    properties: {
      items: { type: 'array', items: item },
      missing: { type: 'array', items: { $ref: '#/$defs/missing' } },
    },
    required: ['items'],
  };
}

/**
 * Wrap a tool's `data` schema in the registry result envelope `{ data, summary?, meta }`
 * (docs/02 §5) — the exact object `renderStructuredResult` emits. `$defs` (shared shapes
 * referenced from `data`) sit at the schema root so `#/$defs/...` refs resolve.
 */
function envelope(data: SchemaNode, defs?: Readonly<Record<string, SchemaNode>>): OutputSchema {
  return {
    type: 'object',
    properties: { data, summary: STR, meta: META },
    required: ['data', 'meta'],
    ...(defs !== undefined ? { $defs: defs } : {}),
  };
}

// --- Shared $defs: the frozen compact render shapes (core/render-shapes) ----------

/** `Missing` (REND-7): safe scalars only, reason from the fixed vocabulary. */
const MISSING: SchemaNode = {
  type: 'object',
  properties: {
    id: STR,
    reason: {
      type: 'string',
      enum: ['not-found', 'deleted', 'suspended', 'protected', 'unauthorized', 'unavailable'],
    },
    resource_type: STR,
  },
  required: ['id', 'reason'],
};

const POST_REF: SchemaNode = {
  type: 'object',
  properties: { id: STR, author: STR },
  required: ['id'],
};

const POST_METRICS: SchemaNode = {
  type: 'object',
  properties: {
    replies: NUM,
    reposts: NUM,
    likes: NUM,
    quotes: NUM,
    bookmarks: NUM,
    impressions: NUM,
  },
};

const COMPACT_MEDIA: SchemaNode = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['photo', 'video', 'animated_gif'] },
    url: STR,
    alt_text: STR,
  },
  required: ['type'],
};

const COMPACT_POST: SchemaNode = {
  type: 'object',
  properties: {
    id: STR,
    author: STR,
    text: STR,
    created_at: STR,
    metrics: { $ref: '#/$defs/post_metrics' },
    reply_to: { $ref: '#/$defs/post_ref' },
    quoted: { $ref: '#/$defs/post_ref' },
    media: { type: 'array', items: { $ref: '#/$defs/compact_media' } },
    url: STR,
    note_tweet: STR,
    truncated: BOOL,
  },
  required: ['id', 'author', 'text'],
};

const USER_METRICS: SchemaNode = {
  type: 'object',
  properties: { followers: NUM, following: NUM, posts: NUM, listed: NUM },
};

const COMPACT_USER: SchemaNode = {
  type: 'object',
  properties: {
    id: STR,
    handle: STR,
    name: STR,
    description: STR,
    verified: BOOL,
    protected: BOOL,
    created_at: STR,
    location: STR,
    url: STR,
    metrics: { $ref: '#/$defs/user_metrics' },
  },
  required: ['id', 'handle'],
};

/** $defs bundle for every post-carrying tool; batch tools add `missing` (REND-2). */
const POST_DEFS: Readonly<Record<string, SchemaNode>> = {
  compact_post: COMPACT_POST,
  post_ref: POST_REF,
  post_metrics: POST_METRICS,
  compact_media: COMPACT_MEDIA,
};

const USER_DEFS: Readonly<Record<string, SchemaNode>> = {
  compact_user: COMPACT_USER,
  user_metrics: USER_METRICS,
};

/**
 * `CompactDm` (core/render-shapes). `text`/`media` are present only under
 * `include_text: true` — the default DM-3 render minimizes items to ids, timestamps, and
 * participants — so the schema keeps them optional to stay truthful for BOTH modes.
 */
const COMPACT_DM: SchemaNode = {
  type: 'object',
  properties: {
    id: STR,
    sender: STR,
    text: STR,
    created_at: STR,
    conversation_id: STR,
    media: { type: 'array', items: { $ref: '#/$defs/compact_media' } },
  },
  required: ['id', 'sender'],
};

const DM_DEFS: Readonly<Record<string, SchemaNode>> = {
  compact_dm: COMPACT_DM,
  compact_media: COMPACT_MEDIA,
};

/** `CompactList` (core/render-shapes): `owner` is omitted when unresolvable (REND-5). */
const COMPACT_LIST: SchemaNode = {
  type: 'object',
  properties: {
    id: STR,
    name: STR,
    description: STR,
    private: BOOL,
    member_count: NUM,
    follower_count: NUM,
    owner: STR,
  },
  required: ['id', 'name'],
};

const LIST_DEFS: Readonly<Record<string, SchemaNode>> = {
  compact_list: COMPACT_LIST,
};

// --- Per-tool data shapes ---------------------------------------------------------

/** `x_auth_status` report (tools/auth, AUTH-15 degraded shape included). */
const AUTH_STATUS_DATA: SchemaNode = {
  type: 'object',
  properties: {
    auth_mode: { type: 'string', enum: ['app-only', 'user'] },
    scopes: { type: 'array', items: STR },
    availability: { type: 'array', items: STR },
    policy: {
      type: 'object',
      properties: {
        preset: STR,
        cells: { type: 'object', additionalProperties: BOOL },
      },
      required: ['preset', 'cells'],
    },
    me: { type: 'object', properties: { id: STR, handle: STR }, required: ['id'] },
    note: STR,
  },
  required: ['auth_mode', 'scopes', 'availability', 'policy'],
};

/** `RateLimitStatus` (api/ratelimit; local table dump, RATE-1). */
const RATE_LIMIT_DATA: SchemaNode = {
  type: 'object',
  properties: {
    buckets: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: STR,
          windows: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                kind: { type: 'string', enum: ['standard', 'app-24h'] },
                limit: NUM,
                remaining: NUM,
                reset_at: STR,
                seconds_until_reset: NUM,
                exhausted: BOOL,
              },
              required: ['kind', 'remaining', 'reset_at', 'seconds_until_reset', 'exhausted'],
            },
          },
        },
        required: ['key', 'windows'],
      },
    },
  },
  required: ['buckets'],
};

/** `x_post_counts_recent` / `x_post_counts_archive` compact histogram (search, archive). */
const COUNTS_DATA: SchemaNode = {
  type: 'object',
  properties: {
    counts: {
      type: 'array',
      items: {
        type: 'object',
        properties: { start: STR, end: STR, count: NUM },
        required: ['count'],
      },
    },
    total: NUM,
    next_token: STR,
  },
  required: ['counts', 'total'],
};

/** `x_post_create` result (COST-4 note included when the text carries a URL). */
const POST_CREATE_DATA: SchemaNode = {
  type: 'object',
  properties: { id: STR, url: STR, note: STR },
  required: ['id', 'url'],
};

/** `x_post_delete` result (POST-5: idempotent delete reports `already_deleted`). */
const POST_DELETE_DATA: SchemaNode = {
  type: 'object',
  properties: { id: STR, deleted: BOOL, already_deleted: BOOL, note: STR },
  required: ['id', 'deleted'],
};

/** One reversible engagement result (`x_like_set` / `x_repost_set` / `x_bookmark_set`). */
function engagementData(actions: readonly string[], state: string): SchemaNode {
  return {
    type: 'object',
    properties: {
      post_id: STR,
      url: STR,
      action: { type: 'string', enum: actions },
      [state]: BOOL,
    },
    required: ['post_id', 'url', 'action', state],
  };
}

/**
 * One reversible toggle-write confirmation (`x_mute_set`, `x_block_set`, list follow/pin):
 * the target id field, the `action` taken, and the resulting boolean state.
 */
function toggleData(idField: string, actions: readonly string[], state: string): SchemaNode {
  return {
    type: 'object',
    properties: {
      [idField]: STR,
      action: { type: 'string', enum: actions },
      [state]: BOOL,
    },
    required: [idField, 'action', state],
  };
}

/** `x_follow_set` result: `pending_follow` appears only when the target is protected. */
const FOLLOW_SET_DATA: SchemaNode = {
  type: 'object',
  properties: {
    user_id: STR,
    action: { type: 'string', enum: ['follow', 'unfollow'] },
    following: BOOL,
    pending_follow: BOOL,
  },
  required: ['user_id', 'action', 'following'],
};

/** `x_list_create` result: `private` is always reported (defaults to false). */
const LIST_CREATE_DATA: SchemaNode = {
  type: 'object',
  properties: { list_id: STR, name: STR, private: BOOL },
  required: ['list_id', 'name', 'private'],
};

/** `x_list_update` / `x_list_delete` confirmation: the list id plus one boolean outcome. */
function listOutcomeData(flag: string): SchemaNode {
  return {
    type: 'object',
    properties: { list_id: STR, [flag]: BOOL },
    required: ['list_id', flag],
  };
}

/** `x_list_member_set` result: both ids echoed alongside the resulting membership. */
const LIST_MEMBER_SET_DATA: SchemaNode = {
  type: 'object',
  properties: {
    list_id: STR,
    user_id: STR,
    action: { type: 'string', enum: ['add', 'remove'] },
    is_member: BOOL,
  },
  required: ['list_id', 'user_id', 'action', 'is_member'],
};

/**
 * `x_media_upload` result (MEDIA-1/MEDIA-3). `processing_state` is an OPEN string — the
 * platform vocabulary (`pending`/`in_progress`/`succeeded`/…) is not contractual, and an
 * enum would reject a legitimate render on vocabulary drift. Alt-text and expiry fields
 * appear only when applicable (best-effort alt text; FINALIZE echo).
 */
const MEDIA_UPLOAD_DATA: SchemaNode = {
  type: 'object',
  properties: {
    media_id: STR,
    media_key: STR,
    processing_state: STR,
    media_type: STR,
    media_category: { type: 'string', enum: ['tweet_image', 'tweet_gif', 'tweet_video'] },
    size_bytes: NUM,
    segments: NUM,
    expires_after_secs: NUM,
    alt_text_set: BOOL,
    note: STR,
  },
  required: [
    'media_id',
    'processing_state',
    'media_type',
    'media_category',
    'size_bytes',
    'segments',
  ],
};

/** `x_media_status` poll result (MEDIA-3): progress fields appear only while processing. */
const MEDIA_STATUS_DATA: SchemaNode = {
  type: 'object',
  properties: {
    media_id: STR,
    processing_state: STR,
    progress_percent: NUM,
    check_after_secs: NUM,
  },
  required: ['media_id', 'processing_state'],
};

/** `x_dm_send` confirmation (DRIFT-1: ids appear only when the envelope echoes them). */
const DM_SEND_DATA: SchemaNode = {
  type: 'object',
  properties: { sent: BOOL, conversation_id: STR, event_id: STR },
  required: ['sent'],
};

/**
 * `x_usage_get` report (WP-3.11). Two deliberately separate halves: `platform` is the X
 * project's own post-READ COUNTS against the monthly cap (never money — X publishes no
 * spend API), `session_budget` is this process's local dollar estimate. `note` is required
 * so the distinction travels with every result and cannot be schema-optional away.
 */
const USAGE_DATA: SchemaNode = {
  type: 'object',
  properties: {
    platform: {
      type: 'object',
      properties: {
        project_id: STR,
        posts_read: NUM,
        cap: NUM,
        percent_used: NUM,
        cap_reset_day: NUM,
        daily: {
          type: 'array',
          items: {
            type: 'object',
            properties: { date: STR, posts_read: NUM },
            required: ['date', 'posts_read'],
          },
        },
        by_app: {
          type: 'array',
          items: {
            type: 'object',
            properties: { client_app_id: STR, posts_read: NUM },
            required: ['client_app_id', 'posts_read'],
          },
        },
      },
      required: ['posts_read'],
    },
    session_budget: {
      type: 'object',
      properties: {
        spent_usd: NUM,
        mode: { type: 'string', enum: ['warn', 'hard'] },
        limit_usd: NUM,
        remaining_usd: NUM,
        percent_used: NUM,
      },
      required: ['spent_usd', 'mode'],
    },
    note: STR,
  },
  required: ['platform', 'session_budget', 'note'],
};

/** A page of compact posts or the raw envelope — search (recent + archive), timelines. */
const POST_PAGE_OR_RAW = compactOrRaw(pageOf({ $ref: '#/$defs/compact_post' }));

/** A page of compact users or the raw envelope — graph lists, user search, list members. */
const USER_PAGE_OR_RAW = compactOrRaw(pageOf({ $ref: '#/$defs/compact_user' }));

/** A page of compact lists or the raw envelope — `x_lists_owned`. */
const LIST_PAGE_OR_RAW = compactOrRaw(pageOf({ $ref: '#/$defs/compact_list' }));

/**
 * A page of compact DM events — deliberately NO raw branch: the DM reads expose no
 * `raw: true` option (DM-3; raw payloads would bypass minimization and sanitization).
 */
const DM_PAGE = pageOf({ $ref: '#/$defs/compact_dm' });

// --- The public schema map --------------------------------------------------------

/** Recursively freeze the schema map: the schemas are contracts, not mutable state. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * `outputSchema` per registered tool — PUBLIC API (semver; pinned by the contract
 * fixture). Every registered tool MUST have an entry; `assertOutputSchemaCoverage`
 * enforces it at composition time, the same fail-at-startup stance as TOOL_BUCKETS
 * (INT-3) in mcp/compose.
 */
export const TOOL_OUTPUT_SCHEMAS: Readonly<Record<string, OutputSchema>> = deepFreeze({
  x_auth_status: envelope(AUTH_STATUS_DATA),
  x_rate_limit_status: envelope(RATE_LIMIT_DATA),
  x_post_get: envelope(compactOrRaw(batchOf({ $ref: '#/$defs/compact_post' })), {
    ...POST_DEFS,
    missing: MISSING,
  }),
  x_user_get: envelope(compactOrRaw(batchOf({ $ref: '#/$defs/compact_user' })), {
    ...USER_DEFS,
    missing: MISSING,
  }),
  x_search_recent: envelope(POST_PAGE_OR_RAW, POST_DEFS),
  x_post_counts_recent: envelope(compactOrRaw(COUNTS_DATA)),
  x_post_create: envelope(POST_CREATE_DATA),
  x_post_delete: envelope(POST_DELETE_DATA),
  x_like_set: envelope(engagementData(['like', 'unlike'], 'liked')),
  x_repost_set: envelope(engagementData(['repost', 'unrepost'], 'reposted')),
  x_bookmark_set: envelope(engagementData(['add', 'remove'], 'bookmarked')),
  x_timeline_home: envelope(POST_PAGE_OR_RAW, POST_DEFS),
  x_timeline_mentions: envelope(POST_PAGE_OR_RAW, POST_DEFS),
  x_timeline_user: envelope(POST_PAGE_OR_RAW, POST_DEFS),
  // Wave 3 (T-310 follow-up), in composition order: graph, lists, media, dm, archive.
  x_follow_set: envelope(FOLLOW_SET_DATA),
  x_mute_set: envelope(toggleData('user_id', ['mute', 'unmute'], 'muting')),
  x_block_set: envelope(toggleData('user_id', ['block', 'unblock'], 'blocking')),
  x_followers_list: envelope(USER_PAGE_OR_RAW, USER_DEFS),
  x_following_list: envelope(USER_PAGE_OR_RAW, USER_DEFS),
  x_user_search: envelope(USER_PAGE_OR_RAW, USER_DEFS),
  x_list_create: envelope(LIST_CREATE_DATA),
  x_list_update: envelope(listOutcomeData('updated')),
  x_list_delete: envelope(listOutcomeData('deleted')),
  x_list_get: envelope(compactOrRaw({ $ref: '#/$defs/compact_list' }), LIST_DEFS),
  x_lists_owned: envelope(LIST_PAGE_OR_RAW, LIST_DEFS),
  x_list_member_set: envelope(LIST_MEMBER_SET_DATA),
  x_list_members: envelope(USER_PAGE_OR_RAW, USER_DEFS),
  x_list_timeline: envelope(POST_PAGE_OR_RAW, POST_DEFS),
  x_list_follow_set: envelope(toggleData('list_id', ['follow', 'unfollow'], 'following')),
  x_list_pin_set: envelope(toggleData('list_id', ['pin', 'unpin'], 'pinned')),
  x_media_upload: envelope(MEDIA_UPLOAD_DATA),
  x_media_status: envelope(MEDIA_STATUS_DATA),
  x_dm_events_list: envelope(DM_PAGE, DM_DEFS),
  x_dm_conversation_events_list: envelope(DM_PAGE, DM_DEFS),
  x_dm_participant_events_list: envelope(DM_PAGE, DM_DEFS),
  x_dm_send: envelope(DM_SEND_DATA),
  x_search_archive: envelope(POST_PAGE_OR_RAW, POST_DEFS),
  x_post_counts_archive: envelope(compactOrRaw(COUNTS_DATA)),
  x_usage_get: envelope(compactOrRaw(USAGE_DATA)),
  // Phase-3 completions (decisions/0002): the bookmark pair's read half and reply
  // moderation, which reports the same shape as the engagement toggles.
  x_bookmarks_list: envelope(POST_PAGE_OR_RAW, POST_DEFS),
  x_post_hide_reply: envelope(engagementData(['hide', 'unhide'], 'hidden')),
});

/** The static `outputSchema` for one tool, or `undefined` for an unknown name. */
export function toolOutputSchema(toolName: string): OutputSchema | undefined {
  return TOOL_OUTPUT_SCHEMAS[toolName];
}

/**
 * Startup guard for the composition root: every registered tool must advertise an output
 * schema (REND-11 — a tool whose structured content has no published contract is a wiring
 * bug). Mirrors the TOOL_BUCKETS fail-at-construction check in mcp/compose (INT-3).
 */
export function assertOutputSchemaCoverage(toolNames: Iterable<string>): void {
  for (const name of toolNames) {
    if (!(name in TOOL_OUTPUT_SCHEMAS)) {
      throw new Error(`no outputSchema for tool "${name}" (REND-11, T-310)`);
    }
  }
}

/**
 * Serialize a successful pipeline result for tools/call. The payload object is built ONCE:
 * the text block stringifies it and `structuredContent` carries the SAME object — one
 * source of truth, so the two representations cannot diverge (REND-11). Optional fields
 * follow the envelope contract: `summary` is omitted when absent, never null.
 *
 * Errors do NOT come through here — `renderError` in mcp/server keeps them text-only with
 * `isError: true`, which the MCP spec exempts from outputSchema conformance.
 */
export function renderStructuredResult(result: ToolResult): CallToolResult {
  const payload: Record<string, unknown> = {
    data: result.data,
    ...(result.summary !== undefined ? { summary: result.summary } : {}),
    meta: result.meta,
  };
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}
