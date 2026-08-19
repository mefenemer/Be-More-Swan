// netlify/functions/save-widget-config.ts
// Autonomous Content Engine — US 3.1 AC1/AC2: manage a workspace's embeddable widget config.
//
// GET  → the org's widget config (or { config: null } if none yet)
// POST { action:'create' }                                   → create with a fresh public_key
// POST { action:'update', theme?, badgeEnabled?, name?, allowedOrigins?, siteBaseUrl?, sitePostPath? }
//   theme: { accent?: '#rrggbb', fontFamily?: <a stack from src/config/blog-fonts.ts> }
//          fontUrl is DERIVED server-side from fontFamily — see validateTheme.
//                                                            → update (admin/owner only)
//
// siteBaseUrl + sitePostPath tell us where the customer PUBLISHES so canonical URLs can credit their
// own domain (US 1.3). BOTH are required to canonicalise there; sitePostPath must be a rooted path
// containing the {slug} placeholder — a pattern without it would canonicalise every post to one URL
// and collapse the whole blog (see blog-seo-metadata.sql / blog-seo.ts resolveCanonical).
//
// public_key is the unguessable identifier baked into the embed <script data-bms-key>. Theming
// writes are gated to owner/admin. See docs §8.

import { HandlerEvent } from '@netlify/functions';
import { randomBytes } from 'crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { organisations, widgetConfigs } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { withLambda } from '@netlify/aws-lambda-compat';
import { findBlogFont, googleFontUrl, matchBlogFontByFamily, DEFAULT_FONT_STACK } from '../../src/config/blog-fonts';
import { normalizeBrandKit } from '../../src/utils/brand-kit';

const WRITE_ROLES = ['owner', 'admin'];
const newPublicKey = () => 'wgt_' + randomBytes(12).toString('hex');

/**
 * Validate a theme before it is stored.
 *
 * ⚠️ This used to be `updates.theme = body.theme` — whatever the client sent, stored verbatim. Both
 * fields end up INSIDE a published page: `accent` and `fontFamily` are written into a `<style>` on
 * the customer's own site by widget.js, and `fontUrl` becomes a `<link href>` there and on the
 * server-rendered permalink. Being authenticated is not the same as being safe to interpolate — a
 * fontFamily of `x; } body { … }` closes the rule and opens another.
 *
 * So the rule is: a theme must be something this codebase could itself have produced. accent is a
 * 6-digit hex (what `<input type="color">` emits and nothing else), fontFamily must be a stack from
 * src/config/blog-fonts.ts, and fontUrl must be exactly that font's own stylesheet.
 *
 * Returns the clean theme, or a message naming the offending field.
 */
function validateTheme(raw: unknown): { theme: Record<string, unknown> } | { error: string } {
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'theme must be an object.' };
    const input = raw as Record<string, unknown>;
    const theme: Record<string, unknown> = {};

    if (input.accent !== undefined && input.accent !== null) {
        if (typeof input.accent !== 'string' || !/^#[0-9a-f]{6}$/i.test(input.accent.trim())) {
            return { error: 'theme.accent must be a hex colour, e.g. #ec4899.' };
        }
        theme.accent = input.accent.trim().toLowerCase();
    }

    if (input.fontFamily !== undefined && input.fontFamily !== null && input.fontFamily !== '') {
        const font = findBlogFont(input.fontFamily as string);
        if (!font) return { error: 'theme.fontFamily is not one of the available fonts.' };
        theme.fontFamily = font.stack;
        // Derived, never trusted from the body. The client sends it so the two stay visibly in step,
        // but a mismatch means a stale or tampered page — take our own answer either way.
        theme.fontUrl = googleFontUrl(font);
    } else if (input.fontFamily === '' || input.fontFamily === null) {
        theme.fontFamily = DEFAULT_FONT_STACK;
        theme.fontUrl = null;
    }

    return { theme };
}

/**
 * The theme a brand-new widget starts on: the org's OWN colours and typeface, taken from
 * organisations.brand_kit (extracted from their website — see src/lib/brand-extract-fetch.ts).
 *
 * ⚠️ Why this is not simply `{}`. An empty theme is not neutral: widget.js and the permalink
 * renderer both fall back to #ec4899, which is Be More Swan's pink. So every customer who never
 * opened the Widget panel was publishing a blog on their own domain in OUR brand colour — the
 * same class of mistake DEFAULT_BRAND_KIT exists to prevent on brand cards.
 *
 * Only a kit that was actually extracted or set by hand is used. `source: 'default'` is the
 * neutral monochrome placeholder, and stamping near-black on a blog as a deliberate choice would
 * be inventing a decision nobody made.
 *
 * Font: the kit records a bare family name off the site's CSS; only families we can actually serve
 * survive matchBlogFontByFamily, and the URL is derived here exactly as validateTheme derives it.
 */
