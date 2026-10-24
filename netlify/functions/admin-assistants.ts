// netlify/functions/admin-assistants.ts
// Admin ▸ Assistants — the one place an assistant role is looked after and put live.
//
// GET                       → { assistants: [...] }  every role: status, counts, and how many checks fail
// GET  ?id=N                → { assistant, status, checks, blockers: { coming_soon, beta, live } }
// POST ?id=N&action=status  → { status, reason? }    the ONLY way a role's status changes
// POST ?id=N&action=suggest → { key }               a Fix or a drafted Suggestion for one failing check
// POST ?id=N&action=apply   → { key, value }        write an approved fix (validated by go-live-fixes.ts)
//
// Status replaces three stored switches (is_active, coming_soon, lifecycle_state) — see
// src/utils/assistant-go-live.ts. A move to Coming soon, Beta or Live is refused while a blocking
// check fails, and a role's first move to Live announces it (src/utils/role-launch-notify.ts).
// Details are still saved through master-data-api (?resource=master-assistants), which no longer
// accepts status fields.
//
// Admin only (`assistant_catalog`).

import jwt from 'jsonwebtoken';
import { and, count, desc, eq, ne } from 'drizzle-orm';
import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { aiAssistants, assistantFeatures, assistantVersions, masterAssistants, users, waitlist } from '../../db/schema';
import { hasPermission } from '../../src/utils/rbac';
import { insertAdminAuditLog, getAdminIp } from '../../src/utils/admin-audit';
import {
    ASSISTANT_STATUSES, STATUS_LABELS, announcesLaunch, blockersFor, columnsFor, runGoLiveChecks, statusOf,
    type AssistantStatus,
} from '../../src/utils/assistant-go-live';
import { announceRoleLaunch } from '../../src/utils/role-launch-notify';
import {
    REMEDIES, applyFix, deterministicFix, specialCategoryProposal, suggestionBrief, type Proposal,
} from '../../src/utils/go-live-fixes';
import { gatewayGenerate } from '../../src/lib/ai-gateway';
import { parseModelJson } from '../../src/utils/model-json';import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { normaliseShowcase, SHOWCASE_MEDIA_PREFIX, showcaseMediaUrl } from '../../src/utils/assistant-showcase';
import { putR2Object } from '../../src/lib/media-persist';
import { MODEL_OPTIONS, THINKING_LEVELS, effectiveThinking, estimateCallUsd, modelOption, type ThinkingLevel } from '../../src/config/model-options';
import { CHAT_DEFAULT_MODEL, ROLE_MODEL_PATHS, promptLayersFor } from '../../src/config/assistant-prompt-layers';
import { clearRoleModelCache } from '../../src/utils/assistant-model';


const pgCode = (err: unknown) => (err as { code?: string; cause?: { code?: string } })?.code
    ?? (err as { cause?: { code?: string } })?.cause?.code;

const strList = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x ?? '').trim()).filter(Boolean) : []);

// ── Model & rules (src/config/model-options.ts, src/utils/assistant-model.ts) ───────────────────
type Db = ReturnType<typeof getDb>;
type ModelRow = { role_key: string; model: string; thinking: string; updated_at: string };

/** Every role's saved model choice. needsSetup when db/assistant-model-settings.sql isn't applied. */
async function loadModelChoices(db: Db): Promise<{ rows: ModelRow[]; needsSetup: boolean }> {
    try {
        return { rows: [...await db.execute<ModelRow>(sql`SELECT role_key, model, thinking, updated_at::text FROM assistant_model_settings`)], needsSetup: false };
    } catch (err) {
        if (pgCode(err) === '42P01') return { rows: [], needsSetup: true };
        throw err;
    }
}

/** Claude spend over the last 30 days, by role and model, from the usage ledger (ai_usage_log). */
async function usageByRole(db: Db, roleKey?: string) {
    return [...await db.execute<{ role_key: string; model: string; calls: number; avg_in: number; avg_out: number; usd: string }>(sql`
        SELECT m.role_key, l.model, count(*)::int AS calls,
               round(avg(l.input_tokens))::int AS avg_in, round(avg(l.output_tokens))::int AS avg_out,
               coalesce(sum(l.cost_usd::numeric), 0)::text AS usd
        FROM ai_usage_log l
        JOIN ai_assistants a ON a.id = l.assistant_id
        JOIN master_assistants m ON m.id = a.master_assistant_id
        WHERE l.created_at > now() - interval '30 days' AND l.model LIKE 'claude%'
          ${roleKey ? sql`AND m.role_key = ${roleKey}` : sql``}
        GROUP BY 1, 2 ORDER BY 1, 6 DESC`)];
}

