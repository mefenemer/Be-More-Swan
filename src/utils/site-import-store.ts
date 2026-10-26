// src/utils/site-import-store.ts — "Import my current site" in the database: start it, run it (the
// draft worker, draft-site-background.ts), and the owner's decision on the result. The pure work —
// reading pages into blocks, the plan, building sections from the owner's own words — is
// site-import.ts; this file only connects it to the real fetcher, model and picture library.
//
// The import never touches what the owner has: its result waits in site_imports ('ready') and
// replaces sites.draft only when they press "Use this as my draft" (GUI) or the chat's decision card.
// It never publishes. It shares the draft claim (sites.drafting_at) with the AI whole-site draft, so
// only one of the two runs at a time, and spends tasks the same way: 1 task, only once a draft exists.

import { and, eq, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { aiAssistants, contentAssets, siteImports, sites } from '../../db/schema';
import { gatewayGenerate } from '../lib/ai-gateway';
import { gatewayRoleModel } from './assistant-model';
import { persistBufferToR2, r2IsConfigured } from '../lib/media-persist';
import { CRAWLERS } from '../lib/robots';
import { parseModelJson } from './model-json';
import { createNotification } from './notify';
import { safeFetchBinary } from './safe-fetch';
import { normaliseSiteDefinition, type SiteDefinition } from './site-definition';
import { fetchSiteHtml } from './site-fetch';
import { runImport, type ImportDeps, type ImportReport, type PictureChoice } from './site-import';
import { claimDraft, definitionOf, endDraft, maxPagesFor, verifySiteAssets, type SiteRow } from './site-store';
import { triggerSiteDraft } from './trigger-site-draft';
import { hasTaskCapacity, recordCompletedWork, TASK_LIMIT_MESSAGE } from './work-metering';

type Db = ReturnType<typeof getDb>;
export type SiteImportRow = typeof siteImports.$inferSelect;

const PAGE_TIMEOUT_MS = 15_000;
const PAGE_MAX_BYTES = 5 * 1024 * 1024;   // a Wix home page is 0.6–2.2 MB of HTML (measured 2026-10-21)
const PICTURE_MAX_BYTES = 8 * 1024 * 1024;
const PICTURE_TYPES = /^image\/(jpeg|png|webp|gif)$/i;

/** What the Website tab and the chat see of the import: never the definition itself. */
export interface ImportView {
    status: 'reading' | 'ready' | 'failed';
    sourceUrl: string;
    pictures: PictureChoice;
    message: string | null;
    report: ImportReport | null;
    pages: Array<{ title: string; path: string; sections: number }>;
    updatedAt: Date;
}

/** The site's import, if any. Null on any read failure — the table may not exist yet (db/z-site-import.sql). */
export async function loadImport(db: Db, siteId: number): Promise<SiteImportRow | null> {
    try {
        const [row] = await db.select().from(siteImports).where(eq(siteImports.siteId, siteId)).limit(1);
        return row ?? null;
    } catch (err) {
        console.error('[site-import] read failed (is db/z-site-import.sql applied?)', err instanceof Error ? err.message : err);
        return null;
    }
}

export function importView(row: SiteImportRow | null): ImportView | null {
    if (!row) return null;
    const def = row.definition as SiteDefinition | null;
    return {
        status: row.status as ImportView['status'], sourceUrl: row.sourceUrl, pictures: row.pictures as PictureChoice,
        message: row.message, report: (row.report as ImportReport | null) ?? null,
        pages: Array.isArray(def?.pages) ? def!.pages.map((p) => ({ title: p.title, path: p.slug ? `/${p.slug}` : '/', sections: p.sections.length })) : [],
        updatedAt: row.updatedAt,
    };
}

/**
 * Start reading their site: claim the draft, note what was asked, wake the worker. The caller has
 * checked the owner says the site is theirs and chose what happens to the pictures.
 */
export async function startSiteImport(db: Db, site: SiteRow, opts: { url: string; pictures: PictureChoice; userId: number | null }): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
    if (!(await hasTaskCapacity(db, site.organisationId))) return { ok: false, status: 402, error: TASK_LIMIT_MESSAGE };
    if (!(await claimDraft(db, site.id))) return { ok: false, status: 409, error: 'Your site is already being drafted — wait for that to finish, then import.' };
    const values = { sourceUrl: opts.url, pictures: opts.pictures, status: 'reading', definition: null, report: null, message: null, requestedBy: opts.userId, updatedAt: new Date() };
    try {
        await db.insert(siteImports).values({ siteId: site.id, organisationId: site.organisationId, ...values })
            .onConflictDoUpdate({ target: siteImports.siteId, set: values });
    } catch (err) {
        console.error('[site-import] could not record the import', err instanceof Error ? err.message : err);
        await endDraft(db, site.id, null);
        return { ok: false, status: 503, error: 'Importing isn\'t available just yet. Nothing was charged.' };
    }
    if (!(await triggerSiteDraft(site.id, null, { import: true }))) {
        await endDraft(db, site.id, null);
        await failImport(db, site.id, 'The import couldn\'t be started. Nothing was charged — try again.', null);
        return { ok: false, status: 503, error: 'The import couldn\'t be started. Nothing was charged — try again.' };
    }
    return { ok: true };
}

