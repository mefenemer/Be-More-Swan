// tests/oauth-callback-session-social.test.ts
// Security scan M1 (28 Nov 2026, Zoom Marketplace prep) — the social and ads callbacks.
//
// Every OAuth callback must only finish a connect for the signed-in user who started it. Otherwise someone
// could start a connect, send the provider's consent link to another person, and that person's Facebook Page,
// Instagram, LinkedIn, X or ad accounts would be saved into the sender's workspace (who could then post or
// spend as them). The connector callback (oauth-integrations.ts) is covered by oauth-callback-session.test.ts;
// this file covers social-oauth-callback, meta-oauth (Facebook/Instagram), meta-ads-oauth-callback and
// linkedin-ads-oauth-callback.
//
// Drives the real handlers in-process: both refusals happen before any database read, so the database URL
// points nowhere and a regression that reaches it fails loudly instead of touching a real one.
// Run:  npx tsx tests/oauth-callback-session-social.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Hard safety exit: a handler left waiting on the fake database must never hang CI (it did, on #942).
setTimeout(() => { console.error('  ✗ timed out after 20s'); process.exit(1); }, 20_000).unref();

(async () => {
    // session.ts and meta-oauth.ts read JWT_SECRET at module load: set a throwaway one before importing them.
    process.env.JWT_SECRET = 'test-only-secret-oauth-callback-session-social';
    process.env.META_APP_ID = 'test-app';
    process.env.META_APP_SECRET = 'test-app-secret';
    // The database is a local socket that counts connection attempts and hangs up at once: the refusals must
    // never reach it, and the right user's session must (proof the new check doesn't lock everyone out).
    const net = await import('node:net');
    let dbConnects = 0;
    const fakeDb = net.createServer((sock) => { dbConnects++; sock.destroy(); });
    await new Promise<void>((ok) => fakeDb.listen(0, '127.0.0.1', ok));
    const dbPort = (fakeDb.address() as import('node:net').AddressInfo).port;
    process.env.NETLIFY_DATABASE_URL = `postgres://nobody:nothing@127.0.0.1:${dbPort}/none`;
    delete process.env.DATABASE_URL;
    const jwt = (await import('jsonwebtoken')).default;
    const { createHmac } = await import('node:crypto');

    type H = (req: Request, ctx: object) => Promise<Response>;
    const load = async (name: string) => (await import(`../netlify/functions/${name}`)).default as unknown as H;

    let passed = 0;
    async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
        try { await fn(); passed++; console.log(`  ✓ ${name}`); }
        catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
    }

    const host = 'staging--bemoreswan.netlify.app';
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const cookieFor = (userId: number) => `aura_session=${jwt.sign({ userId, activeOrganisationId: 58 }, process.env.JWT_SECRET!)}`;
    const call = async (handler: H, path: string, cookie?: string) => {
        const res = await handler(new Request(`https://${host}${path}`, {
            headers: { 'x-forwarded-host': host, 'x-forwarded-proto': 'https', ...(cookie ? { cookie } : {}) },
            redirect: 'manual',
        }), {});
        return { status: res.status, location: res.headers.get('location') ?? '' };
    };

    const csrf = 'a'.repeat(64);
    const cases: { name: string; file: string; path: string; noSession: RegExp; wrongUser: RegExp }[] = [
        {
            name: 'LinkedIn / X (social-oauth-callback)',
            file: 'social-oauth-callback',
            path: `/.netlify/functions/social-oauth-callback?code=abc&state=${b64({ platform: 'x', userId: '101', csrf })}`,
            noSession: /^\/workspace\.html\?oauth_error=invalid_session&platform=x$/,
            wrongUser: /^\/workspace\.html\?oauth_error=csrf_fail&platform=x$/,
        },
        {
            name: 'Facebook / Instagram (meta-oauth)',
            file: 'meta-oauth',
            path: `/.netlify/functions/meta-oauth?action=callback&code=abc&state=${b64({
                organisationId: '58', userId: '101', assistantId: '7', platform: 'instagram', csrf,
                csrfHmac: createHmac('sha256', process.env.JWT_SECRET!).update(csrf).digest('hex'),
            })}`,
            noSession: /^\/workspace\.html\?meta_error=invalid_session&platform=instagram&assistantId=7$/,
            wrongUser: /^\/workspace\.html\?meta_error=csrf_fail&platform=instagram&assistantId=7$/,
        },
        {
            name: 'Meta ads (meta-ads-oauth-callback)',
            file: 'meta-ads-oauth-callback',
            path: `/.netlify/functions/meta-ads-oauth-callback?code=abc&state=${b64({ flow: 'meta_ads', userId: '101', csrf })}`,
            noSession: /^\/integrations\.html\?meta_ads_error=invalid_session$/,
            wrongUser: /^\/integrations\.html\?meta_ads_error=invalid_state$/,
        },
        {
            name: 'LinkedIn ads (linkedin-ads-oauth-callback)',
            file: 'linkedin-ads-oauth-callback',
            path: `/.netlify/functions/linkedin-ads-oauth-callback?code=abc&state=${b64({ flow: 'linkedin_ads', userId: '101', csrf })}`,
            noSession: /^\/integrations\.html\?ads_error=invalid_session$/,
            wrongUser: /^\/integrations\.html\?ads_error=invalid_state$/,
        },
    ];

    // Every refusal runs first, while nothing has touched the database, so a request still retrying from a
    // right-user case below can never be counted against a refusal (review of #942).
    const handlers = new Map<string, H>();
    for (const c of cases) handlers.set(c.file, await load(c.file));
    for (const c of cases) {
        console.log(`${c.name}: refusals`);
        const handler = handlers.get(c.file)!;
        await check('no session → refused with invalid_session, before any database read', async () => {
            const before = dbConnects;
            const r = await call(handler, c.path);
            assert.strictEqual(r.status, 302);
            assert.match(r.location, c.noSession);
            assert.strictEqual(dbConnects, before, 'no database connection attempted');
        });
        await check("another user's session → refused, before any database read", async () => {
            const before = dbConnects;
            const r = await call(handler, c.path, cookieFor(202));
            assert.strictEqual(r.status, 302);
            assert.match(r.location, c.wrongUser);
            assert.strictEqual(dbConnects, before, 'no database connection attempted');
        });
    }

    const { closeDbPools } = await import('../db/client');
    for (const c of cases) {
        console.log(`${c.name}: the right user`);
        const handler = handlers.get(c.file)!;
        await check("the starter's own session → passes the check and goes on to the database", async () => {
            const before = dbConnects;
            // Don't wait for the handler to finish: postgres.js keeps retrying against the fake database,
            // so the request may never resolve. Wait (up to 3s) for the first connection attempt instead.
            let early: { location: string } | null = null;
            call(handler, c.path, cookieFor(101)).then((r) => { early = r; }, () => {});
            const deadline = Date.now() + 3000;
            while (dbConnects === before && !early && Date.now() < deadline) await new Promise((ok) => setTimeout(ok, 25));
            assert.doesNotMatch((early as { location: string } | null)?.location ?? '', /invalid_session/, 'not refused for a missing session');
            assert.ok(dbConnects > before, 'the handler went on to read the database');
        });
        // Drop the cached client so this request stops retrying and the next case's count is its own.
        await Promise.race([closeDbPools().catch(() => {}), new Promise((ok) => setTimeout(ok, 500))]);
        await new Promise((ok) => setTimeout(ok, 100));
    }

    // Order in the source: the session check sits before the CSRF entry is read or consumed (so a stranger's
    // visit can't burn it), and workspace membership is checked once the workspace is known.
    const order: [string, string, string, string][] = [
        ['social-oauth-callback', 'const session = requireSession(event);', 'const storedState = await getSecret(db, csrfKey)', 'await requireOrgMembership(db, userId, organisationId)'],
        ['meta-ads-oauth-callback', 'const session = requireSession(event);', 'const stored = await getSecret(db, metaAdsCsrfKey(userId))', 'await requireOrgMembership(db, userId, organisationId)'],
        ['linkedin-ads-oauth-callback', 'const session = requireSession(event);', 'const stored = await getSecret(db, adsCsrfKey(userId))', 'await requireOrgMembership(db, userId, organisationId)'],
        ['meta-oauth', 'const session = requireSession(event);', 'const tokenRes = await fetch(', 'await requireOrgMembership(getDb(), stateUserId, organisationId)'],
    ];
    console.log('order in the source');
    for (const [file, sessionMarker, readMarker, memberMarker] of order) {
        await check(`${file}: session check → state/CSRF use → membership check`, () => {
            const src = readFileSync(join(root, `netlify/functions/${file}.ts`), 'utf8');
            const s = src.indexOf(sessionMarker), r = src.indexOf(readMarker), m = src.indexOf(memberMarker);
            assert.ok(s > 0 && r > 0 && m > 0, `markers present (${s}, ${r}, ${m})`);
            assert.ok(s < r, 'session check before the CSRF entry / token exchange');
            assert.ok(file === 'meta-oauth' ? m < r : m > r, file === 'meta-oauth' ? 'membership before the token exchange' : 'membership once the workspace is known');
        });
    }

    fakeDb.close();
    console.log(`\n${passed} passed`);
    process.exit(process.exitCode ?? 0); // postgres.js may keep a retry timer alive
})().catch((err) => { console.error(err); process.exit(1); });
