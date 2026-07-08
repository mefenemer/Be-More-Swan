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
//   qbo_log_note               — aging_invoices_table row (accounts_receivable_clerk,
//                                accountingPlatform=quickbooks) → resolve the QBO invoice
//                                and append a memo to its PrivateNote via sparse update.
//   intercom_add_internal_note — ticket_triage_view (tier1_support_agent,
//                                helpdeskPlatform=intercom) → post the triage summary as
//                                an admin note on the Intercom conversation.
//   gmail_create_draft         — lead_scoring_card / ticket_triage_view
//                                → create a Gmail draft (to/subject/body) in the user's
//                                outbox so they can review it before sending.
//   threads_create_post        — social_publish_card (social_media_manager)
//                                → two-step Threads publish: create the media/text
//                                container, then publish it.
//   tiktok_upload_video        — social_publish_card (social_media_manager)
//                                → PULL_FROM_URL direct-post init with the AI caption
//                                + hashtags; TikTok fetches and processes the video.
//   youtube_upload_video       — social_publish_card (social_media_manager)
//                                → resumable upload (Shorts or long-form) with the
//                                AI-generated SEO title, description and tags.
//
// NOTE: the Threads/TikTok/YouTube calls follow the documented API contracts but have
// NOT been validated against the live APIs (mirrors publish-social-posts.ts) — the
// structural flow and token injection are exact; verify with real connected accounts.
//
// Every path: requireTenant (org-scoped), token via getFreshAccessToken (which silently
// refreshes an expired access token), and integration_api_calls audit rows (SC6 —
// endpoint paths only, no query params or payloads).

import { Handler } from '@netlify/functions';
import { and, eq, inArray } from 'drizzle-orm';
import { Resend } from 'resend';
import { getDb } from '../../db/client';
import { actionItems } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { logApiCall } from '../../src/utils/vault';
import { getFreshAccessToken, getIntegration, IntegrationError, providerLabel } from '../../src/utils/workspace-integrations';
import { sendGmailMessage } from '../../src/utils/gmail';
import { injectAiFooter } from '../../src/utils/ai-email-footer';

type Db = ReturnType<typeof getDb>;

// Resend is the no-inbox fallback for email_meeting_followup (guarded: resend v6 throws at
// construction when the key is missing, which would crash this module at import).
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const FROM_DOMAIN = process.env.OUTBOUND_EMAIL_DOMAIN || 'outbound.bemoreswan.com';

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

// ── QuickBooks: append a memo to an invoice's private note (sparse update) ─────

// QBO has no invoice-history endpoint (unlike Xero) — the equivalent audit trail is the
// invoice's PrivateNote (internal memo, max 4000 chars), updated via a sparse POST that
// must carry the record's current SyncToken.
const QBO_PRIVATE_NOTE_MAX = 4000;

function qboApiBase(): string {
    // QUICKBOOKS_API_BASE lets sandbox companies point at sandbox-quickbooks.api.intuit.com.
    return (process.env.QUICKBOOKS_API_BASE ?? 'https://quickbooks.api.intuit.com').replace(/\/$/, '');
}

