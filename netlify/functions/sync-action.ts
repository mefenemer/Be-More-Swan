// netlify/functions/sync-action.ts
// Phase 1 External Integrations: generic action-sync endpoint, exposed as
// POST /api/actions/sync (netlify.toml rewrite).
//
// Body: { actionType: string, payload: object } — payload is the parsed LLM uiElement
// the disruptive-ui card was rendered from (untrusted; validated per handler).
//
// Handlers (one per hero integration):
//   hubspot_update_record      — data_diff_view (crm_enricher / lead_qualifier)
//                                → PATCH the matching HubSpot contact/company properties.
//   xero_log_note              — aging_invoices_table row (accounts_receivable_clerk)
//                                → push a history note onto the matching Xero invoice.
//   slack_post_summary         — action_item_assignment (meeting_note_taker)
//                                → post the summary + tasks as Block Kit via chat.postMessage.
//   salesforce_update_record   — data_diff_view (crm_enricher, primaryCrm=salesforce)
//                                → find the Contact/Account via SOQL, PATCH the enriched fields.
//   zendesk_add_internal_note  — ticket_triage_view (tier1_support_agent)
//                                → push a private (internal) comment onto the Zendesk ticket.
//   notion_create_page         — action_item_assignment (meeting_note_taker, destination=notion)
//                                → create a Notion page: summary paragraph + to_do blocks.
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

// ── Salesforce: update a Contact or Account from a data_diff_view payload ──────

const SALESFORCE_API_VERSION = 'v59.0';

