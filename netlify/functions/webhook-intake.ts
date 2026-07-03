// webhook-intake.ts — inbound webhook intake for trigger-style connectors.
// GET/POST  /.netlify/functions/webhook-intake?provider=slack|zendesk
//
// Verifies the provider signature over the RAW body, handles Slack's URL-verification
// handshake, dedups against provider retries (dedupKey), persists the event as
// 'received', and acks fast (200). A downstream processor consumes 'received' rows and
// must apply the connection-map sandbox (isServiceAllowedForAssistant) before acting.
// No connectors are wired yet — this is the intake layer the connectors plug into.

import { Handler } from '@netlify/functions';
import { createHash } from 'crypto';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { webhookEvents, systemConnections } from '../../db/schema';
import { verifySlackSignature, verifyZendeskSignature } from '../../src/utils/webhook-verify';

const ok = (body: unknown = { ok: true }) => ({ statusCode: 200, body: typeof body === 'string' ? body : JSON.stringify(body) });
const SUPPORTED = ['slack', 'zendesk'] as const;
type Provider = typeof SUPPORTED[number];

export const handler: Handler = async (event) => {
    const provider = (event.queryStringParameters?.provider || '').toLowerCase() as Provider;
    if (!SUPPORTED.includes(provider)) return { statusCode: 404, body: 'Unknown provider' };

    // Signatures must be computed over the exact bytes received.
    const rawBody = event.isBase64Encoded && event.body
        ? Buffer.from(event.body, 'base64').toString('utf8')
        : (event.body || '');
    const h = event.headers || {};

    // ── Verify signature ──────────────────────────────────────────────────────
    let verified = false;
    if (provider === 'slack') {
        verified = verifySlackSignature({
            signingSecret: process.env.SLACK_SIGNING_SECRET,
            timestamp: h['x-slack-request-timestamp'],
            signature: h['x-slack-signature'],
            rawBody,
        });
    } else if (provider === 'zendesk') {
        verified = verifyZendeskSignature({
            secret: process.env.ZENDESK_WEBHOOK_SECRET,
            timestamp: h['x-zendesk-webhook-signature-timestamp'],
            signature: h['x-zendesk-webhook-signature'],
            rawBody,
        });
    }
    if (!verified) return { statusCode: 401, body: 'Invalid signature' };

    let payload: Record<string, any> = {};
    try { payload = rawBody ? JSON.parse(rawBody) : {}; } catch { /* non-JSON payloads kept as {} */ }

    // Slack URL-verification handshake (after signature check) — echo the challenge.
    if (provider === 'slack' && payload.type === 'url_verification' && payload.challenge) {
        return { statusCode: 200, headers: { 'Content-Type': 'text/plain' }, body: String(payload.challenge) };
    }

    // ── Dedup key + event type ────────────────────────────────────────────────
    const hashBody = () => createHash('sha256').update(rawBody).digest('hex').slice(0, 32);
    let externalId: string;
    let eventType: string | null;
    if (provider === 'slack') {
        externalId = payload.event_id || hashBody();
        eventType = payload.event?.type || payload.type || null;
    } else {
        externalId = (h['x-zendesk-webhook-id'] as string) || hashBody();
        eventType = payload.type || null;
    }
    const dedupKey = `${provider}:${externalId}`;

    // ── Best-effort org/connection resolution (null until connectors are wired) ─
    let organisationId: number | null = null;
    let connectionId: number | null = null;
    const identifier = provider === 'slack' ? (payload.team_id || payload.team?.id) : (payload.subdomain || payload.account?.subdomain);
    if (identifier) {
        try {
            const db0 = getDb();
            const [conn] = await db0.select({ id: systemConnections.id, organisationId: systemConnections.organisationId })
                .from(systemConnections)
                .where(and(eq(systemConnections.serviceName, provider), eq(systemConnections.externalUserId, String(identifier))))
                .limit(1);
            if (conn) { connectionId = conn.id; organisationId = conn.organisationId ?? null; }
        } catch { /* non-fatal — store unresolved */ }
    }

    // ── Persist (idempotent) + fast ack ───────────────────────────────────────
    try {
        const db = getDb();
        const inserted = await db.insert(webhookEvents).values({
            provider, organisationId, connectionId, eventType, dedupKey, payload, status: 'received',
        }).onConflictDoNothing({ target: webhookEvents.dedupKey }).returning({ id: webhookEvents.id });
        // Empty result = duplicate delivery; ack so the provider stops retrying.
        return ok({ ok: true, duplicate: inserted.length === 0 });
    } catch (err) {
        console.error('[webhook-intake] persist failed:', err);
        // Still 200: a 5xx makes the provider retry a poison payload indefinitely.
        return ok({ ok: false });
    }
};
