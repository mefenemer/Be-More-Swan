// admin-task-costs.ts — Admin → Money → Task costs. What each piece of work costs, set by a super admin.
//
//   GET  ?resource=state                     → every cost today, the change in the works, past changes
//   POST ?resource=save    { items, effectiveDate, reason } → create or replace the draft
//   POST ?resource=discard { id }            → delete a draft (it has affected nothing)
//   POST ?resource=test    { id }            → the draft's notice to YOU only (in-app + email)
//   POST ?resource=announce { id, expected } → locks the change and broadcasts it
//   POST ?resource=resend  { id, expected }  → sends to anyone who has not got it yet
//   POST ?resource=cancel  { id }            → withdraws an announced change before its date, and tells them
//   POST ?resource=set_unused { key, value } → a cost nobody is charged yet: saved now, nothing to announce
//
// `expected` must equal the waiting count the admin was shown, like Comms → Broadcast. Rules for what a
// change must satisfy are in src/utils/task-cost-changes.ts.
//
// Auth mirrors admin-broadcast.ts: aura_session → JWT → 'manage_task_costs' (super_admin), never during
// impersonation, live database only.

import jwt from 'jsonwebtoken';
import { eq, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users } from '../../db/schema';
import { requirePermission, hasPermission } from '../../src/utils/rbac';
import { insertAdminAuditLog, getAdminIp } from '../../src/utils/admin-audit';
import { createNotification } from '../../src/utils/notify';
import { renderTemplate, sendTemplatedEmail } from '../../src/utils/email';
import { getNotificationDefault } from '../../src/utils/notification-templates-catalog';
import { resolveEnvironment } from '../../src/utils/env-context';
import { resolveBaseUrl } from '../../src/utils/base-url';
import { renderMergeVars } from '../../src/utils/email-template';
import { alreadySentCount, emailsGoToCustomers, pendingRecipients } from '../../src/utils/broadcast';
import { clearTaskCostCache, getTaskCosts } from '../../src/utils/task-costs';
import {
    COST_KEYS, COST_KEY_LABELS, MAX_COST, costValue, formatCost, isCostKey, minCost,
} from '../../src/config/task-weights';
import {
    MIN_NOTICE_DAYS_FOR_RISE, acceptanceStats, checkCostValue, costInUse, earliestStart, listChanges, noticeContext, noticeKey, openChange,
    readChange, validateChange, type ChangeRow,
} from '../../src/utils/task-cost-changes';
import { withLambda } from '@netlify/aws-lambda-compat';

const jwtSecret = process.env.JWT_SECRET;
const json = (statusCode: number, body: unknown) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const isMissingTable = (err: unknown) => /task_cost_(changes|change_items)/.test(String((err as any)?.message ?? '')) && /does not exist/.test(String((err as any)?.message ?? ''));