/** Escape a value for interpolation inside a single-quoted QBO query string literal. */
function qboEscape(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

interface QboInvoiceRecord { Id?: string; SyncToken?: string; PrivateNote?: string; DocNumber?: string }

async function qboQuery(db: Db, userId: number, realmId: string, headers: Record<string, string>, query: string): Promise<{ Invoice?: QboInvoiceRecord[]; Customer?: Array<{ Id?: string }> }> {
    const res = await fetch(`${qboApiBase()}/v3/company/${encodeURIComponent(realmId)}/query?minorversion=70&query=${encodeURIComponent(query)}`, { headers });
    await logApiCall(db, { userId, endpoint: 'quickbooks.api.intuit.com/v3/company/query', httpStatus: res.status });
    const data: { QueryResponse?: { Invoice?: QboInvoiceRecord[]; Customer?: Array<{ Id?: string }> } } = res.ok ? await res.json().catch(() => ({})) : {};
    return data.QueryResponse ?? {};
}

async function handleQboLogNote(db: Db, userId: number, organisationId: number, payload: XeroNotePayload) {
    const clientName = typeof payload.clientName === 'string' ? payload.clientName.trim() : '';
    const invoiceNumber = typeof payload.invoiceNumber === 'string' ? payload.invoiceNumber.trim() : '';
    const invoiceId = typeof payload.invoiceId === 'string' ? payload.invoiceId.trim() : '';
    if (!invoiceId && !invoiceNumber && !clientName) return json(400, { error: 'The payload identifies no invoice (needs invoiceId, invoiceNumber or clientName).' });

    // tenantId carries the company realmId captured from the OAuth callback.
    const { accessToken, tenantId: realmId } = await getFreshAccessToken(db, organisationId, 'quickbooks');
    if (!realmId) return json(409, { error: 'QuickBooks is connected but no company is mapped — please reconnect it on the Integrations page.' });
    const qboHeaders = { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'Content-Type': 'application/json' };

    // 1. Resolve the invoice — the sparse update needs its Id, current SyncToken and
    // existing PrivateNote (LLM payloads rarely carry QBO ids).
    let invoice: QboInvoiceRecord | undefined;
    if (invoiceId) {
        const { Invoice } = await qboQuery(db, userId, realmId, qboHeaders, `SELECT Id, SyncToken, PrivateNote, DocNumber FROM Invoice WHERE Id = '${qboEscape(invoiceId)}'`);
        invoice = Invoice?.[0];
    } else if (invoiceNumber) {
        const { Invoice } = await qboQuery(db, userId, realmId, qboHeaders, `SELECT Id, SyncToken, PrivateNote, DocNumber FROM Invoice WHERE DocNumber = '${qboEscape(invoiceNumber)}'`);
        invoice = Invoice?.[0];
    } else {
        // QBO queries can't filter invoices by customer NAME — resolve the Customer id first,
        // then take the oldest-due open invoice for that customer.
        const { Customer } = await qboQuery(db, userId, realmId, qboHeaders, `SELECT Id FROM Customer WHERE DisplayName = '${qboEscape(clientName)}'`);
        const customerId = Customer?.[0]?.Id;
        if (customerId) {
            const { Invoice } = await qboQuery(db, userId, realmId, qboHeaders, `SELECT Id, SyncToken, PrivateNote, DocNumber FROM Invoice WHERE CustomerRef = '${qboEscape(customerId)}' AND Balance > '0' ORDERBY DueDate`);
            invoice = Invoice?.[0];
        }
    }
    if (!invoice?.Id || invoice.SyncToken === undefined) {
        return json(404, { error: `No open QuickBooks invoice found for ${invoiceNumber ? `number "${invoiceNumber}"` : `"${clientName || invoiceId}"`}. Check the invoice exists and is awaiting payment.` });
    }

    // 2. Append the chasing note to the invoice's private memo (sparse update keeps
    // every other field untouched).
    const note = typeof payload.note === 'string' && payload.note.trim()
        ? payload.note.trim()
        : `Chasing update from Be More Swan — ${payload.status ?? 'overdue'}, ${payload.daysPastDue ?? '?'} days past due${payload.amount ? `, ${payload.amount} outstanding` : ''}.`;
    const stamped = `[${new Date().toISOString().slice(0, 10)}] ${note}`;
    const combined = invoice.PrivateNote ? `${invoice.PrivateNote}\n${stamped}` : stamped;
    const updateRes = await fetch(`${qboApiBase()}/v3/company/${encodeURIComponent(realmId)}/invoice?minorversion=70`, {
        method: 'POST',
        headers: qboHeaders,
        body: JSON.stringify({
            Id: invoice.Id,
            SyncToken: invoice.SyncToken,
            sparse: true,
            PrivateNote: combined.slice(-QBO_PRIVATE_NOTE_MAX),
        }),
    });
    await logApiCall(db, { userId, endpoint: 'quickbooks.api.intuit.com/v3/company/invoice', httpStatus: updateRes.status });
    if (!updateRes.ok) {
        const err: { Fault?: { Error?: Array<{ Message?: string }> } } = await updateRes.json().catch(() => ({}));
        const message = err.Fault?.Error?.[0]?.Message;
        return json(502, { error: `QuickBooks rejected the note${message ? `: ${message}` : ' — the invoice may be locked or deleted.'}` });
    }

    const label = invoice.DocNumber ? `invoice ${invoice.DocNumber}` : (clientName ? `${clientName}'s invoice` : 'the invoice');
    return json(200, { success: true, message: `Note logged against ${label} in QuickBooks.` });
}

// ── Intercom: add an internal (admin) note to a conversation ───────────────────

const INTERCOM_VERSION = '2.11';

interface IntercomNotePayload {
    conversationId?: unknown;
    ticketId?: unknown;
    summary?: unknown;
    status?: unknown;
    confidenceScore?: unknown;
    escalationReason?: unknown;
}

async function handleIntercomAddNote(db: Db, userId: number, organisationId: number, payload: IntercomNotePayload) {
    const conversationId = String(payload.conversationId ?? payload.ticketId ?? '').trim();
    if (!/^\d+$/.test(conversationId)) {
        return json(400, { error: 'The payload has no Intercom conversation id — include the conversation number in the chat so the triage card can carry it.' });
    }
    const summary = typeof payload.summary === 'string' ? payload.summary.trim() : '';
    if (!summary) return json(400, { error: 'Nothing to log — the payload has no summary.' });

    const { accessToken } = await getFreshAccessToken(db, organisationId, 'intercom');
    const intercomHeaders = { Authorization: `Bearer ${accessToken}`, 'Intercom-Version': INTERCOM_VERSION, Accept: 'application/json', 'Content-Type': 'application/json' };

    // 1. Note replies must be authored by an admin — /me identifies the admin the
    // workspace authorised at connect time.
    const meRes = await fetch('https://api.intercom.io/me', { headers: intercomHeaders });
    await logApiCall(db, { userId, endpoint: 'api.intercom.io/me', httpStatus: meRes.status });
    const me: { id?: string } = meRes.ok ? await meRes.json().catch(() => ({})) : {};
    if (!me.id) {
        return json(502, { error: 'Intercom did not identify the connected admin — please reconnect it on the Integrations page.' });
    }

    // 2. message_type 'note' makes the reply an internal note — never shown to the customer.
    const lines = [`Be More Swan triage summary: ${summary}`];
    if (payload.status) lines.push(`Status: ${String(payload.status)}${Number.isFinite(Number(payload.confidenceScore)) ? ` (${Number(payload.confidenceScore)}% confident)` : ''}`);
    if (typeof payload.escalationReason === 'string' && payload.escalationReason.trim()) lines.push(`Escalation reason: ${payload.escalationReason.trim()}`);

    const noteRes = await fetch(`https://api.intercom.io/conversations/${conversationId}/reply`, {
        method: 'POST',
        headers: intercomHeaders,
        body: JSON.stringify({
            message_type: 'note',
            type: 'admin',
            admin_id: me.id,
            body: lines.join('\n').slice(0, 5000),
        }),
    });
    await logApiCall(db, { userId, endpoint: 'api.intercom.io/conversations/reply', httpStatus: noteRes.status });
    if (noteRes.status === 404) {
        return json(404, { error: `No Intercom conversation #${conversationId} found — check the conversation number and try again.` });
    }
    if (!noteRes.ok) {
        const err: { errors?: Array<{ message?: string }> } = await noteRes.json().catch(() => ({}));
        const message = err.errors?.[0]?.message;
        return json(502, { error: `Intercom rejected the note${message ? `: ${message}` : '.'}` });
    }

    return json(200, { success: true, message: `Internal note added to Intercom conversation #${conversationId}.` });
}

// ── Gmail: create a draft in the user's outbox for review before sending ──────

interface GmailDraftPayload {
    to?: unknown;
    subject?: unknown;
    body?: unknown;
}

/** RFC 2047 B-encode a header value so non-ASCII subjects survive the MIME round trip. */
function encodeMimeHeader(value: string): string {
    // eslint-disable-next-line no-control-regex
    return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

async function handleGmailCreateDraft(db: Db, userId: number, organisationId: number, payload: GmailDraftPayload) {
    // Strip CR/LF so payload values can never smuggle extra MIME headers.
    const to = typeof payload.to === 'string' ? payload.to.replace(/[\r\n]+/g, ' ').trim() : '';
    const subject = typeof payload.subject === 'string' ? payload.subject.replace(/[\r\n]+/g, ' ').trim() : '';
    const body = typeof payload.body === 'string' ? payload.body.trim() : '';
    if (!subject && !body) return json(400, { error: 'Nothing to draft — the payload has no subject or body.' });

    const { accessToken } = await getFreshAccessToken(db, organisationId, 'gmail');

    // Drafts API takes a full RFC 2822 message, base64url-encoded. A missing "to" is fine —
    // Gmail happily stores recipient-less drafts for the user to complete.
    const mime = [
        ...(to ? [`To: ${to}`] : []),
        `Subject: ${encodeMimeHeader(subject || '(no subject)')}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset="UTF-8"',
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.from(body, 'utf8').toString('base64'),
    ].join('\r\n');

    const draftRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: { raw: Buffer.from(mime, 'utf8').toString('base64url') } }),
    });
    await logApiCall(db, { userId, endpoint: 'gmail.googleapis.com/gmail/v1/users/me/drafts', httpStatus: draftRes.status });
    if (!draftRes.ok) {
        const err: { error?: { message?: string } } = await draftRes.json().catch(() => ({}));
        return json(502, { error: `Gmail rejected the draft${err.error?.message ? `: ${err.error.message}` : '.'}` });
    }

    return json(200, { success: true, message: `Draft${to ? ` to ${to}` : ''} created in Gmail — review it in your Drafts folder before sending.` });
}

// ── Threads: two-step publish (create the container, then publish it) ─────────

const THREADS_TEXT_MAX = 500;

interface ThreadsPostPayload {
    caption?: unknown;
    text?: unknown;
    hashtags?: unknown;
    imageUrl?: unknown;
    mediaUrl?: unknown;
    conversational?: unknown;
}

async function handleThreadsCreatePost(db: Db, userId: number, organisationId: number, payload: ThreadsPostPayload) {
    const caption = typeof payload.text === 'string' && payload.text.trim()
        ? payload.text.trim()
        : typeof payload.caption === 'string' ? payload.caption.trim() : '';
    // Conversational strategy ("no hashtags") drops the hashtag line entirely.
    const hashtags = payload.conversational ? '' : (typeof payload.hashtags === 'string' ? payload.hashtags.trim() : '');
    const text = [caption, hashtags].filter(Boolean).join('\n\n').slice(0, THREADS_TEXT_MAX);
    if (!text) return json(400, { error: 'Nothing to post — the payload has no text.' });

    // tenantId carries the Threads user id captured at connect time (roots /{id}/threads).
    const { accessToken, tenantId } = await getFreshAccessToken(db, organisationId, 'threads');
    const threadsUserId = tenantId || 'me';
    const authHeaders = { Authorization: `Bearer ${accessToken}` };

    // 1. Create the media container (TEXT, or IMAGE when the draft carries an asset).
    const imageUrl = typeof payload.imageUrl === 'string' && payload.imageUrl.trim()
        ? payload.imageUrl.trim()
        : typeof payload.mediaUrl === 'string' ? payload.mediaUrl.trim() : '';
    const containerParams = new URLSearchParams({ media_type: imageUrl ? 'IMAGE' : 'TEXT', text });
    if (imageUrl) containerParams.set('image_url', imageUrl);
    const containerRes = await fetch(`https://graph.threads.net/v1.0/${encodeURIComponent(threadsUserId)}/threads`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: containerParams,
    });
    await logApiCall(db, { userId, endpoint: 'graph.threads.net/v1.0/threads', httpStatus: containerRes.status });
    const containerData: { id?: string; error?: { message?: string } } = await containerRes.json().catch(() => ({}));
    if (!containerRes.ok || !containerData.id) {
        return json(502, { error: `Threads rejected the post container${containerData.error?.message ? `: ${containerData.error.message}` : '.'}` });
    }

    // 2. Publish the container.
    const publishRes = await fetch(`https://graph.threads.net/v1.0/${encodeURIComponent(threadsUserId)}/threads_publish`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ creation_id: containerData.id }),
    });
    await logApiCall(db, { userId, endpoint: 'graph.threads.net/v1.0/threads_publish', httpStatus: publishRes.status });
    const publishData: { id?: string; error?: { message?: string } } = await publishRes.json().catch(() => ({}));
    if (!publishRes.ok || !publishData.id) {
        return json(502, { error: `Threads rejected the publish step${publishData.error?.message ? `: ${publishData.error.message}` : '.'}` });
    }

    return json(200, { success: true, message: `Post published to Threads${imageUrl ? ' with image' : ''}.`, platformPostId: publishData.id });
}