/** Escape a value for interpolation inside a single-quoted SOQL string literal. */
function soqlEscape(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** "LinkedIn URL" → "LinkedInUrl" — best-effort PascalCase mapping when no propertyName
 *  is given (Salesforce field API names are PascalCase, custom fields end in __c). */
function toSalesforceField(fieldName: string): string {
    return fieldName
        .trim()
        .split(/[^a-zA-Z0-9]+/)
        .filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join('');
}

async function handleSalesforceUpdate(db: Db, userId: number, organisationId: number, payload: DataDiffPayload) {
    const fields = (Array.isArray(payload.fields) ? payload.fields : [])
        .filter((f): f is DiffField => Boolean(f && typeof f === 'object' && (f as DiffField).fieldName));
    if (fields.length === 0) return json(400, { error: 'No fields to sync.' });

    const recordName = typeof payload.recordName === 'string' ? payload.recordName.trim() : '';
    const recordEmail = typeof payload.recordEmail === 'string' ? payload.recordEmail.trim() : '';
    const isContact = payload.objectType === 'contact' || (!payload.objectType && Boolean(recordEmail));
    const sobject = isContact ? 'Contact' : 'Account';
    if (!recordEmail && !recordName) return json(400, { error: 'The payload names no record to update.' });

    // tenantId carries the org's instance URL (every Salesforce REST call is rooted there).
    const { accessToken, tenantId: instanceUrl } = await getFreshAccessToken(db, organisationId, 'salesforce');
    if (!instanceUrl) return json(409, { error: 'Salesforce is connected but no instance is mapped — please reconnect it on the Integrations page.' });
    const authHeaders = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
    const restBase = `${instanceUrl.replace(/\/$/, '')}/services/data/${SALESFORCE_API_VERSION}`;

    // 1. Find the record: Contacts by email (exact) or name; Accounts by name.
    const where = isContact && recordEmail
        ? `Email = '${soqlEscape(recordEmail)}'`
        : `Name = '${soqlEscape(recordName)}'`;
    const soql = `SELECT Id FROM ${sobject} WHERE ${where} LIMIT 1`;
    const searchRes = await fetch(`${restBase}/query?q=${encodeURIComponent(soql)}`, { headers: authHeaders });
    await logApiCall(db, { userId, endpoint: `salesforce.com/services/data/${SALESFORCE_API_VERSION}/query`, httpStatus: searchRes.status });
    const searchData: { records?: Array<{ Id?: string }> } = searchRes.ok ? await searchRes.json() : {};
    const recordId = searchData.records?.[0]?.Id;
    if (!recordId) {
        return json(404, { error: `No matching Salesforce ${sobject} found for "${recordEmail || recordName}". Check the record exists in Salesforce, then try again.` });
    }

    // 2. Patch the enriched fields onto it (204 No Content on success).
    const properties: Record<string, string> = {};
    for (const f of fields) {
        const prop = typeof f.propertyName === 'string' && f.propertyName ? f.propertyName : toSalesforceField(String(f.fieldName));
        if (prop) properties[prop] = String(f.newValue ?? '');
    }
    const patchRes = await fetch(`${restBase}/sobjects/${sobject}/${recordId}`, {
        method: 'PATCH',
        headers: authHeaders,
        body: JSON.stringify(properties),
    });
    await logApiCall(db, { userId, endpoint: `salesforce.com/services/data/${SALESFORCE_API_VERSION}/sobjects/${sobject}`, httpStatus: patchRes.status });
    if (!patchRes.ok) {
        const errs: Array<{ message?: string }> = await patchRes.json().catch(() => []);
        const message = Array.isArray(errs) ? errs[0]?.message : undefined;
        return json(502, { error: `Salesforce rejected the update${message ? `: ${message}` : '.'}` });
    }

    return json(200, { success: true, message: `Updated ${Object.keys(properties).length} field${Object.keys(properties).length === 1 ? '' : 's'} on Salesforce ${sobject} "${recordEmail || recordName}".` });
}

// ── Zendesk: add an internal (private) note to a ticket ────────────────────────

interface ZendeskNotePayload {
    ticketId?: unknown;
    summary?: unknown;
    status?: unknown;
    confidenceScore?: unknown;
    escalationReason?: unknown;
}

async function handleZendeskAddNote(db: Db, userId: number, organisationId: number, payload: ZendeskNotePayload) {
    const ticketId = String(payload.ticketId ?? '').trim();
    if (!/^\d+$/.test(ticketId)) {
        return json(400, { error: 'The payload has no Zendesk ticket id — include the ticket number in the conversation so the triage card can carry it.' });
    }
    const summary = typeof payload.summary === 'string' ? payload.summary.trim() : '';
    if (!summary) return json(400, { error: 'Nothing to log — the payload has no summary.' });

    // tenantId carries the workspace's Zendesk subdomain captured at connect time.
    const { accessToken, tenantId: subdomain } = await getFreshAccessToken(db, organisationId, 'zendesk');
    if (!subdomain) return json(409, { error: 'Zendesk is connected but no subdomain is mapped — please reconnect it on the Integrations page.' });

    const lines = [`Be More Swan triage summary: ${summary}`];
    if (payload.status) lines.push(`Status: ${String(payload.status)}${Number.isFinite(Number(payload.confidenceScore)) ? ` (${Number(payload.confidenceScore)}% confident)` : ''}`);
    if (typeof payload.escalationReason === 'string' && payload.escalationReason.trim()) lines.push(`Escalation reason: ${payload.escalationReason.trim()}`);

    // public:false makes the comment an internal note — never shown to the requester.
    const noteRes = await fetch(`https://${subdomain}.zendesk.com/api/v2/tickets/${ticketId}.json`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticket: { comment: { body: lines.join('\n').slice(0, 5000), public: false } } }),
    });
    await logApiCall(db, { userId, endpoint: `${subdomain}.zendesk.com/api/v2/tickets`, httpStatus: noteRes.status });
    if (noteRes.status === 404) {
        return json(404, { error: `No Zendesk ticket #${ticketId} found — check the ticket number and try again.` });
    }
    if (!noteRes.ok) {
        const err: { description?: string; error?: string } = await noteRes.json().catch(() => ({}));
        return json(502, { error: `Zendesk rejected the note${err.description || err.error ? `: ${err.description || err.error}` : '.'}` });
    }

    return json(200, { success: true, message: `Internal note added to Zendesk ticket #${ticketId}.` });
}

// ── Notion: create a page with the summary + action items as to_do blocks ──────

