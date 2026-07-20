// tests/social-oauth-request.test.ts
// Locks the shape of the LinkedIn / X authorization requests that social-oauth-init.ts builds.
// These are the details the providers reject on, and each has burned us:
//   · scopes must be SPACE-delimited (RFC 6749 §3.3) — a comma-joined list was refused outright
//   · LinkedIn scopes must stay within the app's approved products (OpenID Connect + Share on
//     LinkedIn); the old r_organization_social set needs Community Management, which we lack
//   · the redirect_uri must carry no query string — `platform` rides in the signed state instead
// Static assertions against the source, so there is no network or DB in play.
// Run:  npx tsx tests/social-oauth-request.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const init = readFileSync(join(__dirname, '../netlify/functions/social-oauth-init.ts'), 'utf8');
const callback = readFileSync(join(__dirname, '../netlify/functions/social-oauth-callback.ts'), 'utf8');

let passed = 0;
function check(name: string, fn: () => void) { fn(); console.log(`  ✓ ${name}`); passed++; }

/** Pull the `const scopes = '…'` literals out of the source in order (LinkedIn first, then X). */
function scopeLiterals(src: string): string[] {
    return [...src.matchAll(/const scopes = '([^']*)'/g)].map(m => m[1]);
}

// ── scope delimiting ────────────────────────────────────────────────────────
check('every scope list is space-delimited, never comma-delimited', () => {
    for (const s of [...scopeLiterals(init), ...scopeLiterals(callback)]) {
        assert.ok(!s.includes(','), `scope list is comma-delimited: "${s}"`);
    }
});

// ── LinkedIn scopes match the approved products ─────────────────────────────
check('LinkedIn requests exactly the OpenID Connect + Share on LinkedIn scopes', () => {
    const [linkedin] = scopeLiterals(init);
    assert.deepEqual(new Set(linkedin.split(' ')), new Set(['openid', 'profile', 'email', 'w_member_social']));
});

/** Drop `//` comments — the gated scope names are named in prose there, deliberately. */
function code(src: string): string {
    return src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
}

check('LinkedIn does not request any Community-Management-gated scope', () => {
    for (const src of [code(init), code(callback)]) {
        for (const gated of ['r_organization_social', 'w_organization_social', 'r_basicprofile', 'r_liteprofile']) {
            assert.ok(!src.includes(gated), `still references the unapproved scope ${gated}`);
        }
    }
});

check('the init and callback LinkedIn scope strings agree', () => {
    assert.equal(scopeLiterals(init)[0], scopeLiterals(callback)[0]);
});

// ── redirect_uri shape ──────────────────────────────────────────────────────
check('the authorize redirect_uri carries no query string', () => {
    const m = /const callbackUri = `([^`]*)`/.exec(init);
    assert.ok(m, 'could not find callbackUri in social-oauth-init.ts');
    assert.ok(!m![1].includes('?'), `redirect_uri still has a query string: ${m![1]}`);
});

check('platform is carried in the signed state instead', () => {
    assert.ok(/buildState\(\{\s*platform/.test(init), 'state no longer carries platform');
    assert.ok(/parseState\(rawState[^)]*\)\?\.platform/.test(callback), 'callback does not read platform from state');
});

// ── member identification ───────────────────────────────────────────────────
check('LinkedIn identity comes from /v2/userinfo, not the legacy /v2/me', () => {
    assert.ok(callback.includes('api.linkedin.com/v2/userinfo'), 'not using /v2/userinfo');
    assert.ok(!callback.includes('api.linkedin.com/v2/me'), 'still calling the legacy /v2/me');
});

console.log(`\n${passed} checks passed.`);