// ── TikTok: direct-post a video from a URL with the AI caption + hashtags ─────

const TIKTOK_TITLE_MAX = 2200;

interface TiktokUploadPayload {
    videoUrl?: unknown;
    mediaUrl?: unknown;
    caption?: unknown;
    hashtags?: unknown;
}

async function handleTiktokUploadVideo(db: Db, userId: number, organisationId: number, payload: TiktokUploadPayload) {
    const videoUrl = typeof payload.videoUrl === 'string' && payload.videoUrl.trim()
        ? payload.videoUrl.trim()
        : typeof payload.mediaUrl === 'string' ? payload.mediaUrl.trim() : '';
    if (!/^https:\/\//.test(videoUrl)) return json(400, { error: 'The payload has no https video URL to upload.' });

    const caption = typeof payload.caption === 'string' ? payload.caption.trim() : '';
    const hashtags = typeof payload.hashtags === 'string' ? payload.hashtags.trim() : '';
    const title = [caption, hashtags].filter(Boolean).join(' ').slice(0, TIKTOK_TITLE_MAX);

    const { accessToken } = await getFreshAccessToken(db, organisationId, 'tiktok');

    // PULL_FROM_URL: TikTok fetches the video itself and processes it asynchronously —
    // the domain hosting videoUrl must be verified in the TikTok app settings.
    const initRes = await fetch('https://open.tiktokapis.com/v2/post/publish/video/init/', {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify({
            post_info: {
                title,
                privacy_level: 'PUBLIC_TO_EVERYONE',
            },
            source_info: {
                source: 'PULL_FROM_URL',
                video_url: videoUrl,
            },
        }),
    });
    await logApiCall(db, { userId, endpoint: 'open.tiktokapis.com/v2/post/publish/video/init', httpStatus: initRes.status });
    const initData: { data?: { publish_id?: string }; error?: { code?: string; message?: string } } = await initRes.json().catch(() => ({}));
    const errCode = initData.error?.code;
    if (!initRes.ok || !initData.data?.publish_id || (errCode && errCode !== 'ok')) {
        return json(502, { error: `TikTok rejected the upload${initData.error?.message ? `: ${initData.error.message}` : '.'}` });
    }

    return json(200, { success: true, message: 'Video sent to TikTok — it is processing and will appear on your profile shortly.', platformPostId: initData.data.publish_id });
}

// ── YouTube: resumable upload (Shorts or long-form) with SEO metadata ─────────

const YOUTUBE_TITLE_MAX = 100;
const YOUTUBE_DESCRIPTION_MAX = 5000;

interface YoutubeUploadPayload {
    videoUrl?: unknown;
    mediaUrl?: unknown;
    title?: unknown;
    caption?: unknown;
    description?: unknown;
    tags?: unknown;
    format?: unknown; // 'shorts' | 'longform'
}

async function handleYoutubeUploadVideo(db: Db, userId: number, organisationId: number, payload: YoutubeUploadPayload) {
    const videoUrl = typeof payload.videoUrl === 'string' && payload.videoUrl.trim()
        ? payload.videoUrl.trim()
        : typeof payload.mediaUrl === 'string' ? payload.mediaUrl.trim() : '';
    if (!/^https:\/\//.test(videoUrl)) return json(400, { error: 'The payload has no https video URL to upload.' });

    const isShorts = String(payload.format ?? '').toLowerCase() === 'shorts';
    let title = (typeof payload.title === 'string' && payload.title.trim()
        ? payload.title.trim()
        : typeof payload.caption === 'string' ? payload.caption.trim() : '') || 'New video';
    // YouTube surfaces Shorts by the #Shorts marker in the title or description.
    if (isShorts && !/#shorts/i.test(title)) title = `${title} #Shorts`.trim();
    title = title.slice(0, YOUTUBE_TITLE_MAX);

    const description = (typeof payload.description === 'string' ? payload.description.trim() : '').slice(0, YOUTUBE_DESCRIPTION_MAX);
    const tags = (Array.isArray(payload.tags) ? payload.tags : String(payload.tags ?? '').split(','))
        .map((t) => String(t).replace(/^#/, '').trim())
        .filter(Boolean)
        .slice(0, 30);

    const { accessToken } = await getFreshAccessToken(db, organisationId, 'youtube');

    // 1. Open the resumable upload session with the SEO metadata.
    const initRes = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify({
            snippet: { title, description, tags, categoryId: '22' }, // 22 = People & Blogs (safe default)
            status: { privacyStatus: 'public', selfDeclaredMadeForKids: false },
        }),
    });
    await logApiCall(db, { userId, endpoint: 'googleapis.com/upload/youtube/v3/videos', httpStatus: initRes.status });
    const uploadUrl = initRes.headers.get('location');
    if (!initRes.ok || !uploadUrl) {
        const err: { error?: { message?: string } } = await initRes.json().catch(() => ({}));
        return json(502, { error: `YouTube rejected the upload session${err.error?.message ? `: ${err.error.message}` : '.'}` });
    }

    // 2. Stream the video bytes into the session.
    const videoRes = await fetch(videoUrl);
    if (!videoRes.ok) return json(502, { error: 'Could not fetch the video file from storage — try again or re-attach the video.' });
    const videoBytes = Buffer.from(await videoRes.arrayBuffer());

    const putRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': videoRes.headers.get('content-type') ?? 'video/mp4', 'Content-Length': String(videoBytes.byteLength) },
        body: videoBytes,
    });
    await logApiCall(db, { userId, endpoint: 'googleapis.com/upload/youtube/v3/videos (bytes)', httpStatus: putRes.status });
    const videoData: { id?: string; error?: { message?: string } } = await putRes.json().catch(() => ({}));
    if (!putRes.ok || !videoData.id) {
        return json(502, { error: `YouTube rejected the video upload${videoData.error?.message ? `: ${videoData.error.message}` : '.'}` });
    }

    return json(200, { success: true, message: `${isShorts ? 'Short' : 'Video'} "${title}" uploaded to YouTube.`, platformPostId: videoData.id });
}

// ── Email: send a meeting follow-up to attendees from the user's inbox ─────────
// Primary path is the org's connected Gmail (sendGmailMessage — the user's own inbox);
// when no inbox is connected it falls back to the Be More Swan outbound domain via Resend,
// so approving a meeting always sends. Both paths inject the mandatory AI disclosure footer
// (US-GOV-3.1.2). Recipients + reviewed subject/body are built by scenario-engine.buildEmailPayload.

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

interface EmailFollowupPayload {
    to?: unknown;            // string[] of attendee email addresses
    subject?: unknown;
    body?: unknown;
    assistantName?: unknown; // for the disclosure footer + fallback From line
}

async function handleEmailMeetingFollowup(db: Db, userId: number, organisationId: number, payload: EmailFollowupPayload) {
    const recipients = (Array.isArray(payload.to) ? payload.to : [])
        .map((r) => (typeof r === 'string' ? r.replace(/[\r\n]+/g, ' ').trim() : ''))
        .filter((r) => EMAIL_RE.test(r));
    if (recipients.length === 0) {
        return json(400, { error: 'No attendee email addresses to send the follow-up to — add at least one attendee email in the inbox first.' });
    }

    const subject = typeof payload.subject === 'string' && payload.subject.trim() ? payload.subject.trim() : 'Meeting follow-up';
    const rawBody = typeof payload.body === 'string' ? payload.body.trim() : '';
    if (!rawBody) return json(400, { error: 'The follow-up email has no body to send.' });

    const assistantName = typeof payload.assistantName === 'string' && payload.assistantName.trim()
        ? payload.assistantName.trim() : 'Your Be More Swan assistant';
    const finalBody = injectAiFooter(rawBody, assistantName, null, false);
    const plural = recipients.length === 1 ? '' : 's';

    // Primary: send from the org's connected Gmail (the user's own inbox). One message to all
    // attendees — they were in the meeting together, so a shared To line is expected.
    try {
        const sent = await sendGmailMessage(db, organisationId, { to: recipients.join(', '), subject, body: finalBody });
        await logApiCall(db, { userId, endpoint: 'gmail.googleapis.com/gmail/v1/users/me/messages/send', httpStatus: 200 });
        return json(200, { success: true, message: `Follow-up sent to ${recipients.length} attendee${plural} from your Gmail.`, platformPostId: sent.id });
    } catch (err) {
        if (!(err instanceof IntegrationError)) throw err;
        // Gmail isn't connected — fall through to the Resend fallback.
    }

    // Fallback: send from the Be More Swan outbound domain via Resend (no inbox connected).
    if (!resend) {
        console.log(`[DEV] email_meeting_followup to ${recipients.join(', ')}: subject="${subject}" (no Gmail, no RESEND_API_KEY)`);
        await logApiCall(db, { userId, endpoint: 'resend.com/emails (dev)', httpStatus: 200 });
        return json(200, { success: true, message: `Follow-up prepared for ${recipients.length} attendee${plural} (dev mode — not actually sent).` });
    }
    const result = await resend.emails.send({
        from: `${assistantName} via Be More Swan <assistant@${FROM_DOMAIN}>`,
        to: recipients,
        subject,
        text: finalBody,
    });
    const sendError = (result as { error?: { message?: string } })?.error;
    await logApiCall(db, { userId, endpoint: 'resend.com/emails', httpStatus: sendError ? 502 : 200 });
    if (sendError) return json(502, { error: `The follow-up email could not be sent${sendError.message ? `: ${sendError.message}` : '.'}` });
    const emailId = (result as { data?: { id?: string } })?.data?.id ?? null;
    return json(200, { success: true, message: `Follow-up sent to ${recipients.length} attendee${plural} from Be More Swan.`, platformPostId: emailId });
}

// ── PM task push: create one Jira/Asana ticket per approved action item ─────────
// Reads the meeting's action_items ledger (materialised at approval) and files one ticket per
// row still needing sync, stamping per-row status so partial syncs + retries are idempotent
// ("5 of 8 synced"). The tasks come from the DB, not the payload, so a retry always reflects
// live state. The provider-specific create call is wired in Phase 3 steps 3–4; until the
// provider is connected, getFreshAccessToken throws not_connected and the batch is marked
// 'skipped' (re-approving the meeting revives skipped rows — see materialiseActionItems).
// Design: docs/meeting-note-taker-phase3-plan.md.

interface CreateTasksPayload {
    meetingRecordId?: unknown;
    projectKey?: unknown;
    issueType?: unknown;
    asanaProjectGid?: unknown;
}

interface LedgerRow { id: number; description: string; assignee: string | null; dueDate: string | null }

// Ledger states that still need a sync attempt. 'synced' is terminal; 'skipped' is revived only
// by a re-approval, never auto-retried, so it is excluded here.
const SYNCABLE_STATUSES = ['pending', 'failed'];

/** Minimal Atlassian Document Format doc — one paragraph per line (empty line → blank para). */
function adfDoc(lines: string[]): Record<string, unknown> {
    return {
        type: 'doc',
        version: 1,
        content: lines.map((line) => line
            ? { type: 'paragraph', content: [{ type: 'text', text: line }] }
            : { type: 'paragraph', content: [] }),
    };
}

/** Best-effort parse of a free-text due date to YYYY-MM-DD. Returns null for unparseable
 *  phrases ("by Friday") — we never guess a date the meeting didn't state. ISO strings are taken
 *  verbatim and non-ISO values formatted from local parts, so the calendar date never shifts by
 *  a timezone (new Date() parses ISO as UTC but slash/word dates as local). */
function parseDueDate(raw: string | null): string | null {
    if (!raw) return null;
    const s = raw.trim();
    const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
    const d = new Date(s);
    if (isNaN(d.getTime())) return null;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// A created ticket, normalised across providers: external id + a browse URL (null when the
// provider gives none) to stamp onto the ledger row.
interface TicketRef { id: string; url: string | null }

/** The owner/due/attribution lines shared by both providers' ticket bodies. Assignees are
 *  free-text meeting names (not provider account ids), so the owner is surfaced in the body and
 *  the ticket left unassigned (plan §8). */
function ticketBodyLines(row: LedgerRow): string[] {
    const owner = row.assignee && row.assignee.toLowerCase() !== 'unassigned' ? row.assignee : null;
    return [
        ...(owner ? [`Owner (from meeting): ${owner}`] : []),
        ...(row.dueDate ? [`Due (as stated): ${row.dueDate}`] : []),
        '',
        'Created by Be More Swan from an approved meeting action item.',
    ];
}

/** Create one Jira issue for an action item. Throws with a readable message on rejection so the
 *  caller can stamp it onto the ledger row. */
async function createJiraIssue(accessToken: string, cloudId: string | null, siteUrl: string, payload: CreateTasksPayload, row: LedgerRow): Promise<TicketRef> {
    if (!cloudId) throw new Error('Jira site is missing — reconnect Jira.');
    const projectKey = typeof payload.projectKey === 'string' ? payload.projectKey.trim() : '';
    if (!projectKey) throw new Error('No Jira project key is configured for this recipe.');
    const issueType = typeof payload.issueType === 'string' && payload.issueType.trim() ? payload.issueType.trim() : 'Task';

    const fields: Record<string, unknown> = {
        project: { key: projectKey },
        summary: row.description.slice(0, 250),
        issuetype: { name: issueType },
        description: adfDoc(ticketBodyLines(row)),
    };
    const due = parseDueDate(row.dueDate);
    if (due) fields.duedate = due;

    const res = await fetch(`https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/issue`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ fields }),
    });
    const data: { key?: string; errorMessages?: string[]; errors?: Record<string, string> } = await res.json().catch(() => ({}));
    if (!res.ok || !data.key) {
        const detail = data.errorMessages?.join('; ') || (data.errors ? Object.values(data.errors).join('; ') : '') || `Jira returned ${res.status}`;
        throw new Error(detail);
    }
    return { id: data.key, url: siteUrl ? `${siteUrl}/browse/${data.key}` : null };
}

