// netlify/functions/sync-action.ts
// Phase 1 External Integrations: generic action-sync endpoint, exposed as
// POST /api/actions/sync (netlify.toml rewrite).
//
// Body: { actionType: string, payload: object } — payload is the parsed LLM uiElement
// the disruptive-ui card was rendered from (untrusted; validated per handler).
//
// Handlers (one per hero integration):
//   hubspot_update_record  — data_diff_view (crm_enricher / lead_qualifier)
//                            → PATCH the matching HubSpot contact/company properties.
//   xero_log_note          — aging_invoices_table row (accounts_receivable_clerk)
//                            → push a history note onto the matching Xero invoice.
//   slack_post_summary     — action_item_assignment (meeting_note_taker)
//                            → post the summary + tasks as Block Kit via chat.postMessage.
//
// Every path: requireTenant (org-scoped), token via getFreshAccessToken (which silently
// refreshes an expired access token), and integration_api_calls audit rows (SC6 —
// endpoint paths only, no query params or payloads).

import { Handler } from '@netlify/functions';
import { getDb } from '../../db/client';
import { requireTenant } from '../../src/utils/tenant';
import { logApiCall } from '../../src/utils/vault';
import { getFreshAccessToken, IntegrationError } from '../../src/utils/workspace-integrations';

type Db = ReturnType<typeof getDb>;

function json(statusCode: number, body: unknown) {
    return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

// ── HubSpot: update a contact or company from a data_diff_view payload ─────────

interface DiffField { fieldName?: unknown; newValue?: unknown; propertyName?: unknown }
interface DataDiffPayload {
    recordName?: unknown;
    recordEmail?: unknown;
    objectType?: unknown; // 'contact' | 'company'
    fields?: unknown;
}

/** "LinkedIn URL" → "linkedin_url" — best-effort mapping when no propertyName is given. */
function toHubspotProperty(fieldName: string): string {
    return fieldName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

async function handleHubspotUpdate(db: Db, userId: number, organisationId: number, payload: DataDiffPayload) {
    const fields = (Array.isArray(payload.fields) ? payload.fields : [])
        .filter((f): f is DiffField => Boolean(f && typeof f === 'object' && (f as DiffField).fieldName));
    if (fields.length === 0) return json(400, { error: 'No fields to sync.' });

    const recordName = typeof payload.recordName === 'string' ? payload.recordName.trim() : '';
    const recordEmail = typeof payload.recordEmail === 'string' ? payload.recordEmail.trim() : '';
    const isContact = payload.objectType === 'contact' || (!payload.objectType && Boolean(recordEmail));
    const objectPath = isContact ? 'contacts' : 'companies';
    if (!recordEmail && !recordName) return json(400, { error: 'The payload names no record to update.' });

    const { accessToken } = await getFreshAccessToken(db, organisationId, 'hubspot');
    const authHeaders = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };

    // 1. Find the record: contacts by email (exact) or name token; companies by name.
    const filters = isContact && recordEmail
        ? [{ propertyName: 'email', operator: 'EQ', value: recordEmail }]
        : [{ propertyName: 'name', operator: 'EQ', value: recordName }];
    const searchRes = await fetch(`https://api.hubapi.com/crm/v3/objects/${objectPath}/search`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ filterGroups: [{ filters }], limit: 1 }),
    });
    await logApiCall(db, { userId, endpoint: `hubapi.com/crm/v3/objects/${objectPath}/search`, httpStatus: searchRes.status });
    const searchData: { results?: Array<{ id: string }> } = searchRes.ok ? await searchRes.json() : {};
    const recordId = searchData.results?.[0]?.id;
    if (!recordId) {
        return json(404, { error: `No matching HubSpot ${isContact ? 'contact' : 'company'} found for "${recordEmail || recordName}". Check the record exists in HubSpot, then try again.` });
    }

    // 2. Patch the enriched properties onto it.
    const properties: Record<string, string> = {};
    for (const f of fields) {
        const prop = typeof f.propertyName === 'string' && f.propertyName ? f.propertyName : toHubspotProperty(String(f.fieldName));
        if (prop) properties[prop] = String(f.newValue ?? '');
    }
    const patchRes = await fetch(`https://api.hubapi.com/crm/v3/objects/${objectPath}/${recordId}`, {
        method: 'PATCH',
        headers: authHeaders,
        body: JSON.stringify({ properties }),
    });
    await logApiCall(db, { userId, endpoint: `hubapi.com/crm/v3/objects/${objectPath}`, httpStatus: patchRes.status });
    if (!patchRes.ok) {
        const err: { message?: string } = await patchRes.json().catch(() => ({}));
        return json(502, { error: `HubSpot rejected the update${err.message ? `: ${err.message}` : '.'}` });
    }

    return json(200, { success: true, message: `Updated ${Object.keys(properties).length} propert${Object.keys(properties).length === 1 ? 'y' : 'ies'} on HubSpot ${isContact ? 'contact' : 'company'} "${recordEmail || recordName}".` });
}

