// Endpoint wrappers for the media tools (T-303; docs/03 media §). Chunked upload rides
// the DEDICATED v2 paths only (MEDIA-1, FINDING-6): `POST /2/media/upload/initialize`,
// `POST /2/media/upload/{id}/append`, `POST /2/media/upload/{id}/finalize`, plus
// `GET /2/media/upload` (STATUS) and `POST /2/media/metadata` (alt text). The retired
// v1.1 `upload.twitter.com` routes (gone 2025-06-09) must never appear here. Thin, typed
// builders over the injected `EndpointInvoker`; host-scoped auth, no-retry-on-writes
// (RATE-5/NET-4), and error mapping all live in api/http (T-114) — nothing here does I/O.

import type { RawSingleResponse } from '../../core/render.js';
import type { EndpointInvoker, OAuthScope, XApiRequest } from '../../core/tooldef.js';

/**
 * The closed `media_category` enum (MEDIA-1) — the category names the tweet composer
 * accepts on `POST /2/media/upload/initialize`. Single source of truth: the tool schema
 * (src/tools/media) builds its `z.enum` from this tuple.
 */
export const MEDIA_CATEGORIES = ['tweet_image', 'tweet_gif', 'tweet_video'] as const;
export type MediaCategory = (typeof MEDIA_CATEGORIES)[number];

/**
 * Raw bytes per APPEND segment. X caps a segment at 5 MB (MEDIA-1); 4 MiB keeps every
 * raw segment safely under the cap regardless of how the transport encodes it.
 */
export const MEDIA_SEGMENT_BYTES = 4 * 1024 * 1024;

/**
 * Per-type upload size caps, in bytes (MEDIA-2; docs/04 §7 "per-type size caps are
 * enforced locally with the cap stated in the error" — the concrete numbers are carried
 * by the media package). These are the X composer limits: 5 MiB for a still image,
 * 15 MiB for a GIF, 512 MiB for a video. The tool layer refuses an over-cap file LOCALLY,
 * before INIT, so an upload that the platform would reject at FINALIZE never spends a
 * single segment.
 */
export const MEDIA_SIZE_CAPS: Readonly<Record<MediaCategory, number>> = {
  tweet_image: 5 * 1024 * 1024,
  tweet_gif: 15 * 1024 * 1024,
  tweet_video: 512 * 1024 * 1024,
};

/** OAuth scope every media endpoint requires (docs/01 §2.1). */
const MEDIA_SCOPES: readonly OAuthScope[] = ['media.write'];

// The v2 media envelopes. All fields optional — tolerate envelope drift (DRIFT-1) at the
// type level; the tool layer decides what is load-bearing (a missing INIT id is fatal).
export interface RawProcessingError {
  readonly code?: number;
  readonly name?: string;
  readonly message?: string;
}
export interface RawProcessingInfo {
  readonly state?: string;
  readonly check_after_secs?: number;
  readonly progress_percent?: number;
  readonly error?: RawProcessingError;
}
export interface RawMediaUpload {
  readonly id?: string;
  readonly media_key?: string;
  readonly expires_after_secs?: number;
  readonly size?: number;
  readonly processing_info?: RawProcessingInfo;
}

/** `POST /2/media/upload/initialize` — open a chunked upload session (MEDIA-1). */
export async function initializeUpload(
  http: EndpointInvoker,
  params: {
    readonly totalBytes: number;
    readonly mediaType: string;
    readonly mediaCategory: MediaCategory;
  },
): Promise<RawSingleResponse<RawMediaUpload>> {
  const req: XApiRequest = {
    method: 'POST',
    path: '/2/media/upload/initialize',
    body: {
      media_category: params.mediaCategory,
      media_type: params.mediaType,
      total_bytes: params.totalBytes,
    },
    scopes: MEDIA_SCOPES,
  };
  return http.send<RawSingleResponse<RawMediaUpload>>(req);
}

/**
 * `POST /2/media/upload/{id}/append` — upload one raw segment (< 5 MB, MEDIA-1).
 *
 * WIRE-ENCODING SEAM: the frozen transport (api/http, T-114) JSON-stringifies every
 * request body, so this builder targets the JSON request variant of APPEND — the chunk
 * rides as a base64 `media` field alongside `segment_index`. This function is the ONE
 * place that encoding decision lives; if live verification shows the endpoint accepts
 * only multipart/form-data, swapping the encoding means changing this builder (and the
 * transport contract) and nothing else.
 */
export async function appendSegment(
  http: EndpointInvoker,
  params: {
    readonly mediaId: string;
    readonly segmentIndex: number;
    readonly segment: Buffer;
  },
): Promise<void> {
  const req: XApiRequest = {
    method: 'POST',
    path: `/2/media/upload/${encodeURIComponent(params.mediaId)}/append`,
    body: {
      segment_index: params.segmentIndex,
      media: params.segment.toString('base64'),
    },
    scopes: MEDIA_SCOPES,
  };
  await http.send<unknown>(req);
}

/** `POST /2/media/upload/{id}/finalize` — close the session; may return `processing_info`. */
export async function finalizeUpload(
  http: EndpointInvoker,
  params: { readonly mediaId: string },
): Promise<RawSingleResponse<RawMediaUpload>> {
  const req: XApiRequest = {
    method: 'POST',
    path: `/2/media/upload/${encodeURIComponent(params.mediaId)}/finalize`,
    scopes: MEDIA_SCOPES,
  };
  return http.send<RawSingleResponse<RawMediaUpload>>(req);
}

/** `GET /2/media/upload?command=STATUS` — poll async processing for a finalized upload. */
export async function getUploadStatus(
  http: EndpointInvoker,
  params: { readonly mediaId: string },
): Promise<RawSingleResponse<RawMediaUpload>> {
  const req: XApiRequest = {
    method: 'GET',
    path: '/2/media/upload',
    query: { command: 'STATUS', media_id: params.mediaId },
    scopes: MEDIA_SCOPES,
  };
  return http.send<RawSingleResponse<RawMediaUpload>>(req);
}

/** `POST /2/media/metadata` — attach alt text to an uploaded media (accessibility). */
export async function setAltText(
  http: EndpointInvoker,
  params: { readonly mediaId: string; readonly altText: string },
): Promise<void> {
  const req: XApiRequest = {
    method: 'POST',
    path: '/2/media/metadata',
    body: {
      id: params.mediaId,
      metadata: { alt_text: { text: params.altText } },
    },
    scopes: MEDIA_SCOPES,
  };
  await http.send<unknown>(req);
}