/** Create one Asana task for an action item, in the recipe's configured project. Asana infers
 *  the workspace from the project, so none is sent (avoids a project/workspace mismatch). */
async function createAsanaTask(accessToken: string, payload: CreateTasksPayload, row: LedgerRow): Promise<TicketRef> {
    const projectGid = typeof payload.asanaProjectGid === 'string' ? payload.asanaProjectGid.trim() : '';
    if (!projectGid) throw new Error('No Asana project is configured for this recipe.');

    const data: Record<string, unknown> = {
        name: row.description.slice(0, 250),
        notes: ticketBodyLines(row).join('\n'),
        projects: [projectGid],
    };
    const due = parseDueDate(row.dueDate);
    if (due) data.due_on = due;

    const res = await fetch('https://app.asana.com/api/1.0/tasks', {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ data }),
    });
    const body: { data?: { gid?: string; permalink_url?: string }; errors?: Array<{ message?: string }> } = await res.json().catch(() => ({}));
    if (!res.ok || !body.data?.gid) {
        const detail = body.errors?.map((e) => e.message).filter(Boolean).join('; ') || `Asana returned ${res.status}`;
        throw new Error(detail);
    }
    return { id: body.data.gid, url: body.data.permalink_url ?? null };
}

async function handleCreateTasks(
    db: Db,
    userId: number,
    organisationId: number,
    payload: CreateTasksPayload,
    provider: 'jira' | 'asana',
) {
    const meetingRecordId = Number(payload.meetingRecordId);
    if (!Number.isInteger(meetingRecordId)) {
        return json(400, { error: 'A meeting record id is required to sync its action items.' });
    }

    // Load the ledger rows that still need syncing for this meeting (org-scoped).
    const rows = await db
        .select({ id: actionItems.id, description: actionItems.description, assignee: actionItems.assignee, dueDate: actionItems.dueDate })
        .from(actionItems)
        .where(and(
            eq(actionItems.organisationId, organisationId),
            eq(actionItems.meetingRecordId, meetingRecordId),
            inArray(actionItems.syncStatus, SYNCABLE_STATUSES),
        ));
    if (rows.length === 0) {
        return json(200, { success: true, synced: 0, failed: 0, skipped: 0, total: 0, message: 'No action items awaiting sync.' });
    }

    // Resolve the provider token. Not connected → mark the batch skipped. Tier-1 activation
    // requires the connection, so this only trips on a disconnect between activation and drain.
    let token;
    try {
        token = await getFreshAccessToken(db, organisationId, provider);
    } catch (err) {
        if (err instanceof IntegrationError) {
            await db.update(actionItems)
                .set({ syncStatus: 'skipped', provider, errorMessage: `${provider} not connected at sync time.`, updatedAt: new Date() })
                .where(and(
                    eq(actionItems.meetingRecordId, meetingRecordId),
                    inArray(actionItems.syncStatus, SYNCABLE_STATUSES),
                ));
            return json(200, {
                success: true, synced: 0, failed: 0, skipped: rows.length, total: rows.length,
                message: `${providerLabel(provider)} isn't connected — ${rows.length} action item${rows.length === 1 ? '' : 's'} left unsynced.`,
            });
        }
        throw err;
    }

    // Jira browse links need the connected site URL (stored as the connection label); Asana
    // returns its own permalink, so no lookup is needed there.
    let siteUrl = '';
    if (provider === 'jira') {
        const jiraInt = await getIntegration(db, organisationId, 'jira');
        siteUrl = (jiraInt?.externalAccountName ?? '').replace(/\/+$/, '');
    }
    const endpoint = provider === 'jira'
        ? 'api.atlassian.com/ex/jira/rest/api/3/issue'
        : 'app.asana.com/api/1.0/tasks';

    // File one ticket per action item. A single bad task never blocks the rest: its row is
    // stamped 'failed' (auto-retries on the next job attempt) while the others sync.
    let synced = 0, failed = 0;
    for (const row of rows) {
        try {
            const ticket = provider === 'jira'
                ? await createJiraIssue(token.accessToken, token.tenantId, siteUrl, payload, row)
                : await createAsanaTask(token.accessToken, payload, row);
            await db.update(actionItems).set({
                syncStatus: 'synced', provider, externalTicketId: ticket.id, externalUrl: ticket.url,
                errorMessage: null, syncedAt: new Date(), updatedAt: new Date(),
            }).where(eq(actionItems.id, row.id));
            await logApiCall(db, { userId, integrationId: token.integrationId, endpoint, httpStatus: 200 });
            synced++;
        } catch (e) {
            await db.update(actionItems).set({
                syncStatus: 'failed', provider,
                errorMessage: String((e as Error)?.message ?? 'The task tracker rejected the ticket.').slice(0, 500),
                updatedAt: new Date(),
            }).where(eq(actionItems.id, row.id));
            await logApiCall(db, { userId, integrationId: token.integrationId, endpoint, httpStatus: 502 });
            failed++;
        }
    }

    const message = `${synced} of ${rows.length} action item${rows.length === 1 ? '' : 's'} filed to ${providerLabel(provider)}${failed ? `, ${failed} failed` : ''}.`;
    // Job-level: succeed if anything synced; total failure surfaces as 502 so the job retries.
    return json(synced === 0 && failed > 0 ? 502 : 200, { success: synced > 0, synced, failed, skipped: 0, total: rows.length, message });
}

