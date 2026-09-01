// Property-based tests (docs/05 §1) for core/render — compactors on degraded shapes.
//
// The invariant under test is TOTALITY + HYGIENE: for ANY combination of missing fields,
// dangling expansions, adversarial text, and junk numerics, a compactor (a) never throws
// (REND-5), (b) never lets a forbidden code point or an over-cap field into a shape
// (REND-6), (c) keeps its structural promises — permalink always present (REND-4),
// timestamps ISO-8601 UTC (REND-9), missing[] reasons from the fixed vocabulary (REND-7)
// — and (d) never emits an own property holding `undefined` (the shapes are consumed
// under exactOptionalPropertyTypes and serialized to JSON).
//
// Ids and author ids come from a CLEAN pool on purpose: ids/urls are structural fields the
// compactors copy verbatim by design, so the hygiene oracle applies only to the
// text-bearing fields REND-6 promises to sanitize.

import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import {
  RAW_MAX_RESULTS,
  capRawMaxResults,
  postUrl,
  renderDm,
  renderList,
  renderMissing,
  renderPost,
  renderUser,
} from '../src/core/render.js';
import { FIELD_CAPS } from '../src/core/sanitize.js';
import { FORBIDDEN_OUTPUT_RE, dirtyText, idPool, mediaKeyPool } from './helpers/index.js';

// --- Arbitraries for raw API shapes (every field optional, DRIFT-1) ----------------

const junkNumber = fc.oneof(
  fc.integer({ min: -5, max: 1_000_000 }),
  fc.double(),
  fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
);

const timestamp = fc.oneof(
  fc.constantFrom('2026-01-02T03:04:05.000Z', '2026-01-02', '1719834000000', 'not a date', ''),
  fc.string({ maxLength: 24 }),
);

const rawUserArb = fc.record(
  {
    id: idPool,
    username: fc.oneof(dirtyText(8), fc.constantFrom('alice', 'bob_1', '@nested', '')),
    name: dirtyText(10),
    description: dirtyText(10),
    verified: fc.boolean(),
    protected: fc.boolean(),
    created_at: timestamp,
    location: dirtyText(6),
    url: dirtyText(6),
    public_metrics: fc.record(
      {
        followers_count: junkNumber,
        following_count: junkNumber,
        tweet_count: junkNumber,
        listed_count: junkNumber,
      },
      { requiredKeys: [] },
    ),
  },
  { requiredKeys: [] },
);

const rawMediaArb = fc.record(
  {
    media_key: mediaKeyPool,
    type: fc.constantFrom('photo', 'video', 'animated_gif', 'weird', ''),
    url: dirtyText(6),
    preview_image_url: dirtyText(6),
    alt_text: dirtyText(10),
  },
  { requiredKeys: [] },
);

const includedTweetArb = fc.record(
  {
    id: idPool,
    text: dirtyText(10),
    author_id: idPool,
    note_tweet: fc.record({ text: dirtyText(10) }, { requiredKeys: [] }),
  },
  { requiredKeys: [] },
);

const includesArb = fc.option(
  fc.record(
    {
      users: fc.array(rawUserArb, { maxLength: 3 }),
      tweets: fc.array(includedTweetArb, { maxLength: 3 }),
      media: fc.array(rawMediaArb, { maxLength: 3 }),
    },
    { requiredKeys: [] },
  ),
  { nil: undefined },
);

const rawTweetArb = fc.record(
  {
    id: idPool,
    text: dirtyText(12),
    created_at: timestamp,
    author_id: idPool,
    public_metrics: fc.record(
      {
        retweet_count: junkNumber,
        reply_count: junkNumber,
        like_count: junkNumber,
        quote_count: junkNumber,
        bookmark_count: junkNumber,
        impression_count: junkNumber,
      },
      { requiredKeys: [] },
    ),
    referenced_tweets: fc.array(
      fc.record(
        { type: fc.constantFrom('replied_to', 'quoted', 'retweeted', 'weird'), id: idPool },
        { requiredKeys: [] },
      ),
      { maxLength: 3 },
    ),
    attachments: fc.record(
      { media_keys: fc.array(mediaKeyPool, { maxLength: 3 }) },
      { requiredKeys: [] },
    ),
    note_tweet: fc.record({ text: dirtyText(12) }, { requiredKeys: [] }),
  },
  { requiredKeys: [] },
);

