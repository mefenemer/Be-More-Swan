// process-webhook-events.ts — downstream consumer for the webhook intake layer.
// Scheduled (see netlify.toml) and also POST-invokable for manual draining.
//
// For each `received` event: claim it atomically, resolve the owning assistant (via the
// connection's assistantId), enforce the connection-map sandbox
// (isServiceAllowedForAssistant) BEFORE any handler runs, then dispatch to the
// provider/eventType handler. No connectors are wired yet, so unhandled events are marked
// 'ignored' — connectors plug in by adding a handler to WEBHOOK_HANDLERS.

import { Handler } from '@netlify/functions';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { webhookEvents, systemConnections } from '../../db/schema';
import { isServiceAllowedForAssistant } from '../../src/utils/connection-map';
import { resolveAssistantRole } from '../../src/utils/assistant-role';

const BATCH = 50;

type WebhookEvent = typeof webhookEvents.$inferSelect;

// Connector handlers register here, keyed by provider. A handler only runs AFTER the
// sandbox check passes. Throw to mark the event 'failed' (kept for inspection/retry).
const WEBHOOK_HANDLERS: Record<string, (event: WebhookEvent) => Promise<void>> = {
    // slack:   async (event) => { ... },
    // zendesk: async (event) => { ... },
};

async function finish(db: ReturnType<typeof getDb>, id: number, status: 'processed' | 'ignored' | 'failed', error?: string) {
    await db.update(webhookEvents)
        .set({ status, error: error ?? null, processedAt: new Date() })
        .where(eq(webhookEvents.id, id));
}

export const handler: Handler = async () => {
    const db = getDb();

    const pending = await db.select().from(webhookEvents)
        .where(eq(webhookEvents.status, 'received'))
        .orderBy(webhookEvents.receivedAt)
        .limit(BATCH);

    let processed = 0, ignored = 0, failed = 0;

    for (const ev of pending) {
        // Atomic claim — only one runner may move a row out of 'received'.
        const claimed = await db.update(webhookEvents)
            .set({ status: 'processing' })
            .where(and(eq(webhookEvents.id, ev.id), eq(webhookEvents.status, 'received')))
            .returning({ id: webhookEvents.id });
        if (claimed.length === 0) continue; // another runner took it

        try {
            // Route to the owning assistant via the connection.
            if (!ev.connectionId) { await finish(db, ev.id, 'ignored', 'no_connection'); ignored++; continue; }
            const [conn] = await db.select({
                assistantId: systemConnections.assistantId,
                organisationId: systemConnections.organisationId,
            }).from(systemConnections).where(eq(systemConnections.id, ev.connectionId)).limit(1);

            if (!conn?.assistantId) { await finish(db, ev.id, 'ignored', 'no_assistant'); ignored++; continue; }

            // Sandbox: the assistant's role must permit this provider's connection.
            const assistant = await resolveAssistantRole(db, conn.organisationId, conn.assistantId);
            if (!assistant || !isServiceAllowedForAssistant(ev.provider, assistant)) {
                await finish(db, ev.id, 'ignored', 'sandbox_denied'); ignored++; continue;
            }

            const handlerFn = WEBHOOK_HANDLERS[ev.provider];
            if (!handlerFn) { await finish(db, ev.id, 'ignored', 'no_handler'); ignored++; continue; }

            await handlerFn(ev);
            await finish(db, ev.id, 'processed'); processed++;
        } catch (err) {
            console.error(`[process-webhook-events] event ${ev.id} failed:`, err);
            await finish(db, ev.id, 'failed', (err as Error)?.message?.slice(0, 500) ?? 'error'); failed++;
        }
    }

    return { statusCode: 200, body: JSON.stringify({ claimed: pending.length, processed, ignored, failed }) };
};
