// netlify/functions/sites.ts
// The Website Assistant's API — the ONE server path the editor (src/components/assistant-site-editor.js)
// and the chat cards (chat-session.js → site:apply / site:draft) both use. docs/website-assistant-plan.md §5.5.
//
// POST { action, … }
//   get    { assistantId }                    → the draft definition, what the gate changed, the page cap,
//                                               placeholders still to fill, whether an AI draft is running
//   apply  { assistantId, ops: SiteOperation[] } → all or nothing; refused with the reason and which op
//   draft  { assistantId, request? }          → start an AI draft of the whole site (1 task, on success)
//
// Nothing here publishes: a site is a draft until step 3's publish, which is a click on the editor
// only (never a chat card).

import { and, eq, sql } from 'drizzle-orm';
import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { aiAssistants } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { enforcePromptModeration } from '../../src/utils/moderation';
import { WEBSITE_ASSISTANT_ROLE_KEY } from '../../src/constants/roles';
import { SECTION_TYPES, type SiteOperation } from '../../src/utils/site-definition';
import { placeholdersIn } from '../../src/utils/site-draft';
import {
    applySiteOperations, claimDraft, definitionOf, endDraft, loadOrCreateSite, maxPagesFor, DRAFT_TIMEOUT_MS, type SiteRow,
} from '../../src/utils/site-store';
import { triggerSiteDraft } from '../../src/utils/trigger-site-draft';

function json(statusCode: number, body: unknown) {
    return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

const MAX_OPS = 25;
const OP_NAMES = ['add_page', 'update_page', 'remove_page', 'add_section', 'update_section', 'remove_section', 'move_section', 'set_nav', 'set_theme', 'set_settings', 'set_footer'];

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { organisationId: orgId, userId } = ctx;

    let body: Record<string, unknown>;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
    const action = String(body.action || '');

    // IDOR + role guard: only THIS organisation's Website Assistant.
    const id = Number(body.assistantId);
    if (!Number.isInteger(id) || id <= 0) return json(400, { error: 'assistantId required.' });
    const [assistant] = await db.select({ id: aiAssistants.id }).from(aiAssistants).where(and(
        eq(aiAssistants.id, id), eq(aiAssistants.organisationId, orgId),
        sql`(${aiAssistants.configuration} ->> 'type') = ${WEBSITE_ASSISTANT_ROLE_KEY}`,
    )).limit(1);
    if (!assistant) return json(404, { error: 'Assistant not found.' });

    const maxPages = await maxPagesFor(db, orgId);
    let site = await loadOrCreateSite(db, { orgId, assistantId: assistant.id, userId });

    const view = (s: SiteRow, extraWarnings: string[] = []) => {
        const { definition, warnings } = definitionOf(s, maxPages);
        const drafting = !!s.draftingAt && Date.now() - new Date(s.draftingAt).getTime() < DRAFT_TIMEOUT_MS;
        return {
            site: { id: s.id, status: s.status, credit: s.credit, drafting, draftNote: s.draftNote, updatedAt: s.updatedAt },
            definition, warnings: [...new Set([...warnings, ...extraWarnings])], maxPages,
            placeholders: placeholdersIn(definition),
            vocab: { sectionTypes: SECTION_TYPES },
        };
    };

    if (action === 'get') return json(200, view(site));

    if (action === 'apply') {
        const ops = Array.isArray(body.ops) ? body.ops : [];
        if (!ops.length) return json(400, { error: 'Nothing to change.' });
        if (ops.length > MAX_OPS) return json(400, { error: `Up to ${MAX_OPS} changes at a time.` });
        if (ops.some((o) => !o || typeof o !== 'object' || !OP_NAMES.includes(String((o as { op?: unknown }).op)))) return json(400, { error: 'Unknown change.' });
        const r = await applySiteOperations(db, site, ops as SiteOperation[], maxPages);
        if (!r.ok) return json(400, { error: r.error, index: r.index });
        return json(200, view(r.site, r.warnings));
    }

    if (action === 'draft') {
        const request = typeof body.request === 'string' ? body.request.trim().slice(0, 2000) : '';
        if (request) {
            const blocked = await enforcePromptModeration({ text: request, userId, organisationId: orgId, source: 'sites' });
            if (blocked) return blocked;
        }
        if (!(await claimDraft(db, site.id))) return json(409, { error: 'Your site is already being drafted — it will appear here in a minute or two.' });
        if (!(await triggerSiteDraft(site.id, request || null))) {
            await endDraft(db, site.id, 'The draft couldn\'t be started. Nothing was charged — try again.');
            return json(503, { error: 'The draft couldn\'t be started. Nothing was charged — try again.' });
        }
        site = (await loadOrCreateSite(db, { orgId, assistantId: assistant.id, userId }));
        return json(202, view(site));
    }

    return json(400, { error: 'Unknown action.' });
});
