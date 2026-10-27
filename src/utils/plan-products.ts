// src/utils/plan-products.ts
// Be More Swan's own plans, as they appear in its own workspace's Products & Services — kept true to the
// plan settings (master_plans) on every read (owner, 2026-10-27).
//
// ── The failure ──────────────────────────────────────────────────────────────
// The Be More Swan workspace lists its plans as products ("The Busywork Buster", £69). Those rows were
// typed by hand in July, when the Busywork Buster allowed 3 assistants, and never changed with the plan.
// Every assistant reads Products & Services as fact, so blog drafts kept saying "three distinct
// assistants" for a plan that now includes every assistant — twice, because correcting an article
// never touched the row it came from.
//
// ── The rule ─────────────────────────────────────────────────────────────────
// A product row IS a plan when its name is an active plan's name and its link is on bemoreswan.com (no
// other business sells "The Busywork Buster"; the link keeps a namesake elsewhere untouched). For such
// a row, on every read:
//   - price        ← the plan's monthly price
//   - description  ← the plan's description, when it has one
//   - benefits     ← the PLAN FACTS first (assistants, Business Mentor, tasks, AI media), then the
//                    owner's own lines with any stale fact line removed (planFactLine)
// Nothing is written: a plan change is true everywhere the moment it is saved, with no sync to miss.
// Read by loadOrgProducts (every assistant, the post reviewer) and the Products & Services page.

import { eq } from 'drizzle-orm';
import { masterPlans } from '../../db/schema';

type Db = any;

export interface PlanFacts {
    name: string;
    monthlyPriceGbp: string | number | null;
    description: string | null;
    assistantLimit: number | null;
    monthlyTaskLimit: number | null;
    features: Record<string, unknown> | null;
}

/** Pure: is this row one of Be More Swan's own plans? */
export function isPlanProduct(row: { name?: string | null; url?: string | null }, plans: PlanFacts[]): PlanFacts | null {
    if (!row?.url || !/(^|\/\/|\.)bemoreswan\.com(\/|$)/i.test(row.url)) return null;
    const name = String(row.name ?? '').trim().toLowerCase();
    return plans.find((p) => p.name.trim().toLowerCase() === name) ?? null;
}

/**
 * Pure: a benefit line that states a plan fact this module now owns — dropped from the owner's lines so
 * a stale one ("3 Distinct Digital Assistants", "50 AI Media Credits / month") can't sit beside the true one.
 */
export function planFactLine(line: string): boolean {
    return /\bdigital assistants?\b|\bassistants? included\b|\b(\d+|three|two|one|every)\s+(distinct\s+)?(ai\s+)?assistants?\b/i.test(line)
        || /\btasks?\s+(a|per|\/)\s*month\b/i.test(line)
        || /\bmedia credits?\b/i.test(line)
        || /\bfrom your tasks\b/i.test(line)
        || /\bbusiness mentor\b/i.test(line);
}

const price = (v: string | number | null) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return null;
    return `£${Number.isInteger(n) ? n : n.toFixed(2)}`;
};

/** Pure: the plan's facts as benefit lines, in the order a reader compares plans. */
export function planFactLines(p: PlanFacts): string[] {
    const f = p.features ?? {};
    const out: string[] = [];
    out.push(p.assistantLimit == null
        ? 'Every Digital Assistant, with no limit on how many you hire'
        : `${p.assistantLimit} Digital Assistant${p.assistantLimit === 1 ? '' : 's'}`);
    // The Business Mentor is a workspace role: it never takes an assistant slot (assistant-capacity.ts
    // WORKSPACE_ROLE_KEYS), so it is included ON TOP of the assistants above (owner, 2026-10-27).
    if (f.business_mentor === true) out.push('The Business Mentor Assistant included, on top of your other assistants');
    if (p.monthlyTaskLimit != null) out.push(`${Number(p.monthlyTaskLimit).toLocaleString('en-GB')} tasks a month`);
    if (f.ai_video_generation === true) out.push('AI video, images & music from your tasks');
    else if (f.ai_image_generation === true) out.push('AI images & music from your tasks');
    return out;
}

/** Pure: the row as the plan says it is. Rows that aren't plans come back unchanged. */
export function withPlanFacts<T extends { name?: string | null; url?: string | null; description?: string | null; benefits?: string | null; price?: string | null }>(row: T, plans: PlanFacts[]): T {
    const plan = isPlanProduct(row, plans);
    if (!plan) return row;
    const own = String(row.benefits ?? '').split('\n').map((l) => l.trim()).filter((l) => l && !planFactLine(l));
    return {
        ...row,
        price: price(plan.monthlyPriceGbp) ?? row.price ?? null,
        description: plan.description?.trim() || row.description || null,
        benefits: [...planFactLines(plan), ...own].join('\n'),
    };
}

/** The active plans. [] on failure: rows then read as written, never break the caller. */
export async function loadPlanFacts(db: Db): Promise<PlanFacts[]> {
    try {
        const rows = await db.select({
            name: masterPlans.name, monthlyPriceGbp: masterPlans.monthlyPriceGbp, description: masterPlans.description,
            assistantLimit: masterPlans.assistantLimit, monthlyTaskLimit: masterPlans.monthlyTaskLimit, features: masterPlans.features,
        }).from(masterPlans).where(eq(masterPlans.isActive, true));
        return rows.map((r: any) => ({ ...r, features: (r.features as Record<string, unknown> | null) ?? null }));
    } catch (err) {
        console.error('[plan-products] could not read plans (rows read as written):', (err as Error)?.message ?? err);
        return [];
    }
}

/** Apply to a list — the plans are read only when a row could be one (a bemoreswan.com link). */
export async function applyPlanFacts<T extends { name?: string | null; url?: string | null; description?: string | null; benefits?: string | null; price?: string | null }>(db: Db, rows: T[]): Promise<T[]> {
    if (!rows.some((r) => r?.url && /bemoreswan\.com/i.test(r.url))) return rows;
    const plans = await loadPlanFacts(db);
    return plans.length ? rows.map((r) => withPlanFacts(r, plans)) : rows;
}
