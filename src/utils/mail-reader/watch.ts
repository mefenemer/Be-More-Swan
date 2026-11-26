// src/utils/mail-reader/watch.ts — asking the provider to tell us when new mail arrives (plan §4.2–4.3,
// Phase 3b). The provider calls; src/utils/mailbox-push.ts decides when, and the webhooks
// (mail-push-gmail.ts, mail-push-graph.ts) receive what they send.
//
// Gmail: users.watch on the INBOX label → Google publishes `{ emailAddress, historyId }` to our Pub/Sub
//        topic, which pushes it to mail-push-gmail.ts. A watch lasts 7 days; calling watch again renews it.
//        No id, and one watch per Google ACCOUNT: we never call users.stop (see mailbox-push.ts stopWatch).
// Graph: a subscription on the Inbox's messages (new mail only) → Graph POSTs the subscription id and our
//        clientState to mail-push-graph.ts. At most 10,080 minutes for mail; PATCH renews it.
//
// Neither notification carries any of the email: the background reader fetches what changed as before.

import { GmailError } from './gmail';
import { GraphError } from './graph';

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const GRAPH = 'https://graph.microsoft.com/v1.0';

/** How long a new or renewed Graph subscription lasts: 6 days (Graph allows up to 7 for mail). */
export const GRAPH_SUBSCRIPTION_MINUTES = 6 * 24 * 60;
/** The Graph resource watched: the Inbox's messages. */
export const GRAPH_INBOX_RESOURCE = "me/mailFolders('inbox')/messages";

async function call(url: string, token: string, method: string, body: unknown, kind: 'gmail' | 'graph'): Promise<Record<string, unknown>> {
    const res = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
        const retry = Number(res.headers.get('retry-after'));
        const r = Number.isFinite(retry) && retry > 0 ? retry : null;
        throw kind === 'gmail' ? new GmailError(res.status, `Gmail ${res.status}`, r) : new GraphError(res.status, `Graph ${res.status}`, r);
    }
    if (res.status === 204) return {};
    const text = await res.text();
    return text ? JSON.parse(text) as Record<string, unknown> : {};
}

/** Start (or renew) the Gmail watch on the INBOX. Returns when it expires. */
export async function startGmailWatch(token: string, topicName: string): Promise<{ expiresAt: Date }> {
    const data = await call(`${GMAIL}/watch`, token, 'POST', { topicName, labelIds: ['INBOX'] }, 'gmail');
    const ms = Number(data.expiration);
    // Gmail says 7 days; if the reply has no usable expiry, assume a day so renewal comes round soon.
    return { expiresAt: new Date(Number.isFinite(ms) && ms > Date.now() ? ms : Date.now() + 86_400_000) };
}

/** The expiry to ask Graph for, as Graph wants it. Pure. */
export function graphExpiry(now: Date = new Date()): string {
    return new Date(now.getTime() + GRAPH_SUBSCRIPTION_MINUTES * 60_000).toISOString();
}

/**
 * Create a Graph subscription on the Inbox. Graph checks both URLs with a validation request before it
 * answers, so mail-push-graph.ts must already be deployed on this site.
 */
export async function createGraphSubscription(token: string, opts: { notificationUrl: string; clientState: string; now?: Date }):
    Promise<{ id: string; expiresAt: Date }> {
    const data = await call(`${GRAPH}/subscriptions`, token, 'POST', {
        changeType: 'created',
        notificationUrl: opts.notificationUrl,
        lifecycleNotificationUrl: opts.notificationUrl,
        resource: GRAPH_INBOX_RESOURCE,
        expirationDateTime: graphExpiry(opts.now),
        clientState: opts.clientState,
    }, 'graph');
    const id = typeof data.id === 'string' ? data.id : '';
    if (!id) throw new GraphError(502, 'Graph subscription has no id');
    return { id, expiresAt: new Date(String(data.expirationDateTime ?? graphExpiry(opts.now))) };
}

/** Renew a Graph subscription. A 404 means it is gone: the caller creates a new one. */
export async function renewGraphSubscription(token: string, id: string, now: Date = new Date()): Promise<{ expiresAt: Date }> {
    const data = await call(`${GRAPH}/subscriptions/${encodeURIComponent(id)}`, token, 'PATCH', { expirationDateTime: graphExpiry(now) }, 'graph');
    return { expiresAt: new Date(String(data.expirationDateTime ?? graphExpiry(now))) };
}

/** Delete a Graph subscription. Best effort. */
export async function deleteGraphSubscription(token: string, id: string): Promise<void> {
    await call(`${GRAPH}/subscriptions/${encodeURIComponent(id)}`, token, 'DELETE', undefined, 'graph');
}
