// tests/connection-status-vocabulary.test.ts
// Every status a WRITER puts in system_connections.status must be one the READERS recognise.
//
// Run:  npx tsx tests/connection-status-vocabulary.test.ts
//
// The column has no CHECK constraint, so its vocabulary grew per writer while each reader carried
// its own guessed list. The lists diverged: readers looked for 'expired' and 'failed' — which
// nothing writes to this table — and missed 'token_expired', which the three Meta paths do write.
// A dead Facebook connection therefore raised no alert, no email, no readiness diagnostic, and the
// UI badge said "Connected", while the drafting lookups (which require status='active') had
// already dropped the platform. Nothing in the product said a word.
//
// This test exists because that failure is invisible by construction: an unrecognised status is
// not an error anywhere, it just silently matches no branch.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { DEAD_CONNECTION_STATUSES, isConnectionDead } from '../src/config/connection-status';

let passed = 0;
const test = (name: string, fn: () => void) => {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}\n    ${err instanceof Error ? err.message : err}`); process.exitCode = 1; }
};

const src = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

console.log('\nConnection status vocabulary — writers and readers agree\n');

// ── Writers ──────────────────────────────────────────────────────────────────

test('every status written to system_connections is recognised as dead or active', () => {
    // The writers, and the value each one sets. Keyed by file so a moved/renamed writer fails here
    // rather than drifting out of the test.
    const WRITERS: Record<string, string> = {
        'netlify/functions/publish-instagram.ts': 'token_expired',
        'netlify/functions/ingest-facebook-insights.ts': 'token_expired',
        'netlify/functions/ingest-instagram-insights.ts': 'token_expired',
        'netlify/functions/refresh-social-tokens.ts': 'token_refresh_failed',
        'netlify/functions/refresh-meta-tokens.ts': 'token_refresh_failed',
        'netlify/functions/revoke-connections.ts': 'revoked',
    };
    for (const [file, status] of Object.entries(WRITERS)) {
        assert.ok(
            src(file).includes(`status: '${status}'`),
            `${file} no longer writes status '${status}' — update this list, and check the readers`,
        );
        assert.ok(isConnectionDead(status), `'${status}' is written but not recognised as a dead status`);
    }
});

test("'token_expired' is covered — the omission that hid every dead Meta connection", () => {
    assert.ok(DEAD_CONNECTION_STATUSES.includes('token_expired'));
    assert.equal(isConnectionDead('active'), false, 'a healthy connection must never read as dead');
    assert.equal(isConnectionDead(null), false);
    assert.equal(isConnectionDead(''), false);
});

// ── Readers ──────────────────────────────────────────────────────────────────

test('no reader hand-writes the dead-status list any more', () => {
    const READERS = [
        'netlify/functions/integration-health-check.ts',
        'netlify/functions/get-assistant-readiness.ts',
        'netlify/functions/churn-detection.ts',
    ];
    for (const f of READERS) {
        const s = src(f);
        assert.ok(
            /DEAD_CONNECTION_STATUSES|isConnectionDead/.test(s),
            `${f} must read the shared vocabulary (src/config/connection-status.ts)`,
        );
        // The shape of the old bug: an inline list of status literals. It always looked complete.
        assert.ok(
            !/status,\s*\['expired'/.test(s) && !/eq\(systemConnections\.status,\s*'expired'\)/.test(s),
            `${f} hand-lists connection statuses again`,
        );
    }
});

test('the connection badge reads the generated list, not a copy', () => {
    const js = src('integrations.js');
    assert.ok(
        /PlatformConstants\.isConnectionDead/.test(js),
        '_connHealth must ask the generated constants — the hand copy is what showed "Connected" on a dead account',
    );
    assert.ok(
        !/conn\.status === 'token_refresh_failed'/.test(js),
        'integrations.js is listing statuses inline again',
    );
});

test('the browser receives the same list the server uses', () => {
    const generated = src('src/generated/platform-constants.js');
    for (const status of DEAD_CONNECTION_STATUSES) {
        assert.ok(generated.includes(`"${status}"`), `${status} missing from the generated constants`);
    }
});

console.log(`\n${passed} checks passed\n`);
