// Property-based tests (docs/05 §1) for the two credential-safety chokepoints:
// scrubSecrets (api/oauth2/keychain) and isCredentialEgressHost (core/egress).
//
// scrubSecrets: for ANY surrounding text and ANY token-shaped secret, the secret must not
// survive — whether or not the caller listed it. A token-shaped secret is >= 40 chars of
// the token alphabet, which is exactly the module's defensive run threshold
// (SECRET_RUN_MIN = 40, a private const), so an unnamed secret still falls to the generic
// run redaction. The output must also stay bounded and one-line, since it is embedded in
// error details.
//
// isCredentialEgressHost: credentials travel ONLY to https://x.com and its true
// subdomains. The properties sweep generated hostnames across the three classic bypasses:
// scheme downgrade, suffix look-alikes (x.com.evil.example), and dot-less merges
// (evilx.com). Generated labels always start with a letter — a purely numeric final label
// would make WHATWG's URL parser treat the host as an IPv4 address and throw.

import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { MAX_DETAIL_CHARS, scrubSecrets } from '../src/api/oauth2/keychain.js';
import { isCredentialEgressHost } from '../src/core/egress.js';
import { dirtyText } from './helpers/index.js';

// --- scrubSecrets ------------------------------------------------------------------

const TOKEN_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=_.-';
const secretArb = fc
  .array(fc.constantFrom(...TOKEN_CHARS.split('')), { minLength: 40, maxLength: 80 })
  .map((chars) => chars.join(''));
// Independent restatement of the module's defensive redaction: no >= 40-char token run
// may survive scrubbing (40 mirrors the private SECRET_RUN_MIN).
const TOKEN_RUN_RE = /[A-Za-z0-9+/=_.-]{40,}/;

test('KEY-redaction property: a token-shaped secret never survives, named or unnamed; output bounded and one-line', () => {
  fc.assert(
    fc.property(
      dirtyText(30),
      secretArb,
      dirtyText(30),
      fc.boolean(),
      (before, secret, after, named) => {
        const out = scrubSecrets(before + secret + after, named ? [secret] : []);
        assert.equal(out.includes(secret), false, 'the secret leaked through scrubbing');
        assert.equal(TOKEN_RUN_RE.test(out), false, 'a long token-shaped run survived');
        assert.ok(out.length <= MAX_DETAIL_CHARS + 1, 'output exceeds the detail cap'); // +1: the ellipsis
        // One line, single spaces: no whitespace other than a plain space anywhere.
        assert.equal(/[^\S ]/.test(out), false, 'non-space whitespace survived collapsing');
        assert.equal(out.includes('  '), false, 'double space survived collapsing');
        assert.equal(out.startsWith(' '), false, 'leading whitespace survived trimming');
      },
    ),
  );
});

// --- isCredentialEgressHost --------------------------------------------------------

const LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('');
const ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789'.split('');
// A DNS-ish label that always starts with a letter (see the header note on IPv4 parsing).
const labelArb = fc
  .tuple(fc.constantFrom(...LETTERS), fc.string({ unit: fc.constantFrom(...ALNUM), maxLength: 6 }))
  .map(([head, tail]) => head + tail);

test('T10 §4.4 property: any true x.com subdomain is accepted over https and rejected over http', () => {
  fc.assert(
    fc.property(fc.array(labelArb, { maxLength: 3 }), (labels) => {
      const host = [...labels, 'x', 'com'].join('.');
      assert.equal(isCredentialEgressHost(new URL(`https://${host}/2/tweets`)), true);
      // The same host over plaintext must never carry a credential (scheme downgrade).
      assert.equal(isCredentialEgressHost(new URL(`http://${host}/2/tweets`)), false);
    }),
  );
});

test('T10 §4.4 property: look-alike hosts are rejected — x.com.<anything> suffixes and dot-less merges', () => {
  fc.assert(
    fc.property(labelArb, fc.array(labelArb, { maxLength: 2 }), (label, middle) => {
      // x.com.evil.example — the credential domain as a PREFIX of a foreign host.
      const suffixed = ['x', 'com', ...middle, `${label}example`].join('.');
      assert.equal(isCredentialEgressHost(new URL(`https://${suffixed}/`)), false);
      // evilx.com — the credential domain as a suffix WITHOUT a dot boundary.
      const merged = `${label}x.com`;
      assert.equal(isCredentialEgressHost(new URL(`https://${merged}/`)), false);
    }),
  );
});