const NOTION_VERSION = '2022-06-28';
interface NotionPagePayload {
    meetingSummary?: unknown;
    tasks?: unknown;
    title?: unknown;
}
interface NotionTask { description?: unknown; assignee?: unknown; dueDate?: unknown }

async function handleNotionCreatePage(db: Db, userId: number, organisationId: number, payload: NotionPagePayload) {
    const summary = typeof payload.meetingSummary === 'string' ? payload.meetingSummary.trim() : '';
    const tasks = (Array.isArray(payload.tasks) ? payload.tasks : [])
        .filter((t): t is NotionTask => Boolean(t && typeof t === 'object' && (t as NotionTask).description));
    if (!summary && tasks.length === 0) return json(400, { error: 'Nothing to sync — the payload has no summary or tasks.' });

    const { accessToken } = await getFreshAccessToken(db, organisationId, 'notion');
    const notionHeaders = { Authorization: `Bearer ${accessToken}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' };

    // 1. Notion pages need a parent the integration can see — pick the most recently
    // edited page shared with the Be More Swan connection.
    const searchRes = await fetch('https://api.notion.com/v1/search', {
        method: 'POST',
        headers: notionHeaders,
        body: JSON.stringify({
            filter: { property: 'object', value: 'page' },
            sort: { direction: 'descending', timestamp: 'last_edited_time' },
            page_size: 1,
        }),
    });
    await logApiCall(db, { userId, endpoint: 'api.notion.com/v1/search', httpStatus: searchRes.status });
    const searchData: { results?: Array<{ id?: string }> } = searchRes.ok ? await searchRes.json() : {};
    const parentPageId = searchData.results?.[0]?.id;
    if (!parentPageId) {
        return json(404, { error: 'No Notion page is shared with Be More Swan yet — open Notion, share a page with the Be More Swan connection, then try again.' });
    }

    // 2. Create the page: summary as a paragraph block, each action item as a to_do block.
    const title = typeof payload.title === 'string' && payload.title.trim()
        ? payload.title.trim()
        : `Meeting summary — ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`;
    const children: unknown[] = [];
    if (summary) {
        children.push({
            object: 'block', type: 'paragraph',
            paragraph: { rich_text: [{ type: 'text', text: { content: summary.slice(0, 2000) } }] },
        });
    }
    if (tasks.length) {
        children.push({
            object: 'block', type: 'heading_2',
            heading_2: { rich_text: [{ type: 'text', text: { content: 'Action items' } }] },
        });
        for (const t of tasks) {
            const due = t.dueDate ? ` · due ${String(t.dueDate)}` : '';
            const line = `${String(t.description)} — ${String(t.assignee || 'Unassigned')}${due}`;
            children.push({
                object: 'block', type: 'to_do',
                to_do: { rich_text: [{ type: 'text', text: { content: line.slice(0, 2000) } }], checked: false },
            });
        }
    }

    const createRes = await fetch('https://api.notion.com/v1/pages', {
        method: 'POST',
        headers: notionHeaders,
        body: JSON.stringify({
            parent: { page_id: parentPageId },
            properties: { title: { title: [{ type: 'text', text: { content: title.slice(0, 200) } }] } },
            children,
        }),
    });
    await logApiCall(db, { userId, endpoint: 'api.notion.com/v1/pages', httpStatus: createRes.status });
    if (!createRes.ok) {
        const err: { message?: string } = await createRes.json().catch(() => ({}));
        return json(502, { error: `Notion rejected the page${err.message ? `: ${err.message}` : '.'}` });
    }

    return json(200, { success: true, message: `Created "${title}" in Notion with ${tasks.length} action item${tasks.length === 1 ? '' : 's'}.` });
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
            case 'salesforce_update_record':
                return await handleSalesforceUpdate(db, ctx.userId, ctx.organisationId, payload);
            case 'zendesk_add_internal_note':
                return await handleZendeskAddNote(db, ctx.userId, ctx.organisationId, payload);
            case 'notion_create_page':
                return await handleNotionCreatePage(db, ctx.userId, ctx.organisationId, payload);
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
