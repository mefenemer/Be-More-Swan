// tests/login-events.test.ts
// login_events records every sign-in, and recording one can never block it.
// See db/z-login-events.sql and src/utils/login-events.ts.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordLogin } from '../src/utils/login-events';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

async function main() {
    // 1. Writes the row with the TRUNCATED ip (privacy policy) + user agent from the request headers.
    let inserted: any = null;
    const okDb = { insert: () => ({ values: async (v: any) => { inserted = v; } }) };
    await recordLogin(okDb, {
        userId: 7, organisationId: 3, method: 'magic_link',
        headers: { 'x-nf-client-connection-ip': '203.0.113.9', 'user-agent': 'Mozilla/5.0' },
    });
    assert.deepStrictEqual(inserted, { userId: 7, organisationId: 3, method: 'magic_link', ip: '203.0.113.x', userAgent: 'Mozilla/5.0' });

    // 1b. IPv6 keeps only the first 64 bits.
    await recordLogin(okDb, { userId: 7, method: 'magic_link', headers: { 'x-nf-client-connection-ip': '2001:db8:85a3:8d3:1319:8a2e:370:7348' } });
    assert.strictEqual(inserted.ip, '2001:db8:85a3:8d3:x:x:x:x');

    // 2. No headers → nulls, not the 'unknown' placeholder.
    await recordLogin(okDb, { userId: 7, method: 'invite' });
    assert.strictEqual(inserted.ip, null);
    assert.strictEqual(inserted.userAgent, null);
    assert.strictEqual(inserted.organisationId, null);

    // 3. Table missing (SQL not applied yet) → swallowed, never thrown.
    const brokenDb = { insert: () => ({ values: async () => { throw new Error('relation "login_events" does not exist'); } }) };
    const warn = console.warn; console.warn = () => {};
    try {
        await recordLogin(brokenDb, { userId: 7, method: 'review_login' });
    } finally { console.warn = warn; }

    // 4. Every path that issues a fresh session records it, with its own method.
    const wiring: Array<[string, string]> = [
        ['netlify/functions/verify.ts', "method: 'magic_link'"],
        ['netlify/functions/review-login.ts', "method: 'review_login'"],
        ['netlify/functions/accept-invite.ts', "method: 'invite'"],
    ];
    for (const [file, marker] of wiring) {
        const src = read(file);
        assert.ok(src.includes('await recordLogin(db,') && src.includes(marker), `${file} must call recordLogin with ${marker}`);
    }

    // 5. The SQL's allowed methods match the type.
    const sql = read('db/z-login-events.sql');
    assert.ok(sql.includes("CHECK (method IN ('magic_link', 'review_login', 'invite'))"));

    console.log('login-events: all checks passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
