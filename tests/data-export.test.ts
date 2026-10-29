// tests/data-export.test.ts
// Self-serve data export (DPA v1.1 §9: "export your workspace data at any time from My Account").
//
// Until 2026-10-12 the export existed only as an endpoint nothing called (the FAQ said to email us),
// it covered a handful of per-USER tables in an organisation-scoped product, built the whole file
// inside one request, and kept every file in the database forever. Pinned here:
//   1. scope — owners/admins get the workspace, members only their own records, never the org's;
//   2. no credential or internal storage pointer leaves in the file;
//   3. only data-export.ts can start a build (HMAC), the file is served from R2 or inline and purged
//      after the 24-hour link expires;
//   4. the button exists in My Account and its click is bound once, not from the render path.
//
// Run: npx tsx tests/data-export.test.ts

process.env.JWT_SECRET = 'test-secret-for-data-export';

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableName } from 'drizzle-orm';
import {
    stripSecrets, buildDataExport, exportJobSignature, WORKSPACE_TABLES, EXPORT_WORKSPACE_ROLES,
} from '../src/utils/workspace-export';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

let failed = 0;
async function check(name: string, fn: () => unknown | Promise<unknown>) {
    try { await fn(); console.log(`  ✓ ${name}`); }
    catch (e: any) { failed++; console.error(`  ✗ ${name}\n    ${e?.message}`); }
}

/** A db whose every select resolves to one row naming its table, with secret columns on it. */
function fakeDb() {
    const queried: string[] = [];
    const chain = (fields: Record<string, unknown> | undefined) => (table: any) => {
        const name = getTableName(table);
        queried.push(name);
        const full: Record<string, unknown> = { id: 1, table: name, verificationToken: 'tok', vaultRefKey: 'v', r2Key: 'k', hashtags: ['#a'] };
        // A select with named columns returns only those (as drizzle does).
        const rows = [fields ? Object.fromEntries(Object.keys(fields).map((k) => [k, full[k] ?? null])) : full];
        const q: any = {
            where: () => q,
            innerJoin: () => q,
            then: (res: any, rej: any) => Promise.resolve(rows).then(res, rej),
        };
        return q;
    };
    return { queried, db: { select: (fields?: Record<string, unknown>) => ({ from: chain(fields) }) } as any };
}

(async () => {
    console.log('data export');

    await check('stripSecrets drops credentials and storage pointers, keeps ordinary columns', () => {
        const out = stripSecrets({
            id: 1, email: 'a@b.c', hashtags: ['#x'], verificationToken: 't', deletionToken: 'd', tokenExpiresAt: 'x',
            vaultRefKey: 'v', r2Key: 'k', storageKey: 's', replyToken: 'r', secretRef: 's', ipHash: 'h',
            passwordHash: 'p', bonusReferralTokens: 3,
        });
        assert.deepStrictEqual(Object.keys(out).sort(), ['email', 'hashtags', 'id']);
    });

    await check('stripSecrets also strips keys nested in jsonb (audit state, metadata), keeps Dates', () => {
        const when = new Date('2026-10-12T00:00:00Z');
        const out: any = stripSecrets({
            id: 1, createdAt: when,
            newState: { r2Key: 'k', name: 'logo.png', nested: [{ accessToken: 'a', ok: true }] },
        });
        assert.strictEqual(out.createdAt, when);
        assert.deepStrictEqual(out.newState, { name: 'logo.png', nested: [{ ok: true }] });
    });

    await check('a member gets their own records and NO workspace table is read', async () => {
        const { db, queried } = fakeDb();
        const out: any = await buildDataExport(db, { userId: 7, organisationId: 3, includeWorkspace: false });
        assert.strictEqual(out.workspace, null);
        assert.ok(out.you.account, 'own account present');
        assert.ok(out.you.reviewOfBeMoreSwan && 'reviewRequests' in out.you, 'their review of Be More Swan and our asks are theirs');
        assert.ok(queried.includes('platform_reviews') && queried.includes('platform_review_asks'));
        const orgTables = Object.values(WORKSPACE_TABLES).map((t) => getTableName(t));
        const leaked = queried.filter((t) => orgTables.includes(t) || t === 'organisations' || t === 'user_organisations');
        assert.deepStrictEqual(leaked, []);
    });

    await check('an owner/admin gets every workspace section, stripped of secrets', async () => {
        const { db } = fakeDb();
        const out: any = await buildDataExport(db, { userId: 7, organisationId: 3, includeWorkspace: true });
        for (const name of Object.keys(WORKSPACE_TABLES)) assert.ok(Array.isArray(out.workspace[name]), `missing ${name}`);
        assert.ok(out.workspace.organisation && Array.isArray(out.workspace.members));
        const text = JSON.stringify(out);
        assert.ok(!/verificationToken|vaultRefKey|r2Key/.test(text), 'a secret column reached the file');
        assert.ok(/hashtags/.test(text));
    });

    await check('only owners and admins export the workspace', () => {
        assert.deepStrictEqual(EXPORT_WORKSPACE_ROLES, ['owner', 'admin']);
        const src = read('netlify/functions/data-export.ts');
        assert.match(src, /const includeWorkspace = EXPORT_WORKSPACE_ROLES\.includes\(ctx\.role\);/);
        assert.match(src, /requireTenant\(event, db\)/);
    });

    await check('the build signature binds the request, the org AND the scope', () => {
        const a = exportJobSignature(1, 3, false);
        assert.notStrictEqual(a, exportJobSignature(1, 3, true));
        assert.notStrictEqual(a, exportJobSignature(1, 4, false));
        assert.notStrictEqual(a, exportJobSignature(2, 3, false));
        const bg = read('netlify/functions/data-export-background.ts');
        assert.match(bg, /crypto\.timingSafeEqual/);
        assert.match(bg, /eq\(dataExportRequests\.status, 'pending'\)/);
        assert.match(bg, /buildTenantKey\(organisationId, 'data-exports'/);
    });

    await check('the download serves R2 by a short signed redirect, and inline/legacy rows directly', () => {
        const src = read('netlify/functions/data-export-download.ts');
        assert.match(src, /stored\.startsWith\('r2:'\)/);
        assert.match(src, /expiresIn: 300/);
        assert.match(src, /stored\.startsWith\('b64:'\) \? stored\.slice\(4\) : stored/);
    });

    await check('the nightly cleanup deletes expired export files', () => {
        const src = read('netlify/functions/storage-lifecycle-cleanup.ts');
        assert.match(src, /lt\(dataExportRequests\.expiresAt, now\)/);
        assert.match(src, /set\(\{ downloadUrl: null, status: 'expired' \}\)/);
    });

    await check('My Account has the button; the click is bound once on document', () => {
        const settings = read('user-settings.html');
        assert.match(settings, /id="data-export-btn"/);
        assert.match(settings, /id="data-export-download"/);
        const ws = read('workspace.html');
        assert.match(ws, /window\.renderDataExport\?\.\(\);/);
        const i = ws.indexOf('window.renderDataExport = async function');
        assert.ok(i > 0);
        const block = ws.slice(i, ws.indexOf('</script>', i));
        assert.match(block, /document\.addEventListener\('click'/);
        assert.ok(!/getElementById\('data-export-btn'\)\.addEventListener/.test(ws), 'click bound from the render path');
    });

    await check('the FAQ points at the button, not only at an email address', () => {
        assert.match(read('faq.html'), /Export my data/);
    });

    if (failed) { console.error(`\n${failed} failed`); process.exit(1); }
    console.log('\nall passed');
})();
