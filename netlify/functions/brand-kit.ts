// netlify/functions/brand-kit.ts — read, extract and edit the org's visual brand kit.
//
// GET                        → { brandKit, websiteUrl }
// POST { action: 'extract' } → re-derive the kit from the org's website (organisations.website_url)
// PATCH { ...fields }        → set fields by hand; marks the kit 'manual', which permanently stops
//                              automatic extraction from overwriting it
//   Auth: aura_session cookie; the kit is always the CALLER's own organisation.
//
// Extraction also happens lazily from the drafting path the first time a card is rendered, so this
// endpoint is the manual override rather than the only way in: it exists so a user can fix a bad
// guess, and re-run it after a rebrand without waiting out EXTRACT_RETRY_DAYS.

import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { organisations } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { extractBrandKitFromWebsite } from '../../src/lib/brand-extract-fetch';
import { normalizeBrandKit, normalizeHex, cleanFontFamily, type BrandKit } from '../../src/utils/brand-kit';
import { withLambda } from '@netlify/aws-lambda-compat';

const json = (statusCode: number, body: unknown) => ({
    statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

export default withLambda(async (event) => {
    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;

    const [org] = await db
        .select({ name: organisations.name, websiteUrl: organisations.websiteUrl, brandKit: organisations.brandKit })
        .from(organisations).where(eq(organisations.id, ctx.organisationId)).limit(1);
    if (!org) return json(404, { error: 'Organisation not found.' });

    const stored = normalizeBrandKit(org.brandKit);

    if (event.httpMethod === 'GET') {
        return json(200, { brandKit: stored, websiteUrl: org.websiteUrl });
    }

    if (event.httpMethod === 'POST') {
        let body: { action?: string };
        try { body = JSON.parse(event.body || '{}'); }
        catch { return json(400, { error: 'Invalid JSON.' }); }
        if (body.action !== 'extract') return json(400, { error: 'Unknown action.' });

        if (!org.websiteUrl?.trim()) {
            return json(400, { error: 'Add your website address on Business Information first — that is where the colours come from.' });
        }

        const now = new Date();
        const extracted = await extractBrandKitFromWebsite(org.websiteUrl, { now });

        // Stamp the attempt even when nothing was found, exactly as the lazy path does — otherwise
        // a user hammering the button re-fetches an unreadable site on every click.
        const next: BrandKit = extracted ?? { ...stored, lastExtractAttemptAt: now.toISOString() };
        await db.update(organisations).set({ brandKit: next, updatedAt: now })
            .where(eq(organisations.id, ctx.organisationId));

        return json(200, {
            brandKit: next,
            extracted: !!extracted,
            // A null result is a normal outcome (a monochrome site has no accent to find), so it is
            // reported as a message rather than an error the UI has to treat as a failure.
            message: extracted
                ? `Brand colours read from ${org.websiteUrl}.`
                : "We couldn't find a clear brand colour on that site. Your cards will use a neutral palette — you can set the colours by hand.",
        });
    }

    if (event.httpMethod === 'PATCH') {
        let body: Record<string, unknown>;
        try { body = JSON.parse(event.body || '{}'); }
        catch { return json(400, { error: 'Invalid JSON.' }); }

        // Only the fields a human sets. extractedAt/lastExtractAttemptAt are the extractor's own
        // bookkeeping and are carried over untouched — letting a client write them would hand it
        // control of the retry backoff.
        const patch: Record<string, unknown> = {};
        for (const field of ['primaryColor', 'textColor', 'backgroundColor'] as const) {
            if (body[field] !== undefined) {
                const hex = normalizeHex(body[field]);
                if (!hex) return json(400, { error: `${field} must be a hex colour like #1f1e1b.` });
                patch[field] = hex;
            }
        }
        if (body.fontFamily !== undefined) {
            // An explicit null clears it back to the bundled family; a non-empty value must be a
            // family name we could actually put in a font URL.
            if (body.fontFamily === null || body.fontFamily === '') patch.fontFamily = null;
            else if (!cleanFontFamily(body.fontFamily)) return json(400, { error: 'That font name is not one we can use.' });
            else patch.fontFamily = cleanFontFamily(body.fontFamily);
        }
        for (const field of ['wordmark', 'logoUrl', 'website'] as const) {
            if (body[field] !== undefined) patch[field] = body[field] === '' ? null : body[field];
        }
        if (!Object.keys(patch).length) return json(400, { error: 'Nothing to update.' });

        // normalizeBrandKit is the gate on everything stored — logoUrl in particular must go
        // through cleanUrl, so a javascript: "logo" can never reach the renderer.
        const next = normalizeBrandKit({ ...stored, ...patch, source: 'manual' });
        await db.update(organisations).set({ brandKit: next, updatedAt: new Date() })
            .where(eq(organisations.id, ctx.organisationId));

        return json(200, { brandKit: next });
    }

    return json(405, { error: 'Method Not Allowed' });
});
