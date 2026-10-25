// src/utils/mentor-activity.ts
// Admin ▸ Assistants ▸ Business Mentor ▸ Activity (docs/business-mentor-plan.md §8.2): the four success
// measures, per workspace and in total. Admin only (admin-assistants.ts ?mentorActivity=1).
//
//   1. Is the advice any good?       suggestions accepted ÷ suggestions shown (mentor_proposals)
//   2. Is it getting people set up?  Business Information gaps closed through its cards (accepted gap kinds)
//   3. Does it make a difference?    goals that moved after an accepted suggestion — Phase 3 (§5.3), so null
//   4. Does it keep people?          workspaces with a login 30+ days after they first chatted with it
//
// "Met the Mentor" = its first chat session in that workspace. With a handful of workspaces these are
// read case by case: no targets, no percentages dressed up as statistics beyond the one ratio.

import { sql } from 'drizzle-orm';

type Db = any;

/** Suggestion kinds that fill a Business Information gap (mentor-cards.ts proposalKind). */
export const GAP_KINDS = ['business_info_gap', 'products_gap'] as const;

export interface MentorActivityRow {
    organisationId: number;
    workspace: string;
    metAt: string | null;
    shown: number;
    accepted: number;
    dismissed: number;
    reasons: Record<string, number>;
    gapsClosed: number;
    supportRaised: number;
    /** null = met less than 30 days ago (or never), so it can't be judged yet. */
    retained30: boolean | null;
}

export interface MentorActivity {
    measures: {
        acceptance: { accepted: number; shown: number; rate: number | null };
        gapsClosed: number;
        goalsMoved: null;
        retention: { retained: number; eligible: number };
    };
    workspaces: MentorActivityRow[];
}

/** Pure: the totals at the top of the screen, from the per-workspace rows. */
export function summariseMentorActivity(rows: MentorActivityRow[]): MentorActivity['measures'] {
    const sum = (f: (r: MentorActivityRow) => number) => rows.reduce((n, r) => n + f(r), 0);
    const shown = sum((r) => r.shown);
    const accepted = sum((r) => r.accepted);
    const eligible = rows.filter((r) => r.retained30 !== null);
    return {
        acceptance: { accepted, shown, rate: shown ? accepted / shown : null },
        gapsClosed: sum((r) => r.gapsClosed),
        goalsMoved: null,
        retention: { retained: eligible.filter((r) => r.retained30).length, eligible: eligible.length },
    };
}

/** Pure: the most common dismiss reason, or null. */
export function topReason(reasons: Record<string, number>): string | null {
    const best = Object.entries(reasons).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    return best && best[1] > 0 ? best[0] : null;
}

/** Every workspace that has a Mentor, with its figures. */
export async function loadMentorActivity(db: Db): Promise<MentorActivity> {
    const result = await db.execute(sql`
        WITH mentors AS (
            SELECT a.organisation_id, min(a.id) AS assistant_id
            FROM ai_assistants a
            WHERE a.configuration ->> 'type' = 'business_mentor'
            GROUP BY a.organisation_id
        ),
        met AS (
            SELECT m.organisation_id, min(cs.created_at) AS met_at
            FROM mentors m JOIN chat_sessions cs ON cs.ai_assistant_id = m.assistant_id
            GROUP BY m.organisation_id
        ),
        props AS (
            SELECT organisation_id,
                   count(*)::int AS shown,
                   count(*) FILTER (WHERE status = 'accepted')::int AS accepted,
                   count(*) FILTER (WHERE status = 'dismissed')::int AS dismissed,
                   count(*) FILTER (WHERE status = 'accepted' AND kind IN ('business_info_gap', 'products_gap'))::int AS gaps_closed,
                   coalesce(jsonb_object_agg(dismiss_reason, n) FILTER (WHERE dismiss_reason IS NOT NULL), '{}'::jsonb) AS reasons
            FROM (
                SELECT p.*, count(*) OVER (PARTITION BY organisation_id, dismiss_reason) AS n
                FROM mentor_proposals p
            ) p
            GROUP BY organisation_id
        ),
        support AS (
            SELECT organisation_id, count(*)::int AS n FROM (
                SELECT organisation_id FROM support_tickets WHERE category = 'Business Mentor'
                UNION ALL
                SELECT organisation_id FROM issue_reports WHERE source_location = 'Business Mentor chat'
            ) s GROUP BY organisation_id
        )
        SELECT m.organisation_id, o.name AS workspace, met.met_at::text AS met_at,
               coalesce(p.shown, 0) AS shown, coalesce(p.accepted, 0) AS accepted, coalesce(p.dismissed, 0) AS dismissed,
               coalesce(p.gaps_closed, 0) AS gaps_closed, coalesce(p.reasons, '{}'::jsonb) AS reasons,
               coalesce(s.n, 0) AS support_raised,
               CASE WHEN met.met_at IS NULL OR met.met_at > now() - interval '30 days' THEN NULL
                    ELSE EXISTS (
                        SELECT 1 FROM login_events le JOIN user_organisations uo ON uo.user_id = le.user_id
                        WHERE uo.organisation_id = m.organisation_id AND le.created_at >= met.met_at + interval '30 days'
                    ) END AS retained30
        FROM mentors m
        JOIN organisations o ON o.id = m.organisation_id
        LEFT JOIN met ON met.organisation_id = m.organisation_id
        LEFT JOIN props p ON p.organisation_id = m.organisation_id
        LEFT JOIN support s ON s.organisation_id = m.organisation_id
        ORDER BY met.met_at NULLS LAST, o.name`);
    const rows = (Array.isArray(result) ? result : result?.rows ?? []) as any[];
    const workspaces: MentorActivityRow[] = rows.map((r) => ({
        organisationId: Number(r.organisation_id),
        workspace: String(r.workspace ?? ''),
        metAt: r.met_at ?? null,
        shown: Number(r.shown), accepted: Number(r.accepted), dismissed: Number(r.dismissed),
        reasons: Object.fromEntries(Object.entries(r.reasons ?? {}).map(([k, v]) => [k, Number(v)])),
        gapsClosed: Number(r.gaps_closed), supportRaised: Number(r.support_raised),
        retained30: r.retained30 === null || r.retained30 === undefined ? null : !!r.retained30,
    }));
    return { measures: summariseMentorActivity(workspaces), workspaces };
}