// ── Action registry ────────────────────────────────────────────────────────────
// One entry per outbound integration action, keyed by actionType. This is the
// "ADAPTERS library" the Integration Scenario Library dispatches through: adding a
// provider action is a one-line registry entry — the HTTP handler below and the
// scenario job processor (process-scenario-jobs.ts) both resolve handlers from here,
// so neither needs editing. All handlers share the (db, userId, organisationId,
// payload) signature and return a json()-shaped response; payloads are untrusted and
// validated inside each handler.

export type ActionResponse = ReturnType<typeof json>;
export type ActionHandler = (
    db: Db,
    userId: number,
    organisationId: number,
    payload: Record<string, unknown>,
) => Promise<ActionResponse>;

export const ACTION_HANDLERS: Record<string, ActionHandler> = {
    hubspot_update_record: handleHubspotUpdate,
    xero_log_note: handleXeroLogNote,
    slack_post_summary: handleSlackPostSummary,
    salesforce_update_record: handleSalesforceUpdate,
    zendesk_add_internal_note: handleZendeskAddNote,
    notion_create_page: handleNotionCreatePage,
    qbo_log_note: handleQboLogNote,
    intercom_add_internal_note: handleIntercomAddNote,
    gmail_create_draft: handleGmailCreateDraft,
    email_meeting_followup: handleEmailMeetingFollowup,
    // Two registry keys, one shared impl — keeps per-provider recipe wiring + audit logs clean.
    jira_create_tasks: (db, userId, orgId, payload) => handleCreateTasks(db, userId, orgId, payload, 'jira'),
    asana_create_tasks: (db, userId, orgId, payload) => handleCreateTasks(db, userId, orgId, payload, 'asana'),
    threads_create_post: handleThreadsCreatePost,
    tiktok_upload_video: handleTiktokUploadVideo,
    youtube_upload_video: handleYoutubeUploadVideo,
};

/** Run an action by key. Shared by the HTTP handler and the scenario job processor.
 *  IntegrationError is normalised to a json() response so both callers can treat the
 *  result uniformly. */
export async function runAction(
    db: Db,
    userId: number,
    organisationId: number,
    actionType: string,
    payload: Record<string, unknown>,
): Promise<ActionResponse> {
    const handlerFn = ACTION_HANDLERS[actionType];
    if (!handlerFn) return json(400, { error: `Unknown actionType "${actionType}".` });
    try {
        return await handlerFn(db, userId, organisationId, payload);
    } catch (err) {
        if (err instanceof IntegrationError) {
            return json(err.statusCode, { error: err.message, code: err.code });
        }
        console.error(`[sync-action] "${actionType}" failed:`, err);
        return json(500, { error: 'The sync failed unexpectedly — please try again.' });
    }
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
    return runAction(db, ctx.userId, ctx.organisationId, body.actionType ?? '', payload);
};