async function failImport(db: Db, siteId: number, message: string, report: ImportReport | null): Promise<void> {
    await db.update(siteImports).set({ status: 'failed', message, report, definition: null, updatedAt: new Date() }).where(eq(siteImports.siteId, siteId));
}

/** The real outside world for runImport: robots + SSRF fence, the model, the picture library. */
function liveDeps(db: Db, site: SiteRow, userId: number): ImportDeps {
    return {
        fetchHtml: (url) => fetchSiteHtml(url, CRAWLERS.siteImport, { timeoutMs: PAGE_TIMEOUT_MS, maxBytes: PAGE_MAX_BYTES }),
        async plan(prompt) {
            const res = await gatewayGenerate({
                system: prompt.system, messages: [{ role: 'user', content: prompt.user }], maxTokens: 6000,
                usage: { workspaceId: site.organisationId, assistantId: site.aiAssistantId },
                // The Website role's model (Admin ▸ Assistants ▸ Model & rules). Background: full thinking.
                ...(await gatewayRoleModel(db, 'website_assistant')),
            });
            return parseModelJson(res.text);
        },
        savePicture: (src, alt) => saveImportedPicture(db, site.organisationId, userId, src, alt),
    };
}

/**
 * One picture from their old site into the workspace's library (content_assets, provider
 * 'site_import'), so the new site never hot-links someone else's CDN. The same picture imported
 * twice is the same library picture. Null when it couldn't be copied — the section goes without it.
 */
export async function saveImportedPicture(db: Db, orgId: number, userId: number, src: string, alt: string): Promise<number | null> {
    if (!r2IsConfigured()) return null;
    const [existing] = await db.select({ id: contentAssets.id }).from(contentAssets)
        .where(and(eq(contentAssets.organisationId, orgId), eq(contentAssets.provider, 'site_import'), eq(contentAssets.providerAssetId, src.slice(0, 1000)))).limit(1);
    if (existing) return existing.id;
    try {
        const res = await safeFetchBinary(src, { userAgent: CRAWLERS.siteImport.userAgent, timeoutMs: PAGE_TIMEOUT_MS, maxBytes: PICTURE_MAX_BYTES });
        const type = (res.contentType || '').split(';')[0].trim();
        if (!PICTURE_TYPES.test(type) || res.bytes.length < 1000) return null;
        const { storageKey, fileSize } = await persistBufferToR2({ orgId, bytes: res.bytes, contentType: type, folder: 'site-import' });
        const [row] = await db.insert(contentAssets).values({
            userId, organisationId: orgId, name: alt.slice(0, 120) || 'Picture from my website',
            assetType: 'image', mimeType: type, fileSize, storageKey, externalUrl: null,
            provider: 'site_import', providerAssetId: src.slice(0, 1000), status: 'pending',
        }).returning({ id: contentAssets.id });
        return row.id;
    } catch (err) {
        console.error('[site-import] picture not copied', { src: src.slice(0, 200), message: err instanceof Error ? err.message : String(err) });
        return null;
    }
}

/**
 * The worker's job: read, plan, build, and keep the result for review. Charged 1 task (as a website
 * draft) only when a draft was made; a site too thin to import costs nothing. Never throws.
 */
export async function runSiteImport(db: Db, siteId: number): Promise<void> {
    const [site] = await db.select().from(sites).where(eq(sites.id, siteId)).limit(1);
    if (!site) return;
    const row = await loadImport(db, site.id);
    if (!row || row.status !== 'reading') { await endDraft(db, site.id, null); return; }
    try {
        if (!(await hasTaskCapacity(db, site.organisationId))) { await failImport(db, site.id, TASK_LIMIT_MESSAGE, null); await endDraft(db, site.id, null); return; }
        const maxPages = await maxPagesFor(db, site.organisationId);
        const [assistant] = await db.select({ id: aiAssistants.id, name: aiAssistants.name, userId: aiAssistants.userId })
            .from(aiAssistants).where(eq(aiAssistants.id, site.aiAssistantId)).limit(1);
        const owner = row.requestedBy ?? assistant?.userId ?? null;
        if (!owner) { await failImport(db, site.id, 'The import couldn\'t be completed. Nothing was charged — try again.', null); await endDraft(db, site.id, null); return; }
        const outcome = await runImport(
            { url: row.sourceUrl, pictures: row.pictures === 'copy' ? 'copy' : 'skip', current: definitionOf(site, maxPages).definition, maxPages },
            liveDeps(db, site, owner),
        );
        if (!outcome.ok) { await failImport(db, site.id, outcome.message, outcome.report); await endDraft(db, site.id, null); return; }

        // Pictures were copied into THIS workspace's library; the save-time check still runs.
        const checked = await verifySiteAssets(db, site.organisationId, outcome.definition);
        const [saved] = await db.update(siteImports).set({ status: 'ready', definition: checked.definition, report: outcome.report, message: null, updatedAt: new Date() })
            .where(and(eq(siteImports.siteId, site.id), eq(siteImports.status, 'reading'))).returning({ id: siteImports.id });
        // The success latch: charged only if this import still held the claim.
        const [held] = await db.update(sites).set({ draftingAt: null, draftNote: null }).where(and(eq(sites.id, site.id), sql`${sites.draftingAt} IS NOT NULL`)).returning({ id: sites.id });
        if (!saved || !held) return;
        await recordCompletedWork(db, site.organisationId, 'site_draft', 1, site.id);
        if (assistant) {
            await createNotification(db, 'site_draft_ready', {
                userId: assistant.userId, assistantId: assistant.id, category: 'state_change',
                context: { assistant: { name: assistant.name }, site: { pages: `${checked.definition.pages.length} page${checked.definition.pages.length === 1 ? '' : 's'} imported from your old site` } },
                metadata: { assistantId: assistant.id, siteId: site.id, import: true },
            }).catch((err) => console.error('[site-import] notification failed', err));
        }
    } catch (err) {
        console.error('[site-import] import failed', { siteId, message: err instanceof Error ? err.message : String(err) });
        await failImport(db, site.id, 'The import couldn\'t be completed this time — your site is unchanged and nothing was charged. Try again in a few minutes.', null).catch(() => {});
        await endDraft(db, site.id, null).catch(() => {});
    }
}