async function brandSeedTheme(db: ReturnType<typeof getDb>, organisationId: number): Promise<Record<string, unknown>> {
    try {
        const [org] = await db
            .select({ brandKit: organisations.brandKit })
            .from(organisations).where(eq(organisations.id, organisationId)).limit(1);
        const kit = normalizeBrandKit(org?.brandKit);
        if (kit.source === 'default') return {};

        const theme: Record<string, unknown> = {};
        if (kit.primaryColor) theme.accent = kit.primaryColor;
        const font = matchBlogFontByFamily(kit.fontFamily);
        if (font) { theme.fontFamily = font.stack; theme.fontUrl = googleFontUrl(font); }
        return theme;
    } catch {
        // Creating the widget matters more than theming it — an unreadable brand kit leaves the
        // theme empty, which is exactly where this started.
        return {};
    }
}

export default withLambda(async (event: HandlerEvent) => {
    const db = getDb();

    // Reads: any member. Writes: owner/admin (enforced below on the write branch).
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;

    if (event.httpMethod === 'GET') {
        const [config] = await db
            .select()
            .from(widgetConfigs)
            .where(eq(widgetConfigs.organisationId, ctx.organisationId))
            .limit(1);
        return { statusCode: 200, body: JSON.stringify({ config: config || null }) };
    }

    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    if (!WRITE_ROLES.includes(ctx.role)) {
        return { statusCode: 403, body: JSON.stringify({ error: 'Only an owner or admin can change the widget.' }) };
    }

    let body: any;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body.' }) }; }

    const [existing] = await db
        .select()
        .from(widgetConfigs)
        .where(eq(widgetConfigs.organisationId, ctx.organisationId))
        .limit(1);

    if (body.action === 'create') {
        if (existing) return { statusCode: 200, body: JSON.stringify({ config: existing }) };
        const [config] = await db
            .insert(widgetConfigs)
            .values({
                organisationId: ctx.organisationId,
                publicKey: newPublicKey(),
                createdBy: ctx.userId,
                theme: await brandSeedTheme(db, ctx.organisationId),
            })
            .returning();
        return { statusCode: 201, body: JSON.stringify({ config }) };
    }

    if (body.action === 'update') {
        if (!existing) return { statusCode: 404, body: JSON.stringify({ error: 'No widget to update — create one first.' }) };
        const updates: Record<string, unknown> = { updatedAt: new Date() };
        if (body.theme !== undefined) {
            const checked = validateTheme(body.theme);
            if ('error' in checked) return { statusCode: 400, body: JSON.stringify({ error: checked.error }) };
            updates.theme = checked.theme;
        }
        if (typeof body.name === 'string') updates.name = body.name.slice(0, 120);
        if (typeof body.badgeEnabled === 'boolean') updates.badgeEnabled = body.badgeEnabled;
        if (Array.isArray(body.allowedOrigins)) updates.allowedOrigins = body.allowedOrigins.slice(0, 50);

        // Public-site canonical settings. '' clears the field (back to self-canonical /b/:key/:slug).
        if (typeof body.siteBaseUrl === 'string') {
            const v = body.siteBaseUrl.trim();
            if (v === '') { updates.siteBaseUrl = null; }
            else if (/^https?:\/\/[^\s/]+/i.test(v)) { updates.siteBaseUrl = v.replace(/\/+$/, '').slice(0, 300); }
            else { return { statusCode: 400, body: JSON.stringify({ error: 'siteBaseUrl must be a full http(s) URL, e.g. https://acme.com' }) }; }
        }
        if (typeof body.sitePostPath === 'string') {
            const v = body.sitePostPath.trim();
            if (v === '') { updates.sitePostPath = null; }
            // Must mirror the DB CHECK: rooted path containing the {slug} placeholder.
            else if (v.startsWith('/') && v.includes('{slug}')) { updates.sitePostPath = v.slice(0, 300); }
            else { return { statusCode: 400, body: JSON.stringify({ error: 'sitePostPath must be a rooted path containing {slug}, e.g. /blog/{slug}' }) }; }
        }

        const [config] = await db
            .update(widgetConfigs)
            .set(updates)
            .where(eq(widgetConfigs.organisationId, ctx.organisationId))
            .returning();
        return { statusCode: 200, body: JSON.stringify({ config }) };
    }

    return { statusCode: 400, body: JSON.stringify({ error: 'Unknown action.' }) };
});
