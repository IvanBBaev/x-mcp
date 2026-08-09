// Typed X API v2 direct-message endpoint wrappers (docs/03 dm package: `x_dm_events_list`,
// `x_dm_conversation_events_list`, `x_dm_participant_events_list`, `x_dm_send`). Owned by
// the T-305 dm slice.
//
// v2 has NO list-conversations endpoint, so this module exposes exactly the three DM-EVENT
// lookups — all events / by conversation / with participant — plus the two send routes
// behind `x_dm_send` (corner case DM-1). Each wrapper maps typed args to a single
// `XApiRequest` and returns the raw response envelope for the tool layer to compact.
// Nothing here owns transport, auth, retries, or error mapping — that is the injected
// `EndpointInvoker` (api/http, T-114). Optional query keys are OMITTED when their value is
// undefined (exactOptionalPropertyTypes-safe).
//
// Wire note: like timelines, DM events paginate with the `pagination_token` REQUEST
// parameter while the RESPONSE cursor is `meta.next_token` — the PAGE-1 opaque round-trip
// bridges the two names.

import type { RawDmEvent, RawListResponse, RawSingleResponse } from '../../core/render.js';
import type { EndpointInvoker, OAuthScope, XApiRequest } from '../../core/tooldef.js';

// The DM-event projection shared by all three lookups. `text` and `attachments` are always
// requested on the wire; the DM-3 minimization (bodies only on `include_text: true`) is a
// RENDER decision owned by the tool layer, so one projection serves both modes.
const DM_EVENT_FIELDS = 'id,text,event_type,created_at,dm_conversation_id,sender_id,attachments';
const EXPANSIONS = 'sender_id,attachments.media_keys';
const USER_FIELDS = 'username,name,verified';
const MEDIA_FIELDS = 'type,url,preview_image_url,alt_text';

// Scope sets (docs/01 §2.1): X requires `tweet.read` + `users.read` alongside the DM-family
// scope on every DM route.
const DM_READ_SCOPES: readonly OAuthScope[] = ['dm.read', 'tweet.read', 'users.read'];
const DM_WRITE_SCOPES: readonly OAuthScope[] = ['dm.write', 'tweet.read', 'users.read'];

/** Query-string value type accepted by {@link XApiRequest.query}. */
type QueryValue = string | number | boolean | undefined;

/** Pagination parameters shared by the three DM-event lookups. */
export interface DmEventsParams {
  readonly maxResults?: number;
  /** v2 `pagination_token` request cursor (a previous response's `next_token`, PAGE-1). */
  readonly paginationToken?: string;
}

/** Build the query shared by the three lookups; optional keys omitted when undefined. */
function dmEventsQuery(params: DmEventsParams): Record<string, QueryValue> {
  return {
    'dm_event.fields': DM_EVENT_FIELDS,
    expansions: EXPANSIONS,
    'user.fields': USER_FIELDS,
    'media.fields': MEDIA_FIELDS,
    ...(params.maxResults !== undefined ? { max_results: params.maxResults } : {}),
    ...(params.paginationToken !== undefined ? { pagination_token: params.paginationToken } : {}),
  };
}

/**
 * `GET /2/dm_events` — all recent DM events for the authenticated user, newest first
 * (docs/03 `x_dm_events_list`). X retains at most ~30 days of events (DM-2). User-context
 * only; under app-only auth the http layer maps the API's 401 to a typed `auth` error.
 */
export async function dmEventsList(
  http: EndpointInvoker,
  params: DmEventsParams = {},
): Promise<RawListResponse<RawDmEvent>> {
  return http.send<RawListResponse<RawDmEvent>>({
    method: 'GET',
    path: '/2/dm_events',
    query: dmEventsQuery(params),
    scopes: DM_READ_SCOPES,
  });
}

/** Parameters for {@link dmConversationEvents}: the shared set plus the conversation id. */
export interface DmConversationEventsParams extends DmEventsParams {
  /** Canonical v2 DM conversation id (numeric, or two numeric ids joined by `-`). */
  readonly conversationId: string;
}

/**
 * `GET /2/dm_conversations/:dm_conversation_id/dm_events` — events in one conversation
 * (docs/03 `x_dm_conversation_events_list`).
 */
export async function dmConversationEvents(
  http: EndpointInvoker,
  params: DmConversationEventsParams,
): Promise<RawListResponse<RawDmEvent>> {
  return http.send<RawListResponse<RawDmEvent>>({
    method: 'GET',
    path: `/2/dm_conversations/${encodeURIComponent(params.conversationId)}/dm_events`,
    query: dmEventsQuery(params),
    scopes: DM_READ_SCOPES,
  });
}

/** Parameters for {@link dmParticipantEvents}: the shared set plus the participant id. */
export interface DmParticipantEventsParams extends DmEventsParams {
  /** Resolved numeric id of the OTHER participant (never a handle). */
  readonly participantId: string;
}

/**
 * `GET /2/dm_conversations/with/:participant_id/dm_events` — events in the 1:1 conversation
 * with a participant (docs/03 `x_dm_participant_events_list`).
 */
export async function dmParticipantEvents(
  http: EndpointInvoker,
  params: DmParticipantEventsParams,
): Promise<RawListResponse<RawDmEvent>> {
  return http.send<RawListResponse<RawDmEvent>>({
    method: 'GET',
    path: `/2/dm_conversations/with/${encodeURIComponent(params.participantId)}/dm_events`,
    query: dmEventsQuery(params),
    scopes: DM_READ_SCOPES,
  });
}

// The v2 send confirmation. All fields optional — tolerate envelope drift (DRIFT-1) at the
// type level.
export interface RawDmSendResult {
  readonly dm_conversation_id?: string;
  readonly dm_event_id?: string;
}

/**
 * `POST /2/dm_conversations/:dm_conversation_id/messages` — send a text DM into an existing
 * conversation (docs/03 `x_dm_send`, conversation target). A refusal — recipient does not
 * follow the sender, has DMs closed, or blocked them — comes back as a 403 the error layer
 * maps to `forbidden` with the platform reason (DM-4).
 */
export async function sendDmToConversation(
  http: EndpointInvoker,
  params: { readonly conversationId: string; readonly text: string },
): Promise<RawSingleResponse<RawDmSendResult>> {
  const req: XApiRequest = {
    method: 'POST',
    path: `/2/dm_conversations/${encodeURIComponent(params.conversationId)}/messages`,
    body: { text: params.text },
    scopes: DM_WRITE_SCOPES,
  };
  return http.send<RawSingleResponse<RawDmSendResult>>(req);
}

/**
 * `POST /2/dm_conversations/with/:participant_id/messages` — send a text DM directly to a
 * user id, creating the 1:1 conversation when none exists (docs/03 `x_dm_send`, participant
 * target). Same DM-4 forbidden semantics as the conversation route.
 */
export async function sendDmToParticipant(
  http: EndpointInvoker,
  params: { readonly participantId: string; readonly text: string },
): Promise<RawSingleResponse<RawDmSendResult>> {
  const req: XApiRequest = {
    method: 'POST',
    path: `/2/dm_conversations/with/${encodeURIComponent(params.participantId)}/messages`,
    body: { text: params.text },
    scopes: DM_WRITE_SCOPES,
  };
  return http.send<RawSingleResponse<RawDmSendResult>>(req);
}