/**
 * The owner's "Use this as my draft": the imported site replaces the draft, through the gate, keeping
 * the design they have now (and the imported logo only where they have none). Nothing goes live.
 */
export async function acceptImport(db: Db, site: SiteRow, maxPages: number): Promise<{ ok: true; site: SiteRow; warnings: string[] } | { ok: false; status: number; error: string }> {
    const row = await loadImport(db, site.id);
    if (!row || row.status !== 'ready' || !row.definition) return { ok: false, status: 404, error: 'There\'s no imported site waiting to be used.' };
    const current = definitionOf(site, maxPages).definition;
    const imported = normaliseSiteDefinition(row.definition, { maxPages });
    const logoAssetId = current.theme.logoUrl || current.theme.logoAssetId ? current.theme.logoAssetId ?? null : imported.definition.theme.logoAssetId ?? null;
    const merged = normaliseSiteDefinition({ ...imported.definition, theme: { ...current.theme, logoAssetId } }, { maxPages });
    const checked = await verifySiteAssets(db, site.organisationId, merged.definition);
    const [saved] = await db.update(sites).set({ draft: checked.definition, updatedAt: new Date() }).where(eq(sites.id, site.id)).returning();
    await db.delete(siteImports).where(eq(siteImports.siteId, site.id));
    return { ok: true, site: saved, warnings: [...new Set([...merged.warnings, ...checked.warnings])] };
}

/** "Discard": the imported draft goes; copied pictures stay in their library. */
export async function discardImport(db: Db, siteId: number): Promise<boolean> {
    const gone = await db.delete(siteImports).where(and(eq(siteImports.siteId, siteId), sql`${siteImports.status} <> 'reading'`)).returning({ id: siteImports.id });
    return gone.length > 0;
}

/** The imported definition, for the signed-in preview (site-preview.ts ?import=1). */
export async function importedDefinition(db: Db, siteId: number, maxPages: number): Promise<SiteDefinition | null> {
    const row = await loadImport(db, siteId);
    return row?.status === 'ready' && row.definition ? normaliseSiteDefinition(row.definition, { maxPages }).definition : null;
}

/** The import, as one line of the chat's site snapshot (site-store.ts buildSiteSnapshot). */
export function describeImportForChat(imp: ImportView | null, drafting: boolean): string {
    if (!imp) return 'Import of their current site: none. If they have an existing website, offer a site_import_request card.';
    if (imp.status === 'reading' && drafting) return `Import of their current site: reading ${imp.sourceUrl} right now — the imported draft appears on the Website tab in a minute or two.`;
    if (imp.status === 'ready') {
        const r = imp.report;
        return `Import of their current site: an imported DRAFT from ${imp.sourceUrl} is READY for review and has NOT replaced their draft — ${imp.pages.map((p) => `"${p.title}" (${p.path}, ${p.sections} sections)`).join(', ')}; ${r?.wordsRead ?? 0} of their words read; pictures ${imp.pictures === 'copy' ? `copied: ${r?.pictures.copied ?? 0}` : 'left out (their choice)'}; prices found and NOT copied: ${r?.prices.length ?? 0}${r?.prices.length ? ` (${r.prices.slice(0, 5).map((x) => `"${x.slice(0, 80)}"`).join('; ')}) — they belong in Business Information ▸ Products & Services` : ''}; left out as clutter: ${r?.leftOut.length ?? 0}. When they decide, a site_import_decision card ("use" or "discard").`;
    }
    return `Import of their current site: the last attempt (${imp.sourceUrl}) did not make a draft — ${imp.message ?? 'it failed'}`;
}
