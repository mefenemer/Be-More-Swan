// src/utils/campaign-tickets.ts
// A campaign's task for a person, filed as a ticket in the business's own Jira or Asana — and
// finished when that ticket closes. Plan §9.5, the "automatic half".
//
// ── What it does ────────────────────────────────────────────────────────────────────────────────
// • FILE: a task (request_human_task) becomes a Jira issue / Asana task in a project the user
//   chose. The ticket reference is kept on the order's brief (`brief.ticket`). A project chosen
//   with "remember" is stored per workspace in the integration's metadata, so the next task can
//   be filed — and a chat plan can ask for one to be filed — without picking again.
// • CLOSE: the hourly reconciler asks each open task's ticket whether it is done. Done → the task
//   is delivered, which RELEASES whatever work was waiting on it (§9.5 chaining). That is the whole
//   point: "waiting on Legal" ends when Legal closes their ticket, not when someone remembers to
//   come back and press Mark done.
//
// ── Rules ───────────────────────────────────────────────────────────────────────────────────────
// • The ticket goes to the business's OWN tool, through a connection they made. It is not a
//   message to the person — nothing here emails or messages anyone.
// • Polling, not webhooks: a webhook needs registering per tenant per provider and a public
//   endpoint that trusts their payloads. An hourly read of a few open tickets is simpler, survives
//   a missed delivery, and is all a task measured in days needs.
// • "Could not tell" (deleted ticket, disconnected tool) is never "done": the task stays open and
//   the row says so. Marking work done that is not would start the work waiting behind it.

