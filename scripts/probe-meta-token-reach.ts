// scripts/probe-meta-token-reach.ts
//
// READ-ONLY diagnostic: for every active Meta connection in an org, ask Meta what the row's stored
// token can actually SEE, and whether the exact call the publisher makes would succeed.
//
// Written 2026-09-03 to explain two failures that reached Needs Attention on prod:
//   • Facebook — "(#200) The permission(s) publish_actions are not available. It has been deprecated."
//   • Instagram — "Unsupported post request. Object with ID '…' does not exist, cannot be loaded
//     due to missing permissions, or does not support this operation."
// Neither is the app-level block of 2026-09-02 (that one says "API access blocked." and is HELD by
// isMetaAppBlocked, not failed). Both are the shape you get when a VALID token is pointed at an
// account it does not administer — so the question is reach, not validity.
//
// ⚠️ Prints NO token, ever. Each secret is reduced to a sha256 fingerprint so two rows can be
// compared without a credential landing in a terminal or a transcript.
//
// Writes nothing, with the one caveat the backfill script carries: getSecret() lazily re-encrypts a
// secret that is on an older KEK version. Same rotation any normal read triggers.
//
// Usage:
//   export VAULT_KEK_1=$(npx netlify env:get VAULT_KEK_1 --context production)
//   npx tsx scripts/probe-meta-token-reach.ts --org=37 --url-var=DATABASE_URL_PROD
//
// Optional: export META_APP_ID / META_APP_SECRET to add the debug_token read (token validity,
// granted scopes, expiry, and app-level enforcement). Without them the probe still answers reach.

import { config } from 'dotenv';
import { createHash } from 'node:crypto';
import * as path from 'path';
import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../db/client';
import { systemConnections } from '../db/schema';
import { getSecret } from '../src/utils/vault';

config({ path: path.resolve(process.cwd(), '.env') });

const GRAPH = 'v19.0';
const args = process.argv.slice(2);
const flag = (n: string) => args.find(a => a.startsWith(`--${n}=`))?.split('=')[1];
const onlyOrg = Number(flag('org')) || null;
const urlVar = flag('url-var') ?? 'NETLIFY_DATABASE_URL';

const fingerprint = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12);

async function graph(pathAndQuery: string): Promise<{ ok: boolean; status: number; data: any }> {
    const res = await fetch(`https://graph.facebook.com/${GRAPH}/${pathAndQuery}`);
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
}

/** Meta's error object, flattened to one line. */
function err(data: any): string {
    const e = data?.error;
    if (!e) return 'no error object';
    return `(#${e.code}${e.error_subcode ? `/${e.error_subcode}` : ''}) ${e.message}`;
}

