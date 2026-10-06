// netlify/functions/site-theme.ts
// The Be More Swan site theme — what every page's text, headings, labels, buttons and borders look
// like — read by every page and edited in Admin ▸ Site Styles.
//
//   GET                                   → { version, css, fontUrl }   public, CDN-cached ~10s
//   POST { action: 'get' }                → { standard, draft, defaults, updatedAt, updatedBy }  admin
//   POST { action: 'saveDraft', theme }   → { draft }        admin — the work in progress, not live
//   POST { action: 'publish', theme, reason? } → { version, css, fontUrl }  admin — "Set as the
//                                           Be More Swan standard": every page picks it up live
//
// Stored in platform_config (key/value jsonb — no migration): `site_theme.standard` is what pages
// show, `site_theme.draft` is the admin's unpublished edit. Both are normalised through
// src/public/site-theme-core.js on the way IN and OUT, so a value that is not a hex / known font /
// listed option can never reach a stylesheet — the CSS is built only from validated tokens.
//
// A missing row (fresh database, or nothing ever published) is the default theme, whose CSS is
// empty: the site looks exactly as style.css draws it.

import jwt from 'jsonwebtoken';
import { eq, inArray } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, platformConfig } from '../../db/schema';
import { hasPermission } from '../../src/utils/rbac';
import { insertAdminAuditLog, getAdminIp } from '../../src/utils/admin-audit';
import { normalizeTheme, themeCss, fontUrl, defaults } from '../../src/public/site-theme-core.js';
import { withLambda } from '@netlify/aws-lambda-compat';

export const STANDARD_KEY = 'site_theme.standard';
export const DRAFT_KEY = 'site_theme.draft';

const json = (statusCode: number, body: unknown, headers: Record<string, string> = {}) => ({
    statusCode, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
});

async function requireAdmin(event: any): Promise<{ id: number } | null> {
    const secret = process.env.JWT_SECRET;
    if (!secret) return null;
    const match = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!match) return null;
    let userId: number;
    try { userId = (jwt.verify(match[1], secret) as { userId: number }).userId; } catch { return null; }
    const [row] = await getDb().select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
    return hasPermission(row?.role, 'platform_config') ? { id: userId } : null;
}

/** What a page needs: the CSS and the font sheet, plus a version to tell a change from a repeat. */
export function published(theme: unknown, updatedAt: Date | string | null) {
    const t = normalizeTheme(theme);
    return {
        version: updatedAt ? new Date(updatedAt).toISOString() : 'default',
        css: themeCss(t),
        fontUrl: fontUrl(t),
    };
}

export default withLambda(async (event) => {
    const db = getDb();

    // ── Public: the standard, for every page ──────────────────────────────────────────────────────
    if (event.httpMethod === 'GET') {
        let row: { value: unknown; updatedAt: Date } | undefined;
        try {
            [row] = await db.select({ value: platformConfig.value, updatedAt: platformConfig.updatedAt })
                .from(platformConfig).where(eq(platformConfig.key, STANDARD_KEY)).limit(1);
        } catch (err) {
            // Never break a page over its styling: no theme = the design as built.
            console.error('[site-theme] read failed — serving the default theme', err);
        }
        return json(200, published(row?.value ?? null, row?.updatedAt ?? null), {
            // Every open tab polls this. A short CDN cache keeps that to about one database read per
            // edge every 10s however many tabs are open; the browser itself never caches it, so a
            // publish reaches an open page within one poll plus this window.
            'Cache-Control': 'public, max-age=0, must-revalidate',
            'Netlify-CDN-Cache-Control': 'public, s-maxage=10, stale-while-revalidate=30',
        });
    }

    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
    const admin = await requireAdmin(event);
    if (!admin) return json(403, { error: 'Not allowed.' });

    let body: { action?: string; theme?: unknown; reason?: string };
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }

    const rows = await db.select().from(platformConfig).where(inArray(platformConfig.key, [STANDARD_KEY, DRAFT_KEY]));
    const standardRow = rows.find((r) => r.key === STANDARD_KEY);
    const draftRow = rows.find((r) => r.key === DRAFT_KEY);
    const standard = normalizeTheme(standardRow?.value ?? null);

    if (body.action === 'get') {
        let updatedBy: string | null = null;
        if (standardRow?.updatedBy) {
            const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, standardRow.updatedBy)).limit(1);
            updatedBy = u?.email ?? null;
        }
        return json(200, {
            standard,
            draft: draftRow ? normalizeTheme(draftRow.value) : standard,
            defaults: defaults(),
            updatedAt: standardRow?.updatedAt ?? null,
            updatedBy,
        });
    }

    const upsert = (key: string, value: unknown, reason: string | null) => db.insert(platformConfig)
        .values({ key, value, updatedBy: admin.id, reason, updatedAt: new Date() })
        .onConflictDoUpdate({ target: platformConfig.key, set: { value, updatedBy: admin.id, reason, updatedAt: new Date() } });

    if (body.action === 'saveDraft') {
        const draft = normalizeTheme(body.theme);
        await upsert(DRAFT_KEY, draft, null);
        return json(200, { draft });
    }

    if (body.action === 'publish') {
        const theme = normalizeTheme(body.theme);
        const reason = String(body.reason || '').trim().slice(0, 500) || 'Set as the Be More Swan standard';
        const now = new Date();
        await upsert(STANDARD_KEY, theme, reason);
        await upsert(DRAFT_KEY, theme, null);
        // Only the tokens that moved — a readable answer to "who changed the buttons, and from what".
        const changed = Object.keys(theme).filter((k) => theme[k] !== standard[k]);
        void insertAdminAuditLog({
            adminId: admin.id,
            action: 'site_theme_publish',
            targetType: 'platform_config',
            targetId: STANDARD_KEY,
            previousState: Object.fromEntries(changed.map((k) => [k, standard[k]])),
            newState: Object.fromEntries(changed.map((k) => [k, theme[k]])),
            reason,
            ipAddress: getAdminIp(event.headers as Record<string, string | undefined>),
            userAgent: (event.headers as Record<string, string | undefined>)['user-agent'],
        });
        return json(200, published(theme, now));
    }

    return json(400, { error: 'Unknown action.' });
});