import { and, eq, inArray, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { campaignOrders, campaigns, workspaceIntegrations } from '../../db/schema';
import { getFreshAccessToken, getIntegration, IntegrationError, providerLabel } from './workspace-integrations';
import {
    createAsanaTask, createJiraIssue, isTicketDone, listAsanaProjects, listJiraProjects,
    type PmProject, type PmProvider,
} from './pm-tickets';

type Db = ReturnType<typeof getDb>;

export const PM_PROVIDERS: readonly PmProvider[] = ['jira', 'asana'];
/** How often one ticket is asked about. The reconciler runs hourly; this stops a re-run re-asking. */
export const TICKET_CHECK_MINUTES = 50;

export interface TaskTicket {
    provider: PmProvider; id: string; url: string | null;
    project: string; projectName: string | null; filedAt: string; checkedAt?: string;
}

export const isPmProvider = (v: unknown): v is PmProvider => v === 'jira' || v === 'asana';

/** The project a workspace said to file campaign tasks into, per provider. */
function rememberedProject(metadata: unknown, provider: PmProvider): { id: string; name: string | null } | null {
    const m = (metadata ?? {}) as { campaignTaskProject?: Record<string, { id?: string; name?: string }> };
    const p = m.campaignTaskProject?.[provider];
    return p?.id ? { id: String(p.id), name: p.name ? String(p.name) : null } : null;
}

/**
 * What the "File in…" picker can offer: each connected tool, its projects, and the remembered one.
 * A tool that is not connected is listed with connected:false so the UI can say where to connect
 * it, rather than hiding the option and leaving the user to wonder.
 */
export async function ticketOptions(db: Db, organisationId: number) {
    const out = [];
    for (const provider of PM_PROVIDERS) {
        const row = await getIntegration(db, organisationId, provider);
        if (!row || row.status !== 'active') {
            out.push({ provider, label: providerLabel(provider), connected: false, projects: [] as PmProject[], defaultProject: null, error: null as string | null });
            continue;
        }
        let projects: PmProject[] = [];
        let error: string | null = null;
        try {
            const token = await getFreshAccessToken(db, organisationId, provider);
            projects = provider === 'jira'
                ? await listJiraProjects(token.accessToken, token.tenantId)
                : await listAsanaProjects(token.accessToken);
        } catch (err) {
            error = err instanceof Error ? err.message : `Could not read your ${providerLabel(provider)} projects.`;
        }
        out.push({ provider, label: providerLabel(provider), connected: true, projects, defaultProject: rememberedProject(row.metadata, provider), error });
    }
    return out;
}

/**
 * File one task as a ticket. Returns the ticket, or throws a sentence the UI can show.
 * Refuses a second ticket for the same task: two tickets for one job is two people doing it.
 */
export async function fileTaskTicket(db: Db, input: {
    organisationId: number; orderId: number; provider: PmProvider;
    projectId?: string | null; projectName?: string | null; remember?: boolean;
}): Promise<TaskTicket> {
    const [order] = await db.select({
        id: campaignOrders.id, action: campaignOrders.action, status: campaignOrders.status,
        brief: campaignOrders.brief, campaignId: campaignOrders.campaignId,
    }).from(campaignOrders)
        .where(and(eq(campaignOrders.id, input.orderId), eq(campaignOrders.organisationId, input.organisationId)))
        .limit(1);
    if (!order || order.action !== 'request_human_task') throw new Error('Task not found.');
    if (!['queued', 'issued', 'blocked'].includes(order.status)) throw new Error('This task is already settled.');
    const brief = (order.brief ?? {}) as Record<string, unknown>;
    if (brief.ticket) throw new Error('This task already has a ticket.');

    const integration = await getIntegration(db, input.organisationId, input.provider);
    if (!integration || integration.status !== 'active') {
        throw new Error(`${providerLabel(input.provider)} is not connected — connect it on the Integrations page first.`);
    }
    const remembered = rememberedProject(integration.metadata, input.provider);
    const projectId = (input.projectId ?? '').trim() || remembered?.id || '';
    const projectName = (input.projectName ?? '').trim() || (projectId === remembered?.id ? remembered?.name ?? null : null);
    if (!projectId) throw new Error(`Choose which ${providerLabel(input.provider)} project to file it in.`);

    const [campaign] = await db.select({ objective: campaigns.objective }).from(campaigns)
        .where(eq(campaigns.id, order.campaignId)).limit(1);
    const who = typeof brief.assignee === 'string' ? brief.assignee : null;
    const task = typeof brief.task === 'string' && brief.task.trim() ? brief.task.trim() : 'Campaign task';
    const due = typeof brief.dueDate === 'string' ? brief.dueDate : null;
    const lines = [
        ...(who ? [`For: ${who}`] : []),
        ...(due ? [`Due: ${due}`] : []),
        '',
        `Part of the campaign "${(campaign?.objective ?? '').slice(0, 200)}".`,
        'Close this ticket when it is done — the campaign notices within the hour and starts any work that was waiting on it.',
    ];

    let token;
    try {
        token = await getFreshAccessToken(db, input.organisationId, input.provider);
    } catch (err) {
        if (err instanceof IntegrationError) throw new Error(`${providerLabel(input.provider)} needs reconnecting before tickets can be filed.`);
        throw err;
    }
    const ref = input.provider === 'jira'
        ? await createJiraIssue(token.accessToken, token.tenantId, (integration.externalAccountName ?? '').replace(/\/+$/, ''),
            { projectKey: projectId }, { summary: task, lines, dueDate: due })
        : await createAsanaTask(token.accessToken, projectId, { summary: task, lines, dueDate: due });

    const ticket: TaskTicket = {
        provider: input.provider, id: ref.id, url: ref.url, project: projectId, projectName,
        filedAt: new Date().toISOString(),
    };
    await db.update(campaignOrders)
        .set({ brief: sql`${campaignOrders.brief} || ${JSON.stringify({ ticket })}::jsonb`, updatedAt: new Date() })
        .where(eq(campaignOrders.id, order.id));

    if (input.remember) {
        // MERGED into the integration's metadata, never replacing it — other features keep things there.
        await db.update(workspaceIntegrations)
            .set({
                metadata: sql`coalesce(${workspaceIntegrations.metadata}, '{}'::jsonb)
                    || jsonb_build_object('campaignTaskProject',
                         coalesce(${workspaceIntegrations.metadata} -> 'campaignTaskProject', '{}'::jsonb)
                         || jsonb_build_object(${input.provider}::text, jsonb_build_object('id', ${projectId}::text, 'name', ${projectName ?? ''}::text)))`,
                updatedAt: new Date(),
            })
            .where(eq(workspaceIntegrations.id, integration.id));
    }
    return ticket;
}

/**
 * Ask each open task's ticket whether it is done (called by the reconciler, hourly). A done ticket
 * settles its task through `settle` — the reconciler's own settlement, passed in so this module
 * does not import the reconciler (which imports this). Never throws.
 */
export async function checkTaskTickets(
    db: Db,
    settle: (orderId: number, summary: string) => Promise<boolean>,
    limit = 100,
): Promise<{ checked: number; closed: number }> {
    let checked = 0;
    let closed = 0;
    try {
        const open = await db.select({ id: campaignOrders.id, organisationId: campaignOrders.organisationId, brief: campaignOrders.brief })
            .from(campaignOrders)
            .where(and(
                eq(campaignOrders.action, 'request_human_task'),
                // Only a task that is actually waiting on its person. A blocked one has not started;
                // a ticket closed early must not leapfrog the work it was meant to come after.
                inArray(campaignOrders.status, ['issued']),
                sql`${campaignOrders.brief} ? 'ticket'`,
                sql`(${campaignOrders.brief} -> 'ticket' ->> 'checkedAt' IS NULL
                     OR (${campaignOrders.brief} -> 'ticket' ->> 'checkedAt')::timestamptz
                        < now() - (${TICKET_CHECK_MINUTES} || ' minutes')::interval)`,
            ))
            .limit(limit);

        // One token per (org, provider) per run, not per ticket.
        const tokens = new Map<string, { accessToken: string; tenantId: string | null } | null>();
        for (const o of open) {
            const t = ((o.brief ?? {}) as { ticket?: TaskTicket }).ticket;
            if (!t || !isPmProvider(t.provider)) continue;
            const key = `${o.organisationId}:${t.provider}`;
            if (!tokens.has(key)) {
                try {
                    const tok = await getFreshAccessToken(db, o.organisationId, t.provider);
                    tokens.set(key, { accessToken: tok.accessToken, tenantId: tok.tenantId });
                } catch { tokens.set(key, null); }
            }
            const tok = tokens.get(key);
            checked++;
            const done = tok ? await isTicketDone(t.provider, tok.accessToken, tok.tenantId, t.id) : null;
            if (done === true) {
                if (await settle(o.id, `Done — ${providerLabel(t.provider)} ticket ${t.id} was closed`)) closed++;
                continue;
            }
            // Stamp the check either way, so the next run does not re-ask within the hour. A null
            // ("could not tell") is recorded too — the row shows when we last managed to look.
            await db.update(campaignOrders)
                .set({
                    brief: sql`jsonb_set(${campaignOrders.brief}, '{ticket,checkedAt}', to_jsonb(now()::text))
                        || jsonb_build_object('ticketReachable', ${done !== null}::boolean)`,
                    updatedAt: new Date(),
                })
                .where(eq(campaignOrders.id, o.id));
        }
    } catch (err) {
        console.error('[campaign-tickets] ticket check failed (non-fatal)', err);
    }
    return { checked, closed };
}