const json = (statusCode: number, body: unknown) => ({
    statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body),
});

async function requireAdmin(event: any): Promise<number | null> {
    const secret = process.env.JWT_SECRET;
    if (!secret) return null;
    const m = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!m) return null;
    let userId: number;
    try { userId = (jwt.verify(m[1], secret) as { userId: number }).userId; } catch { return null; }
    const [row] = await getDb().select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
    return row && hasPermission(row.role, 'assistant_catalog') ? userId : null;
}

type MasterRow = typeof masterAssistants.$inferSelect;

async function checksFor(db: ReturnType<typeof getDb>, row: MasterRow, knownRoleKeys: string[]) {
    const [{ n }] = await db.select({ n: count() }).from(assistantFeatures).where(eq(assistantFeatures.masterAssistantId, row.id));
    return runGoLiveChecks({ ...row, video: row.video as { url?: string | null } | null, knownRoleKeys, capabilityRowCount: Number(n) });
}

export default withLambda(async (event) => {
    const adminId = await requireAdmin(event);
    if (!adminId) return json(401, { error: 'Unauthorised' });
    const db = getDb();
    const q = event.queryStringParameters || {};
    const id = q.id ? Number(q.id) : null;

    try {
        if (event.httpMethod === 'GET' && !id) {
            const rows = await db.select().from(masterAssistants).orderBy(masterAssistants.name);
            const knownRoleKeys = rows.map((r) => r.roleKey);
            const [wl, hired, caps] = await Promise.all([
                db.select({ id: waitlist.masterAssistantId, n: count() }).from(waitlist).groupBy(waitlist.masterAssistantId),
                db.select({ id: aiAssistants.masterAssistantId, n: count() }).from(aiAssistants)
                    .where(ne(aiAssistants.lifecycleStatus, 'archived')).groupBy(aiAssistants.masterAssistantId),
                db.select({ id: assistantFeatures.masterAssistantId, n: count() }).from(assistantFeatures).groupBy(assistantFeatures.masterAssistantId),
            ]);
            const [{ rows: choices }, usage] = await Promise.all([loadModelChoices(db), usageByRole(db)]);
            const choiceBy = new Map(choices.map((c) => [c.role_key, c]));
            const costBy = new Map<string, number>();
            for (const u of usage) costBy.set(u.role_key, (costBy.get(u.role_key) ?? 0) + Number(u.usd));
            const by = (list: { id: number | null; n: number }[]) => new Map(list.map((r) => [r.id, Number(r.n)]));
            const wlBy = by(wl), hiredBy = by(hired), capsBy = by(caps);
            const assistants = rows.map((r) => {
                const checks = runGoLiveChecks({ ...r, video: r.video as { url?: string | null } | null, knownRoleKeys, capabilityRowCount: capsBy.get(r.id) ?? 0 });
                return {
                    id: r.id, roleKey: r.roleKey, name: r.name, category: r.category, iconKey: r.iconKey, iconColor: r.iconColor,
                    status: statusOf(r), waitlistCount: wlBy.get(r.id) ?? 0, hiredCount: hiredBy.get(r.id) ?? 0,
                    liveBlockers: blockersFor('live', checks).length,
                    warnings: checks.filter((c) => !c.ok && c.severity === 'warning').length,
                    built: checks.filter((c) => c.group === 'built').every((c) => c.ok),
                    // null = the models written in the code (Model & rules tab lists them).
                    model: choiceBy.has(r.roleKey) ? modelOption(choiceBy.get(r.roleKey)!.model)?.label ?? null : null,
                    cost30dUsd: Math.round((costBy.get(r.roleKey) ?? 0) * 100) / 100,
                };
            });
            return json(200, { assistants, statuses: ASSISTANT_STATUSES.map((s) => ({ key: s, label: STATUS_LABELS[s] })) });
        }

        if (!id || !Number.isInteger(id)) return json(400, { error: 'id is required.' });
        const [row] = await db.select().from(masterAssistants).where(eq(masterAssistants.id, id)).limit(1);
        if (!row) return json(404, { error: 'Assistant not found.' });
        const knownRoleKeys = (await db.select({ k: masterAssistants.roleKey }).from(masterAssistants)).map((r) => r.k);
        const checks = await checksFor(db, row, knownRoleKeys);
        const status = statusOf(row);

        // ── Website page (assistant.html) — src/utils/assistant-showcase.ts ──────────────────────
        // Its own table, not a master_assistants column: see db/z-assistant-showcases.sql.
        if (event.httpMethod === 'GET' && q.showcase === '1') {
            try {
                const rows = await db.execute<{ content: unknown; updated_at: string }>(
                    sql`SELECT content, updated_at FROM assistant_showcases WHERE role_key = ${row.roleKey} LIMIT 1`);
                const r0 = (rows as unknown as Array<{ content: unknown; updated_at: string }>)[0];
                return json(200, { roleKey: row.roleKey, showcase: r0?.content ?? null, updatedAt: r0?.updated_at ?? null });
            } catch (err) {
                if (pgCode(err) === '42P01') return json(200, { roleKey: row.roleKey, showcase: null, needsSetup: true });
                throw err;
            }
        }

        if (event.httpMethod === 'POST' && q.action === 'showcase') {
            let body: { showcase?: unknown } = {};
            try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }
            const res = normaliseShowcase(body.showcase);
            if (!res.ok) return json(400, { error: res.error });
            try {
                await db.execute(sql`
                    INSERT INTO assistant_showcases (role_key, content, updated_at)
                    VALUES (${row.roleKey}, ${JSON.stringify(res.showcase)}::jsonb, now())
                    ON CONFLICT (role_key) DO UPDATE SET content = EXCLUDED.content, updated_at = now()`);
            } catch (err) {
                if (pgCode(err) === '42P01') return json(409, { error: 'The website page table is not set up here yet — apply db/z-assistant-showcases.sql first.' });
                throw err;
            }
            await insertAdminAuditLog({
                adminId, action: 'assistant_showcase_update', targetType: 'master_assistant', targetId: id,
                previousState: {}, newState: { roleKey: row.roleKey, features: res.showcase.features.length, faqs: res.showcase.faqs.length },
                reason: 'Website page edited', ipAddress: getAdminIp(event.headers as Record<string, string | undefined>),
                userAgent: event.headers['user-agent'], metadata: { assistantName: row.name, roleKey: row.roleKey },
            });
            return json(200, { showcase: res.showcase });
        }

        // A screenshot for the website page. Stored in R2 under showcase/<roleKey>/ and served by
        // showcase-media.ts. Sent as base64 in JSON: images are small and this keeps it one request.
        if (event.httpMethod === 'POST' && q.action === 'upload-image') {
            let body: { contentType?: unknown; dataBase64?: unknown } = {};
            try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }
            const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
            const ext = EXT[String(body.contentType || '')];
            if (!ext) return json(400, { error: 'Upload a PNG, JPG or WebP image.' });
            const bytes = Buffer.from(String(body.dataBase64 || ''), 'base64');
            if (!bytes.length) return json(400, { error: 'The image was empty.' });
            if (bytes.length > 4 * 1024 * 1024) return json(413, { error: 'Images must be under 4 MB.' });
            const key = `${SHOWCASE_MEDIA_PREFIX}${row.roleKey}/${Date.now().toString(36)}-${randomUUID().slice(0, 8)}.${ext}`;
            await putR2Object({ key, bytes, contentType: String(body.contentType) });
            return json(200, { url: showcaseMediaUrl(key) });
        }

        if (event.httpMethod === 'GET' && q.config === '1') {
            const [{ rows, needsSetup }, usage] = await Promise.all([loadModelChoices(db), usageByRole(db, row.roleKey)]);
            const saved = rows.find((r) => r.role_key === row.roleKey) ?? null;
            const choice = saved && modelOption(saved.model)
                ? { model: saved.model, thinking: effectiveThinking(saved.model, saved.thinking as ThinkingLevel), updatedAt: saved.updated_at } : null;
            // What each option WOULD have cost for the same 30 days of calls: the real token counts,
            // re-priced (estimateCallUsd allows for the newer tokenizer and for thinking).
            const thinkingFor = (m: string) => effectiveThinking(m, choice?.thinking ?? 'low');
            const estimates = MODEL_OPTIONS.map((o) => ({
                model: o.id,
                usd30d: Math.round(usage.reduce((sum, u) => sum + u.calls * (estimateCallUsd(u.model, o.id, u.avg_in, u.avg_out, thinkingFor(o.id)) ?? 0), 0) * 100) / 100,
            }));
            return json(200, {
                roleKey: row.roleKey, needsSetup, choice,
                options: MODEL_OPTIONS, thinkingLevels: THINKING_LEVELS,
                paths: [...(ROLE_MODEL_PATHS[row.roleKey] ?? []), { label: 'Chat', defaultModel: CHAT_DEFAULT_MODEL }],
                usage: usage.map((u) => ({ model: u.model, label: modelOption(u.model)?.label ?? u.model, calls: u.calls, avgIn: u.avg_in, avgOut: u.avg_out, usd: Math.round(Number(u.usd) * 100) / 100 })),
                estimates,
                layers: promptLayersFor(row.roleKey),
            });
        }

        // The role's model. { model: null } goes back to the models written in the code.
        if (event.httpMethod === 'POST' && q.action === 'model') {
            let body: { model?: unknown; thinking?: unknown } = {};
            try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }
            const model = body.model == null || body.model === '' ? null : String(body.model);
            if (model && !modelOption(model)) return json(400, { error: 'Choose one of the models offered.' });
            const thinking = model ? effectiveThinking(model, body.thinking as ThinkingLevel) : null;
            const { rows, needsSetup } = await loadModelChoices(db);
            if (needsSetup) return json(409, { error: 'The model setting is not set up here yet — apply db/assistant-model-settings.sql first.' });
            const before = rows.find((r) => r.role_key === row.roleKey) ?? null;
            if (model) {
                await db.execute(sql`
                    INSERT INTO assistant_model_settings (role_key, model, thinking, updated_by, updated_at)
                    VALUES (${row.roleKey}, ${model}, ${thinking}, ${adminId}, now())
                    ON CONFLICT (role_key) DO UPDATE SET model = EXCLUDED.model, thinking = EXCLUDED.thinking,
                        updated_by = EXCLUDED.updated_by, updated_at = now()`);
            } else {
                await db.execute(sql`DELETE FROM assistant_model_settings WHERE role_key = ${row.roleKey}`);
            }
            clearRoleModelCache(row.roleKey);
            await insertAdminAuditLog({
                adminId, action: 'assistant_model_change', targetType: 'master_assistant', targetId: id,
                previousState: before ? { model: before.model, thinking: before.thinking } : { model: 'code default' },
                newState: model ? { model, thinking } : { model: 'code default' },
                reason: model ? `model → ${model} (${thinking})` : 'model → code default',
                ipAddress: getAdminIp(event.headers as Record<string, string | undefined>), userAgent: event.headers['user-agent'],
                metadata: { assistantName: row.name, roleKey: row.roleKey },
            });
            return json(200, { choice: model ? { model, thinking } : null });
        }

        if (event.httpMethod === 'GET') {
            const [[wl], [hired]] = await Promise.all([
                db.select({ n: count() }).from(waitlist).where(eq(waitlist.masterAssistantId, id)),
                db.select({ n: count() }).from(aiAssistants).where(and(eq(aiAssistants.masterAssistantId, id), ne(aiAssistants.lifecycleStatus, 'archived'))),
            ]);
            return json(200, {
                assistant: row, status,
                checks: checks.map((c) => ({ ...c, remedy: REMEDIES[c.key] ?? { remedy: 'developer' } })),
                waitlistCount: Number(wl?.n ?? 0), hiredCount: Number(hired?.n ?? 0),
                blockers: { coming_soon: blockersFor('coming_soon', checks), beta: blockersFor('beta', checks), live: blockersFor('live', checks) },
            });
        }

        if (event.httpMethod === 'POST' && q.action === 'status') {
            let body: { status?: unknown; reason?: unknown } = {};
            try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }
            const next = body.status as AssistantStatus;
            if (!ASSISTANT_STATUSES.includes(next)) return json(400, { error: `status must be one of ${ASSISTANT_STATUSES.join(', ')}` });
            if (next === status) return json(200, { status, unchanged: true });
            const blockers = blockersFor(next, checks);
            if (blockers.length) {
                return json(409, { error: `${STATUS_LABELS[next]} needs ${blockers.length} more check${blockers.length === 1 ? '' : 's'} to pass.`, blockers });
            }
            const cols = columnsFor(next);
            const [updated] = await db.update(masterAssistants).set({ ...cols, updatedAt: new Date() })
                .where(eq(masterAssistants.id, id)).returning();
            await insertAdminAuditLog({
                adminId, action: 'assistant_state_change', targetType: 'master_assistant', targetId: id,
                previousState: { status, isActive: row.isActive, comingSoon: row.comingSoon, lifecycleState: row.lifecycleState },
                newState: { status: next, ...cols },
                reason: typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 500) : `status → ${next}`,
                ipAddress: getAdminIp(event.headers as Record<string, string | undefined>), userAgent: event.headers['user-agent'],
                metadata: { assistantName: row.name, roleKey: row.roleKey },
            });
            const notifiedCount = announcesLaunch(status, next) ? await announceRoleLaunch(db, { id: updated.id, name: updated.name }) : 0;
            return json(200, { status: next, notifiedCount });
        }

        if (event.httpMethod === 'POST' && (q.action === 'suggest' || q.action === 'apply')) {
            let body: { key?: unknown; value?: unknown } = {};
            try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }
            const key = String(body.key ?? '');
            const remedy = REMEDIES[key];
            if (!remedy || remedy.remedy === 'developer' || remedy.remedy === 'goto') return json(400, { error: 'This check cannot be fixed from here.' });
            const [cur] = row.currentVersionId
                ? await db.select({ p: assistantVersions.systemPrompt }).from(assistantVersions).where(eq(assistantVersions.id, row.currentVersionId)).limit(1)
                : [];
            const currentPrompt = cur?.p ?? null;
            const categories = [...new Set((await db.select({ c: masterAssistants.category }).from(masterAssistants)).map((r) => r.c).filter(Boolean))].sort();

            if (q.action === 'suggest') {
                const det = deterministicFix(key, { roleKey: row.roleKey, worksWith: strList(row.worksWith), knownRoleKeys });
                if (det) return json(200, { proposal: det });
                if (key === 'specialCategory') return json(200, { proposal: specialCategoryProposal(currentPrompt) });
                if (key === 'integrations') {
                    return json(409, { error: 'This assistant has no outside connections built yet (it works through your other assistants or platform services), so an empty list is correct for now. It is only a warning and never blocks going live.' });
                }
                const brief = suggestionBrief(key, {
                    name: row.name, roleKey: row.roleKey, category: row.category, tagline: row.tagline, description: row.description,
                    keyFeatures: strList(row.keyFeatures), categories, knownRoleKeys, currentPrompt,
                });
                if (!brief) return json(400, { error: 'No suggestion is available for this check.' });
                const gw = await gatewayGenerate({
                    system: 'You write catalogue copy and configuration for business assistants. You reply with ONLY the JSON object asked for.',
                    messages: [{ role: 'user', content: brief.ask }],
                    maxTokens: key === 'version' ? 1400 : 500,
                });
                const parsed = parseModelJson<{ value?: unknown; why?: unknown }>(gw.text || '');
                let value = parsed?.value;
                if (brief.kind === 'choice' && !(brief.options ?? []).includes(String(value))) value = null;
                if (brief.kind === 'list') value = strList(value);
                if (value == null || (Array.isArray(value) && !value.length) || (typeof value === 'string' && !value.trim())) {
                    return json(502, { error: 'The suggestion came back empty. Try again.' });
                }
                const proposal: Proposal = {
                    key, kind: brief.kind, value, options: brief.options,
                    explanation: typeof parsed?.why === 'string' && parsed.why.trim()
                        ? parsed.why.trim().slice(0, 300)
                        : 'Drafted from this assistant\'s details. Edit it if you like — nothing is saved until you press Apply.',
                };
                return json(200, { proposal });
            }

            // apply
            let write;
            try { write = applyFix(key, body.value, { knownRoleKeys, categories, currentPrompt }); }
            catch (e) { return json(400, { error: (e as Error).message }); }
            if (write.kind === 'columns') {
                await db.update(masterAssistants).set({ ...write.set, updatedAt: new Date() }).where(eq(masterAssistants.id, id));
            } else {
                const [last] = await db.select({ n: assistantVersions.versionNumber }).from(assistantVersions)
                    .where(eq(assistantVersions.assistantId, id)).orderBy(desc(assistantVersions.versionNumber)).limit(1);
                const [version] = await db.insert(assistantVersions).values({
                    assistantId: id, versionNumber: (last?.n ?? 0) + 1, systemPrompt: write.systemPrompt,
                    changeNote: write.changeNote, createdBy: adminId,
                }).returning({ id: assistantVersions.id });
                await db.update(masterAssistants).set({ ...(write.alsoSet ?? {}), currentVersionId: version.id, updatedAt: new Date() })
                    .where(eq(masterAssistants.id, id));
            }
            await insertAdminAuditLog({
                adminId, action: 'assistant_state_change', targetType: 'master_assistant', targetId: id,
                reason: `go-live fix: ${key}`,
                newState: write.kind === 'columns' ? write.set : { newVersion: true, ...(write.alsoSet ?? {}) },
                ipAddress: getAdminIp(event.headers as Record<string, string | undefined>), userAgent: event.headers['user-agent'],
                metadata: { assistantName: row.name, roleKey: row.roleKey },
            });
            return json(200, { ok: true });
        }

        return json(405, { error: 'Method Not Allowed' });
    } catch (err) {
        console.error('[admin-assistants]', err);
        return json(500, { error: 'Something went wrong. Please try again.' });
    }
});