export default withLambda(async (event) => {
    if (!jwtSecret) return json(500, { error: 'Server misconfigured.' });

    const cookieMatch = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!cookieMatch) return json(401, { error: 'Not authenticated.' });
    let adminId: number;
    try {
        const tok = jwt.verify(cookieMatch[1], jwtSecret) as any;
        if (tok.scope === 'impersonate') return json(403, { error: 'Action blocked during impersonation session.' });
        adminId = tok.userId;
    } catch {
        return json(401, { error: 'Invalid session.' });
    }
    const db = getDb();
    const [admin] = await db.select({ role: users.role, email: users.email, firstName: users.firstName }).from(users).where(eq(users.id, adminId)).limit(1);
    if (!admin) return json(401, { error: 'Account not found.' });
    const denied = requirePermission(admin.role, 'manage_task_costs');
    if (denied) return json(denied.statusCode, JSON.parse(denied.body));
    if (resolveEnvironment(event.headers, { allowSandbox: hasPermission(admin.role, 'sandbox_access') }) !== 'live') {
        return json(400, { error: 'Turn the Sandbox toggle off. Task costs are set on the live workspace list.' });
    }

    const resource = event.queryStringParameters?.resource;
    const baseUrl = resolveBaseUrl(event.headers) || 'https://bemoreswan.com';
    const audit = (action: 'task_cost_draft_saved' | 'task_cost_draft_discarded' | 'task_cost_test' | 'task_cost_announced' | 'task_cost_resent' | 'task_cost_cancelled' | 'task_cost_set_unused', targetId: string, newState: Record<string, unknown>) =>
        insertAdminAuditLog({
            adminId, action, targetType: 'task_cost', targetId, newState,
            ipAddress: getAdminIp(event.headers as Record<string, string | undefined>), userAgent: event.headers['user-agent'],
        });

    /** The notice as customers will see it, so nobody announces copy they have not read. */
    const preview = async (change: ChangeRow) => {
        const context = { ...noticeContext(change, baseUrl), user: { first_name: admin.firstName || 'there' } };
        const tpl = getNotificationDefault('task_cost_change');
        const email = await renderTemplate('task_cost_change', context);
        return {
            inApp: tpl ? { title: renderMergeVars(tpl.title, context, false), message: renderMergeVars(tpl.message, context, false) } : null,
            email: email ? { subject: email.subject, html: email.html } : null,
        };
    };

    /** Hands a send to the background worker. Returns an error message, or null. */
    const startSend = async (changeId: number, notice: 'announced' | 'cancelled'): Promise<string | null> => {
        const secret = process.env.CRON_TRIGGER_SECRET;
        if (!secret) return 'CRON_TRIGGER_SECRET is not set on this site.';
        try {
            const res = await fetch(`${baseUrl}/.netlify/functions/admin-broadcast-background`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
                body: JSON.stringify({ taskCostChangeId: changeId, notice, adminId }),
                signal: AbortSignal.timeout(8_000),
            });
            return res.status === 202 || res.ok ? null : `The sender refused to start (HTTP ${res.status}).`;
        } catch (err) {
            return `The sender could not be reached: ${err instanceof Error ? err.message : String(err)}`;
        }
    };

    try {
        if (event.httpMethod === 'GET' && resource === 'state') {
            const now = new Date();
            const costs = await getTaskCosts(now);
            const open = await openChange(db);
            const changes = await listChanges(db);
            const decorated = await Promise.all(changes.map(async (c) => {
                if (c.status === 'draft') return { ...c, waiting: (await pendingRecipients(db, noticeKey(c.id))).length, ...(await preview(c)) };
                if (c.status !== 'announced') return c;
                return {
                    ...c,
                    waiting: (await pendingRecipients(db, noticeKey(c.id))).length,
                    sent: await alreadySentCount(db, noticeKey(c.id)),
                    inForce: c.effectiveDate <= now.toISOString().slice(0, 10),
                    acceptance: await acceptanceStats(db, c),
                };
            }));
            return json(200, {
                costs: COST_KEYS.map((key) => ({
                    key, label: COST_KEY_LABELS[key], value: costValue(costs, key), text: formatCost(key, costValue(costs, key)),
                    min: minCost(key), max: MAX_COST, inUse: costInUse(key, now),
                })),
                openChangeId: open?.id ?? null,
                changes: decorated,
                earliest: { rise: earliestStart(true, now), reduction: earliestStart(false, now) },
                minNoticeDays: MIN_NOTICE_DAYS_FOR_RISE,
                emailsGoToCustomers: emailsGoToCustomers(),
                you: admin.email,
            });
        }

        if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });
        let body: Record<string, any>;
        try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON body.' }); }

        if (resource === 'save') {
            const costs = await getTaskCosts();
            const checked = validateChange(body, costs);
            if (!checked.ok) return json(400, { error: checked.error });
            const open = await openChange(db);
            if (open?.status === 'announced') return json(409, { error: `A change is already announced for ${open.effectiveDate}. Wait for it to start, or cancel it, before starting another.` });
            const row = await db.transaction(async (tx) => {
                if (open) await tx.execute(sql`DELETE FROM task_cost_changes WHERE id = ${open.id} AND status = 'draft'`);
                const made = await tx.execute<{ id: number }>(sql`
                    INSERT INTO task_cost_changes (status, effective_from, reason, created_by)
                    VALUES ('draft', ${`${checked.effectiveDate} 00:00:00`}::timestamp, ${checked.reason}, ${adminId}) RETURNING id`);
                const id = Number((made as unknown as Array<{ id: number }>)[0].id);
                for (const i of checked.items) {
                    await tx.execute(sql`INSERT INTO task_cost_change_items (change_id, cost_key, old_units, new_units) VALUES (${id}, ${i.key}, ${i.oldUnits}, ${i.newUnits})`);
                }
                return id;
            });
            await audit('task_cost_draft_saved', String(row), { items: checked.items, effectiveDate: checked.effectiveDate, reason: checked.reason });
            return json(200, { id: row });
        }

        if (resource === 'set_unused') {
            const key = body.key;
            if (!isCostKey(key)) return json(400, { error: 'Unknown cost.' });
            if (costInUse(key)) return json(400, { error: 'Customers are charged this cost, so a change needs a notice.' });
            const bad = checkCostValue(key, body.value);
            if (bad) return json(400, { error: bad });
            const oldUnits = costValue(await getTaskCosts(), key);
            if (oldUnits === body.value) return json(200, { unchanged: true });
            const id = await db.transaction(async (tx) => {
                const made = await tx.execute<{ id: number }>(sql`
                    INSERT INTO task_cost_changes (status, effective_from, reason, created_by)
                    VALUES ('baseline', (now() AT TIME ZONE 'UTC'), 'Set before anyone is charged for this.', ${adminId}) RETURNING id`);
                const newId = Number((made as unknown as Array<{ id: number }>)[0].id);
                await tx.execute(sql`INSERT INTO task_cost_change_items (change_id, cost_key, old_units, new_units) VALUES (${newId}, ${key}, ${oldUnits}, ${body.value})`);
                return newId;
            });
            clearTaskCostCache();
            await audit('task_cost_set_unused', String(id), { key, from: oldUnits, to: body.value });
            return json(200, { id });
        }

        const id = Number(body.id);
        if (!Number.isInteger(id)) return json(400, { error: 'Which change?' });
        const change = await readChange(db, id);
        if (!change) return json(404, { error: 'That change no longer exists.' });

        if (resource === 'discard') {
            if (change.status !== 'draft') return json(409, { error: 'Only a draft can be discarded.' });
            await db.execute(sql`DELETE FROM task_cost_changes WHERE id = ${id} AND status = 'draft'`);
            await audit('task_cost_draft_discarded', String(id), {});
            return json(200, { ok: true });
        }

        if (resource === 'test') {
            if (change.status !== 'draft') return json(409, { error: 'Only a draft can be tested.' });
            // Its own type, so testing a draft doesn't count as having the real notice, which may differ.
            const context = noticeContext(change, baseUrl);
            const inApp = await createNotification(db, 'task_cost_change', { userId: adminId, typeOverride: 'task_cost_change_test', context, metadata: { taskCostChangeId: id, test: true } });
            let emailed = false;
            try { emailed = !!(await sendTemplatedEmail({ triggerKey: 'task_cost_change', to: admin.email, vars: { ...context, user: { first_name: admin.firstName || 'there' } } })); }
            catch (err) { console.error('[admin-task-costs] test email failed:', err); }
            await audit('task_cost_test', String(id), { inApp, emailed, to: admin.email });
            return json(200, { inApp, emailed, to: admin.email });
        }

        if (resource === 'announce') {
            if (change.status !== 'draft') return json(409, { error: 'This change has already been announced.' });
            const waiting = (await pendingRecipients(db, noticeKey(id))).length;
            if (body.expected !== waiting) return json(409, { error: `The number of customers has changed to ${waiting}. Check it again before announcing.`, waiting });
            // Checked again here: days have passed, or a cost moved, since the draft was saved.
            const costs = await getTaskCosts();
            const items = Object.fromEntries(change.items.map((i) => [i.key, i.newUnits]));
            const checked = validateChange({ items, effectiveDate: change.effectiveDate, reason: change.reason }, costs);
            if (!checked.ok) return json(400, { error: checked.error });
            const flipped = await db.transaction(async (tx) => {
                const rows = await tx.execute(sql`
                    UPDATE task_cost_changes SET status = 'announced', announced_at = (now() AT TIME ZONE 'UTC'), announced_by = ${adminId}, updated_at = now()
                     WHERE id = ${id} AND status = 'draft' RETURNING id`);
                if (!(rows as unknown as unknown[]).length) return false;
                for (const i of checked.items) {
                    await tx.execute(sql`UPDATE task_cost_change_items SET old_units = ${i.oldUnits} WHERE change_id = ${id} AND cost_key = ${i.key}`);
                }
                return true;
            });
            if (!flipped) return json(409, { error: 'This change has already been announced.' });
            clearTaskCostCache();
            const failed = await startSend(id, 'announced');
            if (failed) {
                // No notice went out, so it must not start on its date either. Back to a draft to try again.
                await db.execute(sql`UPDATE task_cost_changes SET status = 'draft', announced_at = NULL, announced_by = NULL, updated_at = now() WHERE id = ${id}`);
                clearTaskCostCache();
                return json(502, { error: `${failed} Nothing was announced, and the change is still a draft.` });
            }
            await audit('task_cost_announced', String(id), { items: checked.items, effectiveDate: change.effectiveDate, waiting, emailsGoToCustomers: emailsGoToCustomers() });
            return json(202, { started: true, waiting, emailsGoToCustomers: emailsGoToCustomers() });
        }

        if (resource === 'resend') {
            if (change.status !== 'announced') return json(409, { error: 'Only an announced change can be sent again.' });
            const waiting = (await pendingRecipients(db, noticeKey(id))).length;
            if (body.expected !== waiting) return json(409, { error: `The number waiting has changed to ${waiting}. Check it again before sending.`, waiting });
            if (waiting === 0) return json(400, { error: 'Everyone already has this notice.' });
            const failed = await startSend(id, 'announced');
            if (failed) return json(502, { error: failed });
            await audit('task_cost_resent', String(id), { waiting });
            return json(202, { started: true, waiting, emailsGoToCustomers: emailsGoToCustomers() });
        }

        if (resource === 'cancel') {
            if (change.status !== 'announced') return json(409, { error: 'Only an announced change can be cancelled.' });
            const cancelled = await db.execute(sql`
                UPDATE task_cost_changes SET status = 'cancelled', cancelled_at = (now() AT TIME ZONE 'UTC'), cancelled_by = ${adminId}, updated_at = now()
                 WHERE id = ${id} AND status = 'announced' AND effective_from > (now() AT TIME ZONE 'UTC') RETURNING id`);
            if (!(cancelled as unknown as unknown[]).length) return json(409, { error: 'This change has already started, so it can\'t be cancelled. Set the old cost again as a new change.' });
            clearTaskCostCache();
            await audit('task_cost_cancelled', String(id), { effectiveDate: change.effectiveDate });
            const failed = await startSend(id, 'cancelled');
            return json(200, { cancelled: true, noticeError: failed });
        }

        return json(400, { error: 'Unknown resource.' });
    } catch (err) {
        if (isMissingTable(err)) return json(503, { error: 'The task costs tables are not on this database yet. Apply db/z-task-costs.sql.' });
        console.error('[admin-task-costs]', err);
        return json(500, { error: 'That didn\'t work. Nothing was announced.' });
    }
});
