// src/utils/pm-tickets.ts
// Jira and Asana, as plain HTTP: create a ticket, list projects, ask whether a ticket is done.
//
// Shared by the Meeting Note Taker's action items (netlify/functions/sync-action.ts) and the
// Campaign Assistant's tasks for people (src/utils/campaign-tickets.ts, plan §9.5). Before §9.5
// the create calls lived inside sync-action.ts; two copies of a provider's request shape is how
// one of them learns about a field change and the other silently files broken tickets.
//
// No database, no tokens of its own: callers resolve the token (workspace-integrations.ts
// getFreshAccessToken) and pass it in. Every failure THROWS a readable message — the provider's own
// words where it gives them — except `isTicketDone`, which returns null for "could not tell".

export type PmProvider = 'jira' | 'asana';

export interface TicketRef { id: string; url: string | null }
export interface PmProject { id: string; name: string }

/** Minimal Atlassian Document Format doc — one paragraph per line (empty line → blank para). */
export function adfDoc(lines: string[]): Record<string, unknown> {
    return {
        type: 'doc',
        version: 1,
        content: lines.map((line) => line
            ? { type: 'paragraph', content: [{ type: 'text', text: line }] }
            : { type: 'paragraph', content: [] }),
    };
}

/** Best-effort parse of a free-text due date to YYYY-MM-DD. Returns null for unparseable
 *  phrases ("by Friday") — we never guess a date nobody stated. ISO strings are taken
 *  verbatim and non-ISO values formatted from local parts, so the calendar date never shifts by
 *  a timezone (new Date() parses ISO as UTC but slash/word dates as local). */
export function parseDueDate(raw: string | null | undefined): string | null {
    if (!raw) return null;
    const s = raw.trim();
    const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
    const d = new Date(s);
    if (isNaN(d.getTime())) return null;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export interface TicketInput {
    summary: string;
    /** Body, one paragraph per line. */
    lines: string[];
    dueDate?: string | null;
}

/** Create one Jira issue. Throws with a readable message on rejection. */
export async function createJiraIssue(
    accessToken: string, cloudId: string | null, siteUrl: string,
    project: { projectKey: string; issueType?: string | null }, input: TicketInput,
): Promise<TicketRef> {
    if (!cloudId) throw new Error('Jira site is missing — reconnect Jira.');
    const projectKey = project.projectKey.trim();
    if (!projectKey) throw new Error('No Jira project was chosen.');
    const issueType = project.issueType?.trim() || 'Task';

    const fields: Record<string, unknown> = {
        project: { key: projectKey },
        summary: input.summary.slice(0, 250),
        issuetype: { name: issueType },
        description: adfDoc(input.lines),
    };
    const due = parseDueDate(input.dueDate ?? null);
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
    return { id: data.key, url: siteUrl ? `${siteUrl.replace(/\/+$/, '')}/browse/${data.key}` : null };
}

/** Create one Asana task in a project. Asana infers the workspace from the project, so none is
 *  sent (avoids a project/workspace mismatch). Throws with a readable message on rejection. */
export async function createAsanaTask(accessToken: string, projectGid: string, input: TicketInput): Promise<TicketRef> {
    const gid = projectGid.trim();
    if (!gid) throw new Error('No Asana project was chosen.');
    const data: Record<string, unknown> = {
        name: input.summary.slice(0, 250),
        notes: input.lines.join('\n'),
        projects: [gid],
    };
    const due = parseDueDate(input.dueDate ?? null);
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

/** Projects a ticket can be filed into. Capped — a picker of hundreds is not a picker. */
export async function listJiraProjects(accessToken: string, cloudId: string | null): Promise<PmProject[]> {
    if (!cloudId) throw new Error('Jira site is missing — reconnect Jira.');
    const res = await fetch(`https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/project/search?maxResults=50&orderBy=name`, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    const data: { values?: Array<{ key?: string; name?: string }> } = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Jira returned ${res.status} listing projects`);
    return (data.values ?? []).filter((p) => p.key).map((p) => ({ id: String(p.key), name: String(p.name || p.key) }));
}

export async function listAsanaProjects(accessToken: string): Promise<PmProject[]> {
    const headers = { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' };
    const ws = await fetch('https://app.asana.com/api/1.0/workspaces?limit=10', { headers });
    const wsData: { data?: Array<{ gid?: string; name?: string }> } = await ws.json().catch(() => ({}));
    if (!ws.ok) throw new Error(`Asana returned ${ws.status} listing workspaces`);
    const out: PmProject[] = [];
    for (const w of wsData.data ?? []) {
        if (!w.gid) continue;
        const res = await fetch(`https://app.asana.com/api/1.0/projects?workspace=${encodeURIComponent(w.gid)}&archived=false&limit=50`, { headers });
        const data: { data?: Array<{ gid?: string; name?: string }> } = await res.json().catch(() => ({}));
        if (!res.ok) continue;
        for (const p of data.data ?? []) {
            if (p.gid) out.push({ id: String(p.gid), name: (wsData.data!.length > 1 ? `${w.name} — ` : '') + String(p.name || p.gid) });
        }
        if (out.length >= 100) break;
    }
    return out;
}

/**
 * Is this ticket finished? true / false, or NULL when we could not tell — deleted, no access, a
 * network error. Null is never "not done": the caller leaves the task exactly as it is, because
 * guessing either way would mark work done that is not, or keep a closed ticket open for ever.
 *   Jira: the status CATEGORY is 'done' (names vary per workflow: Done, Closed, Resolved…).
 *   Asana: `completed` is true.
 */
export async function isTicketDone(
    provider: PmProvider, accessToken: string, cloudId: string | null, ticketId: string,
): Promise<boolean | null> {
    try {
        if (provider === 'jira') {
            if (!cloudId) return null;
            const res = await fetch(`https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/issue/${encodeURIComponent(ticketId)}?fields=status`, {
                headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
            });
            if (!res.ok) return null;
            const data: { fields?: { status?: { statusCategory?: { key?: string } } } } = await res.json().catch(() => ({}));
            const cat = data.fields?.status?.statusCategory?.key;
            return cat ? cat === 'done' : null;
        }
        const res = await fetch(`https://app.asana.com/api/1.0/tasks/${encodeURIComponent(ticketId)}?opt_fields=completed`, {
            headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
        });
        if (!res.ok) return null;
        const data: { data?: { completed?: boolean } } = await res.json().catch(() => ({}));
        return typeof data.data?.completed === 'boolean' ? data.data.completed : null;
    } catch {
        return null;
    }
}
