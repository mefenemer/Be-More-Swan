// tests/oauth-callback-session.test.ts
// Security scan M1 + M2 (28 Nov 2026, Zoom Marketplace prep).
//
// M1: the OAuth callback must only finish a connect for the signed-in user who started it. Otherwise someone could
// start a connect, send the provider's consent link to another person, and that person's account (their Zoom, their
// mailbox) would be saved into the sender's workspace. Drives the real handler in-process: both refusals happen
// before any database read, so no database is needed.
// M2: security headers in netlify.toml (HSTS + nosniff everywhere, framing limited to our own pages on the app pages,
// never on embeddable pages).
// Run:  npx tsx tests/oauth-callback-session.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

(async () => {
    // session.ts reads JWT_SECRET at module load: set a throwaway one before importing anything that uses it.
    process.env.JWT_SECRET = 'test-only-secret-oauth-callback-session';
    // getDb() needs a URL to build its client, but both refusals return before any query: point it nowhere, so a
    // regression that reaches the database fails loudly instead of touching a real one.
    process.env.NETLIFY_DATABASE_URL = 'postgres://nobody:nothing@127.0.0.1:9/none';
    const jwt = (await import('jsonwebtoken')).default;
    const handler = (await import('../netlify/functions/oauth-integrations')).default as unknown as (req: Request, ctx: object) => Promise<Response>;

    let passed = 0;
    async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
        try { await fn(); passed++; console.log(`  ✓ ${name}`); }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
    }

    const state = Buffer.from(JSON.stringify({ provider: 'zoom', userId: '101', csrf: 'a'.repeat(64) })).toString('base64url');
    const callbackUrl = `https://staging--bemoreswan.netlify.app/api/oauth/zoom/callback?code=abc&state=${state}`;
    const cookieFor = (userId: number) => `aura_session=${jwt.sign({ userId, activeOrganisationId: 58 }, process.env.JWT_SECRET!)}`;
    const call = async (cookie?: string) => {
        const res = await handler(new Request(callbackUrl, {
            headers: { 'x-forwarded-host': 'staging--bemoreswan.netlify.app', 'x-forwarded-proto': 'https', ...(cookie ? { cookie } : {}) },
            redirect: 'manual',
        }), {});
        return { status: res.status, location: res.headers.get('location') ?? '' };
    };

    console.log('M1: the callback finishes a connect only for the user who started it');
    await check('no session → refused with invalid_session, before any token exchange', async () => {
        const r = await call();
        assert.strictEqual(r.status, 302);
        assert.match(r.location, /oauth_error=invalid_session&provider=zoom/);
    });
    await check("another user's session → refused with csrf_fail", async () => {
        const r = await call(cookieFor(202));
        assert.strictEqual(r.status, 302);
        assert.match(r.location, /oauth_error=csrf_fail&provider=zoom/);
    });
    await check('the check sits before the CSRF entry is read or consumed, and membership is checked after', () => {
        const src = readFileSync(join(root, 'netlify/functions/oauth-integrations.ts'), 'utf8');
        const session = src.indexOf('const session = requireSession(event);');
        const consume = src.indexOf('const stored = await getSecret(db, csrfKey)');
        const member = src.indexOf('await requireOrgMembership(db, userId, organisationId)');
        assert.ok(session > 0 && consume > 0 && member > 0, 'markers present');
        assert.ok(session < consume, 'session check before the CSRF entry is consumed');
        assert.ok(member > consume, 'membership check once the workspace is known');
    });

    console.log('M2: security headers');
    const toml = readFileSync(join(root, 'netlify.toml'), 'utf8');
    const block = (path: string) => {
        const i = toml.indexOf(`  for = "${path}"\n`);
        return i < 0 ? '' : toml.slice(i, toml.indexOf('[[headers]]', i + 1) < 0 ? undefined : toml.indexOf('[[headers]]', i + 1));
    };
    await check('every response gets HSTS (one year) and nosniff', () => {
        const all = block('/*');
        assert.match(all, /Strict-Transport-Security = "max-age=31536000"/);
        assert.match(all, /X-Content-Type-Options = "nosniff"/);
        assert.doesNotMatch(all, /X-Frame-Options|frame-ancestors/, 'framing must not be banned site-wide (embeds)');
    });
    for (const path of ['/workspace*', '/admin*', '/login*', '/integrations*', '/billing*']) {
        await check(`${path} may only be framed by our own pages`, () => {
            const b = block(path);
            assert.match(b, /X-Frame-Options = "SAMEORIGIN"/);
            assert.match(b, /Content-Security-Policy = "frame-ancestors 'self'"/);
        });
    }
    await check('no frame ban on embeddable or public pages', () => {
        for (const path of ['/s/*', '/f/*', '/b/*', '/api/widget/*', '/', '/*.html']) {
            assert.doesNotMatch(block(path), /X-Frame-Options|frame-ancestors/, path);
        }
    });

    console.log(`\n${passed} passed`);
})().catch((err) => { console.error(err); process.exit(1); });
