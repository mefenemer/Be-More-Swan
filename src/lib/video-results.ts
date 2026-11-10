// src/lib/video-results.ts
//
// The Video Producer's Results tab. It is a studio — it never posts — so the post-engagement KPIs it
// inherited (reach, engagement, clicks) could only ever say "nothing published". These four measure
// what a studio does instead:
//   · Videos made           — finished videos (Ready, plus the old-way 'built' ones)
//   · Made without changes  — of the videos it planned, the share made exactly as planned: no scene
//                             edited, not planned again, script not rewritten, and no new version after
//   · Average turnaround    — from the brief to the finished file, for videos made in the last 90 days
//   · Used in posts & articles — how many times a finished video was put in a post or a blog article
//
// PURE. Tested in tests/video-producer-seven.test.ts.

export interface ResultRow {
    id: number;
    status: string;
    version: number;
    editCount: number;
    parentProjectId: number | null;
    /** Another shape of an earlier video (brief.shapeOf) — not a planning decision of its own. */
    shapeCopy: boolean;
    createdAt: Date;
    /** When its finished file was saved (the output asset's createdAt), if it has one. */
    readyAt: Date | null;
}

export interface VideoResults {
    made: number;
    madeWithoutChanges: number | null;   // 0..1, null until a video has been made
    avgTurnaroundMin: number | null;
    timesUsed: number;
}

export const TURNAROUND_WINDOW_DAYS = 90;

export function videoResults(rows: ResultRow[], timesUsed: number, now = new Date()): VideoResults {
    const done = rows.filter((r) => r.status === 'ready' || r.status === 'built');
    // A new version after it means it was changed; another shape of it does not.
    const parents = new Set(rows.filter((r) => !r.shapeCopy).map((r) => r.parentProjectId).filter((x): x is number => x != null));
    // A decision on a plan: first versions that were made, never shape copies.
    const planned = done.filter((r) => !r.shapeCopy && (r.version ?? 1) === 1);
    const untouched = planned.filter((r) => (r.editCount ?? 0) === 0 && !parents.has(r.id));
    const since = now.getTime() - TURNAROUND_WINDOW_DAYS * 86400_000;
    const turns = done
        .filter((r) => r.readyAt && r.readyAt.getTime() >= since && r.readyAt.getTime() > r.createdAt.getTime())
        .map((r) => (r.readyAt!.getTime() - r.createdAt.getTime()) / 60000);
    return {
        made: done.length,
        madeWithoutChanges: planned.length ? Math.round((untouched.length / planned.length) * 100) / 100 : null,
        avgTurnaroundMin: turns.length ? Math.round(turns.reduce((a, b) => a + b, 0) / turns.length) : null,
        timesUsed: Math.max(0, timesUsed),
    };
}

/** "35 min", "3 h 10 min", "2 days". Pure. */
export function turnaroundText(min: number | null): string {
    if (min == null) return '—';
    if (min < 60) return `${Math.max(1, Math.round(min))} min`;
    if (min < 48 * 60) { const h = Math.floor(min / 60); const m = Math.round(min % 60); return m ? `${h} h ${m} min` : `${h} h`; }
    return `${Math.round(min / 1440)} days`;
}