async function main() {
    if (urlVar !== 'NETLIFY_DATABASE_URL') {
        const override = process.env[urlVar];
        if (!override) {
            console.error(`\n${urlVar} is not set. Export it, or drop --url-var.\n`);
            process.exit(1);
        }
        process.env.NETLIFY_DATABASE_URL = override;
    }
    const raw = process.env.NETLIFY_DATABASE_URL!;
    const u = (() => { try { const p = new URL(raw); return `${p.host}${p.pathname}`; } catch { return 'unparseable'; } })();

    console.log('\nMeta token reach probe  (read-only)');
    console.log(`  target : ${u}  [${urlVar}]`);
    console.log(`  scope  : ${onlyOrg ? `organisation ${onlyOrg}` : 'ALL organisations'}, active rows only`);
    console.log(`  secrets: never printed — sha256 fingerprint only\n`);

    const db = getDb();
    const rows = await db.select({
        id: systemConnections.id,
        organisationId: systemConnections.organisationId,
        serviceName: systemConnections.serviceName,
        externalUserId: systemConnections.externalUserId,
        vaultRefKey: systemConnections.vaultRefKey,
        status: systemConnections.status,
        tokenExpiresAt: systemConnections.tokenExpiresAt,
        updatedAt: systemConnections.updatedAt,
        metadata: systemConnections.metadata,
    }).from(systemConnections).where(and(
        inArray(systemConnections.serviceName, ['instagram', 'facebook']),
        eq(systemConnections.isActive, true),
        ...(onlyOrg ? [eq(systemConnections.organisationId, onlyOrg)] : []),
    ));

    if (!rows.length) { console.log('  no active Meta connections in scope\n'); return; }

    const appId = process.env.META_APP_ID;
    const appSecret = process.env.META_APP_SECRET;
    const appToken = appId && appSecret ? `${appId}|${appSecret}` : null;
    if (!appToken) console.log('  note: META_APP_ID/META_APP_SECRET unset — skipping debug_token.\n');

    for (const row of rows) {
        const meta = (row.metadata ?? {}) as any;
        console.log('─'.repeat(94));
        console.log(`conn ${row.id}  ${row.serviceName}  org ${row.organisationId}  status=${row.status}`);
        console.log(`  external_user_id : ${row.externalUserId}`);
        console.log(`  metadata         : fbPageId=${meta.fbPageId ?? '—'}  igUsername=${meta.igUsername ?? '—'}  pageName=${meta.pageName ?? '—'}  fbUserId=${meta.fbUserId ?? '—'}`);
        console.log(`  vault_ref_key    : ${row.vaultRefKey}`);
        console.log(`  token_expires_at : ${row.tokenExpiresAt?.toISOString?.() ?? row.tokenExpiresAt}   updated=${row.updatedAt?.toISOString?.() ?? row.updatedAt}`);

        if (!row.vaultRefKey) { console.log('  ✗ no vault_ref_key — nothing to probe\n'); continue; }
        const secret = await getSecret(db, row.vaultRefKey);
        const token = secret?.token as string | undefined;
        if (!token) { console.log('  ✗ no token in vault under that key\n'); continue; }
        console.log(`  token            : sha256:${fingerprint(token)}  (len ${token.length})`);

        const at = `access_token=${encodeURIComponent(token)}`;

        // 1) Whose token is this?
        const me = await graph(`me?fields=id,name&${at}`);
        console.log(me.ok
            ? `  identity         : ${me.data.name ?? '(no name)'}  id=${me.data.id}`
            : `  identity         : ✗ ${err(me.data)}`);

        // 2) What did the user actually grant? A declined/missing scope is the whole story.
        const perms = await graph(`me/permissions?${at}`);
        if (perms.ok) {
            const granted = (perms.data.data ?? []).filter((p: any) => p.status === 'granted').map((p: any) => p.permission);
            const declined = (perms.data.data ?? []).filter((p: any) => p.status !== 'granted').map((p: any) => `${p.permission}:${p.status}`);
            console.log(`  granted (${granted.length})     : ${granted.sort().join(', ') || '(none)'}`);
            if (declined.length) console.log(`  NOT granted      : ${declined.sort().join(', ')}`);
            for (const need of ['pages_show_list', 'pages_manage_posts', 'instagram_basic', 'instagram_content_publish']) {
                if (!granted.includes(need)) console.log(`  ⚠️  missing scope : ${need}`);
            }
        } else {
            console.log(`  permissions      : ✗ ${err(perms.data)}`);
        }

        // 3) Token validity + app-level enforcement, if we have an app token.
        if (appToken) {
            const dbg = await graph(`debug_token?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(appToken)}`);
            if (dbg.ok && dbg.data?.data) {
                const d = dbg.data.data;
                console.log(`  debug_token      : valid=${d.is_valid} type=${d.type} expires=${d.expires_at ? new Date(d.expires_at * 1000).toISOString() : 'never'}${d.error ? `  error=(#${d.error.code}) ${d.error.message}` : ''}`);
            } else {
                console.log(`  debug_token      : ✗ ${err(dbg.data)}`);
            }
        }

        // 4) What Pages does this token actually reach? This is the list the connect flow read.
        let reachedDirect = false;
        const accounts = await graph(`me/accounts?fields=id,name,instagram_business_account{id,username}&${at}`);
        if (accounts.ok) {
            const list = accounts.data.data ?? [];
            console.log(`  /me/accounts     : ${list.length} page(s)`);
            for (const p of list) {
                const ig = p.instagram_business_account;
                console.log(`      • page ${p.id}  "${p.name}"${ig ? `   ig ${ig.id} @${ig.username ?? '?'}` : '   (no IG linked)'}`);
            }
            reachedDirect = row.serviceName === 'facebook'
                ? list.some((p: any) => String(p.id) === String(row.externalUserId))
                : list.some((p: any) => String(p.instagram_business_account?.id) === String(row.externalUserId));
            console.log(reachedDirect
                ? `  ✅ this token reaches its own external_user_id`
                : `  🔴 this token does NOT reach ${row.externalUserId} — the row is bound to an account this token cannot administer`);
        } else {
            console.log(`  /me/accounts     : ✗ ${err(accounts.data)}`);
        }

        // 5) Business/Meta-portfolio traversal — what meta-oauth.ts:382 SKIPS.
        //
        // ⚠️ The connect flow runs this scan only `if (!pageList.some(p => p.instagram_business_account?.id))`.
        // One directly-administered Page with an IG linked is enough to suppress it, so a user whose
        // business Pages live in a portfolio never sees them offered. We run it UNCONDITIONALLY here,
        // because the whole question is whether the row's account is reachable-but-unenumerated
        // (a code bug) or genuinely not granted to the app (needs a re-consent).
        const biz = await graph(`me/businesses?fields=id,name&${at}`);
        if (!biz.ok) {
            console.log(`  /me/businesses   : ✗ ${err(biz.data)}  (business_management not usable)`);
        } else {
            const businesses = biz.data.data ?? [];
            console.log(`  /me/businesses   : ${businesses.length} portfolio(s)`);
            let foundHere = false;
            for (const b of businesses) {
                for (const edge of ['owned_pages', 'client_pages'] as const) {
                    const r = await graph(`${b.id}/${edge}?fields=id,name,instagram_business_account{id,username}&${at}`);
                    if (!r.ok) { console.log(`      • ${b.name ?? b.id} ${edge}: ✗ ${err(r.data)}`); continue; }
                    for (const p of r.data.data ?? []) {
                        const ig = p.instagram_business_account;
                        const isTarget = row.serviceName === 'facebook'
                            ? String(p.id) === String(row.externalUserId)
                            : String(ig?.id) === String(row.externalUserId);
                        if (isTarget) foundHere = true;
                        console.log(`      • ${b.name ?? b.id}/${edge}: page ${p.id} "${p.name}"${ig ? `  ig ${ig.id} @${ig.username ?? '?'}` : '  (no IG linked)'}${isTarget ? '   ⬅ THIS ROW\'S ACCOUNT' : ''}`);
                    }
                }
            }
            console.log(reachedDirect
                ? `  ✅ VERDICT: reachable via /me/accounts — the publisher's own lookup path. Nothing to fix here.${foundHere ? ' (also present in a portfolio.)' : ''}`
                : foundHere
                ? `  🟠 VERDICT: reachable via a portfolio but NOT via /me/accounts — meta-oauth.ts:382\n              suppresses the portfolio scan whenever any directly-administered Page has an\n              IG linked, so the picker never offers this account. CODE FIX, not a re-consent.`
                : `  🔴 VERDICT: not reachable via /me/accounts OR any portfolio — this token has no granted\n              relationship to ${row.externalUserId}. Needs a re-consent with the account ticked.`);
        }

        // 6) The exact call the publisher makes, reproduced read-only.
        if (row.serviceName === 'facebook' && row.externalUserId) {
            // social-publish.ts:1404 — derivePageToken(); on null it falls back to the USER token,
            // and a user token on /{pageId}/feed is what returns the publish_actions message.
            const pt = await graph(`${row.externalUserId}?fields=access_token&${at}`);
            console.log(pt.ok && pt.data?.access_token
                ? `  derivePageToken  : ✅ Page token derived (sha256:${fingerprint(pt.data.access_token)})`
                : `  derivePageToken  : 🔴 NULL — publisher falls back to the USER token → "(#200) publish_actions" \n                     reason: ${err(pt.data)}`);
        }
        if (row.serviceName === 'instagram' && row.externalUserId) {
            // publish-instagram.ts:344 posts to /{igUserId}/media. Read the same node first.
            const node = await graph(`${row.externalUserId}?fields=id,username&${at}`);
            console.log(node.ok
                ? `  IG node read     : ✅ @${node.data.username ?? '?'} (${node.data.id}) visible to this token`
                : `  IG node read     : 🔴 ${err(node.data)}\n                     this is the publish error, reproduced read-only`);
        }
        console.log('');
    }
    console.log('─'.repeat(94));
    console.log('done — nothing written\n');
}

main().catch(e => { console.error(e); process.exit(1); });
