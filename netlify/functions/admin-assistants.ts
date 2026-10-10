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
import { parseModelJson } from '../../src/utils/model-json';

const strList = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x ?? '').trim()).filter(Boolean) : []);

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