const rawDmArb = fc.record(
  {
    id: idPool,
    text: dirtyText(12),
    sender_id: idPool,
    created_at: timestamp,
    dm_conversation_id: idPool,
    attachments: fc.record(
      { media_keys: fc.array(mediaKeyPool, { maxLength: 3 }) },
      { requiredKeys: [] },
    ),
  },
  { requiredKeys: [] },
);

const rawListArb = fc.record(
  {
    id: idPool,
    name: dirtyText(8),
    description: dirtyText(10),
    private: fc.boolean(),
    member_count: junkNumber,
    follower_count: junkNumber,
    owner_id: idPool,
  },
  { requiredKeys: [] },
);

// --- Shared assertions -------------------------------------------------------------

/** REND-6: a promised text field is free of forbidden code points and within its cap. */
function assertHygienic(value: string | undefined, cap: number, label: string): void {
  if (value === undefined) return;
  assert.equal(FORBIDDEN_OUTPUT_RE.test(value), false, `${label} carries a forbidden code point`);
  assert.ok(Array.from(value).length <= cap, `${label} exceeds its cap of ${cap}`);
}

/** REND-9: a surfaced timestamp is ISO-8601 UTC — a fixed point of Date round-tripping. */
function assertIsoUtc(value: string | undefined, label: string): void {
  if (value === undefined) return;
  assert.equal(value, new Date(value).toISOString(), `${label} is not normalized ISO UTC`);
}

/** exactOptionalPropertyTypes discipline: emitted shapes omit fields, never carry undefined. */
function assertNoUndefinedProps(shape: object, label: string): void {
  for (const [key, value] of Object.entries(shape)) {
    assert.notEqual(value, undefined, `${label}.${key} is an own property holding undefined`);
  }
}

const MEDIA_TYPES = new Set(['photo', 'video', 'animated_gif']);

// --- Properties --------------------------------------------------------------------

test('REND-4/5/6/9 property: renderPost is total and hygienic on any degraded tweet + includes', () => {
  fc.assert(
    fc.property(rawTweetArb, includesArb, (raw, includes) => {
      const post = renderPost(raw, includes); // must never throw
      assert.equal(post.id, raw.id ?? '');
      assert.equal(post.url, postUrl(post.id)); // REND-4: permalink always present
      assertHygienic(post.text, FIELD_CAPS.postText, 'post.text');
      assertHygienic(post.author, FIELD_CAPS.handle + 1, 'post.author'); // '@' + capped handle
      assertHygienic(post.note_tweet, FIELD_CAPS.noteText, 'post.note_tweet');
      assertIsoUtc(post.created_at, 'post.created_at');
      for (const m of post.media ?? []) {
        assert.ok(MEDIA_TYPES.has(m.type), `unknown media type ${m.type} surfaced`);
        assertHygienic(m.alt_text, FIELD_CAPS.altText, 'media.alt_text');
      }
      for (const ref of [post.reply_to, post.quoted]) {
        if (ref !== undefined) assertHygienic(ref.author, FIELD_CAPS.handle + 1, 'ref.author');
      }
      for (const [key, value] of Object.entries(post.metrics ?? {})) {
        assert.ok(Number.isFinite(value), `metric ${key} is not a finite number`);
      }
      assertNoUndefinedProps(post, 'post');
    }),
  );
});