// ── Xero: log a note against an invoice from an aging_invoices_table row ──────

interface XeroNotePayload {
    invoiceId?: unknown;
    invoiceNumber?: unknown;
    clientName?: unknown;
    daysPastDue?: unknown;
    amount?: unknown;
    status?: unknown;
    note?: unknown;
}

async function handleXeroLogNote(db: Db, userId: number, organisationId: number, payload: XeroNotePayload) {
    const clientName = typeof payload.clientName === 'string' ? payload.clientName.trim() : '';
    const invoiceNumber = typeof payload.invoiceNumber === 'string' ? payload.invoiceNumber.trim() : '';
    let invoiceId = typeof payload.invoiceId === 'string' ? payload.invoiceId.trim() : '';
    if (!invoiceId && !invoiceNumber && !clientName) return json(400, { error: 'The payload identifies no invoice (needs invoiceId, invoiceNumber or clientName).' });

    const { accessToken, tenantId } = await getFreshAccessToken(db, organisationId, 'xero');
    if (!tenantId) return json(409, { error: 'Xero is connected but no tenant is mapped — please reconnect it on the Integrations page.' });
    const xeroHeaders = { Authorization: `Bearer ${accessToken}`, 'Xero-Tenant-Id': tenantId, Accept: 'application/json', 'Content-Type': 'application/json' };

    // 1. Resolve the invoice when the card only knows number/client (LLM payloads rarely carry GUIDs).
    if (!invoiceId) {
        const query = invoiceNumber
            ? `InvoiceNumbers=${encodeURIComponent(invoiceNumber)}`
            : `where=${encodeURIComponent(`Contact.Name=="${clientName.replace(/"/g, '')}" AND Status=="AUTHORISED"`)}&order=${encodeURIComponent('DueDate ASC')}`;
        const findRes = await fetch(`https://api.xero.com/api.xro/2.0/Invoices?${query}`, { headers: xeroHeaders });
        await logApiCall(db, { userId, endpoint: 'api.xero.com/api.xro/2.0/Invoices', httpStatus: findRes.status });
        const findData: { Invoices?: Array<{ InvoiceID?: string }> } = findRes.ok ? await findRes.json() : {};
        invoiceId = findData.Invoices?.[0]?.InvoiceID ?? '';
        if (!invoiceId) {
            return json(404, { error: `No open Xero invoice found for ${invoiceNumber ? `number "${invoiceNumber}"` : `"${clientName}"`}. Check the invoice exists and is awaiting payment.` });
        }
    }

    // 2. Push the history note onto the invoice.
    const note = typeof payload.note === 'string' && payload.note.trim()
        ? payload.note.trim()
        : `Chasing update from Be More Swan — ${payload.status ?? 'overdue'}, ${payload.daysPastDue ?? '?'} days past due${payload.amount ? `, ${payload.amount} outstanding` : ''}.`;
    const historyRes = await fetch(`https://api.xero.com/api.xro/2.0/Invoices/${invoiceId}/History`, {
        method: 'PUT',
        headers: xeroHeaders,
        body: JSON.stringify({ HistoryRecords: [{ Details: note.slice(0, 2000) }] }),
    });
    await logApiCall(db, { userId, endpoint: 'api.xero.com/api.xro/2.0/Invoices/History', httpStatus: historyRes.status });
    if (!historyRes.ok) {
        return json(502, { error: 'Xero rejected the history note — the invoice may be locked or deleted.' });
    }

    return json(200, { success: true, message: `Note logged against ${invoiceNumber ? `invoice ${invoiceNumber}` : `${clientName}'s invoice`} in Xero.` });
}

// ── Slack: post the meeting summary + action items as Block Kit ───────────────

interface SlackSummaryPayload {
    meetingSummary?: unknown;
    targetDestination?: unknown;
    channel?: unknown;
    tasks?: unknown;
}
interface SlackTask { description?: unknown; assignee?: unknown; dueDate?: unknown }

async function resolveSlackChannelId(db: Db, userId: number, accessToken: string, name: string): Promise<string | null> {
    const res = await fetch('https://slack.com/api/conversations.list?types=public_channel&exclude_archived=true&limit=200', {
        headers: { Authorization: `Bearer ${accessToken}` },
    });
    await logApiCall(db, { userId, endpoint: 'slack.com/api/conversations.list', httpStatus: res.status });
    const data: { ok?: boolean; channels?: Array<{ id: string; name: string }> } = await res.json().catch(() => ({}));
    if (!data.ok) return null;
    return data.channels?.find((c) => c.name === name)?.id ?? null;
}

async function handleSlackPostSummary(db: Db, userId: number, organisationId: number, payload: SlackSummaryPayload) {
    const summary = typeof payload.meetingSummary === 'string' ? payload.meetingSummary.trim() : '';
    const tasks = (Array.isArray(payload.tasks) ? payload.tasks : [])
        .filter((t): t is SlackTask => Boolean(t && typeof t === 'object' && (t as SlackTask).description));
    if (!summary && tasks.length === 0) return json(400, { error: 'Nothing to post — the payload has no summary or tasks.' });

    const { accessToken } = await getFreshAccessToken(db, organisationId, 'slack');

    // Channel: explicit payload.channel wins; default #general. Resolve names to ids via
    // conversations.list; fall back to the raw value (chat:write.public covers public channels).
    let channel = typeof payload.channel === 'string' && payload.channel.trim() ? payload.channel.trim() : '#general';
    if (channel.startsWith('#')) {
        channel = (await resolveSlackChannelId(db, userId, accessToken, channel.slice(1))) ?? channel;
    }

    const blocks: unknown[] = [
        { type: 'header', text: { type: 'plain_text', text: '📝 Meeting summary & action items', emoji: true } },
    ];
    if (summary) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: summary.slice(0, 2900) } });
    if (tasks.length) {
        blocks.push({ type: 'divider' });
        blocks.push({
            type: 'section',
            text: {
                type: 'mrkdwn',
                text: tasks.map((t) => {
                    const due = t.dueDate ? ` · due ${String(t.dueDate)}` : '';
                    return `• *${String(t.description)}* — ${String(t.assignee || 'Unassigned')}${due}`;
                }).join('\n').slice(0, 2900),
            },
        });
    }
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: 'Posted by your Meeting Note Taker on Be More Swan 🦢' }] });

    const postRes = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ channel, text: summary || 'Meeting summary & action items', blocks, unfurl_links: false }),
    });
    await logApiCall(db, { userId, endpoint: 'slack.com/api/chat.postMessage', httpStatus: postRes.status });
    const postData: { ok?: boolean; error?: string } = await postRes.json().catch(() => ({}));
    if (!postData.ok) {
        const reason = postData.error === 'channel_not_found' ? 'channel not found — invite the Be More Swan app or check the channel name'
            : postData.error === 'not_in_channel' ? 'the Be More Swan app is not in that channel — invite it with /invite'
            : postData.error ?? 'unknown error';
        return json(502, { error: `Slack rejected the message (${reason}).` });
    }

    return json(200, { success: true, message: `Posted the summary and ${tasks.length} action item${tasks.length === 1 ? '' : 's'} to Slack.` });
}

// ── Handler ───────────────────────────────────────────────────────────────────

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;

    let body: { actionType?: string; payload?: unknown };
    try { body = JSON.parse(event.body ?? '{}'); }
    catch { return json(400, { error: 'Invalid JSON body.' }); }

    const payload = (body.payload && typeof body.payload === 'object') ? body.payload as Record<string, unknown> : {};

    try {
        switch (body.actionType) {
            case 'hubspot_update_record':
                return await handleHubspotUpdate(db, ctx.userId, ctx.organisationId, payload);
            case 'xero_log_note':
                return await handleXeroLogNote(db, ctx.userId, ctx.organisationId, payload);
            case 'slack_post_summary':
                return await handleSlackPostSummary(db, ctx.userId, ctx.organisationId, payload);
            default:
                return json(400, { error: `Unknown actionType "${body.actionType ?? ''}".` });
        }
    } catch (err) {
        if (err instanceof IntegrationError) {
            return json(err.statusCode, { error: err.message, code: err.code });
        }
        console.error('[sync-action] unexpected failure:', err);
        return json(500, { error: 'The sync failed unexpectedly — please try again.' });
    }
};