test('REND-5/6/9 property: renderUser is total and hygienic on any degraded user', () => {
  fc.assert(
    fc.property(rawUserArb, (raw) => {
      const user = renderUser(raw);
      assert.equal(user.id, raw.id ?? '');
      // The handle is either absent-as-empty or an '@'-prefixed sanitized body.
      assert.ok(user.handle === '' || user.handle.startsWith('@'));
      assertHygienic(user.handle, FIELD_CAPS.handle + 1, 'user.handle');
      assertHygienic(user.name, FIELD_CAPS.name, 'user.name');
      assertHygienic(user.description, FIELD_CAPS.bio, 'user.description');
      assertHygienic(user.location, FIELD_CAPS.location, 'user.location');
      assertHygienic(user.url, FIELD_CAPS.url, 'user.url');
      assertIsoUtc(user.created_at, 'user.created_at');
      for (const [key, value] of Object.entries(user.metrics ?? {})) {
        assert.ok(Number.isFinite(value), `metric ${key} is not a finite number`);
      }
      assertNoUndefinedProps(user, 'user');
    }),
  );
});

test('REND-5/6/9 property: renderDm and renderList are total and hygienic', () => {
  fc.assert(
    fc.property(rawDmArb, rawListArb, includesArb, (dmRaw, listRaw, includes) => {
      const dm = renderDm(dmRaw, includes);
      assert.equal(dm.id, dmRaw.id ?? '');
      assertHygienic(dm.text, FIELD_CAPS.dmText, 'dm.text');
      assertHygienic(dm.sender, FIELD_CAPS.handle + 1, 'dm.sender');
      assertIsoUtc(dm.created_at, 'dm.created_at');
      for (const m of dm.media ?? []) {
        assertHygienic(m.alt_text, FIELD_CAPS.altText, 'dm media.alt_text');
      }
      assertNoUndefinedProps(dm, 'dm');

      const list = renderList(listRaw, includes);
      assert.equal(list.id, listRaw.id ?? '');
      assertHygienic(list.name, FIELD_CAPS.name, 'list.name');
      assertHygienic(list.description, FIELD_CAPS.bio, 'list.description');
      assertHygienic(list.owner, FIELD_CAPS.handle + 1, 'list.owner');
      if (list.member_count !== undefined) assert.ok(Number.isFinite(list.member_count));
      if (list.follower_count !== undefined) assert.ok(Number.isFinite(list.follower_count));
      assertNoUndefinedProps(list, 'list');
    }),
  );
});

test('REND-7 property: missing[] reasons always come from the fixed vocabulary, ids sanitized and capped', () => {
  const REASONS = new Set(['not-found', 'suspended', 'deleted', 'protected', 'unavailable']);
  const rawErrorArb = fc.record(
    {
      title: dirtyText(8),
      type: dirtyText(8),
      detail: dirtyText(8),
      resource_id: fc.oneof(idPool, dirtyText(6)),
      resource_type: dirtyText(4),
      value: dirtyText(6),
      parameter: dirtyText(4),
    },
    { requiredKeys: [] },
  );
  fc.assert(
    fc.property(
      fc.option(fc.array(rawErrorArb, { maxLength: 5 }), { nil: undefined }),
      (errors) => {
        const missing = renderMissing(errors);
        assert.equal(missing.length, errors?.length ?? 0); // every partial failure surfaces
        for (const m of missing) {
          assert.ok(REASONS.has(m.reason), `reason ${m.reason} outside the vocabulary`);
          assertHygienic(m.id, FIELD_CAPS.handle, 'missing.id');
        }
      },
    ),
  );
});

test('REND-10 property: capRawMaxResults maps any number into [1, 25] and is identity in-range', () => {
  fc.assert(
    fc.property(
      fc.oneof(
        fc.double(),
        fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
      ),
      (n) => {
        const out = capRawMaxResults(n);
        assert.ok(Number.isInteger(out));
        assert.ok(out >= 1 && out <= RAW_MAX_RESULTS, `${out} escapes the raw cap window`);
      },
    ),
  );
  fc.assert(
    fc.property(fc.integer({ min: 1, max: RAW_MAX_RESULTS }), (n) => {
      assert.equal(capRawMaxResults(n), n);
    }),
  );
});
