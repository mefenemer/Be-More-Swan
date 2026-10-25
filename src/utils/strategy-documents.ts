// src/utils/strategy-documents.ts
// The Business Mentor's strategy documents (docs/business-mentor-plan.md §4.1, §4.2, §4.4): the idea
// check (interview answers, Lean Canvas, riskiest assumptions), the business plan and the marketing
// plan, over the strategy_documents table (db/z-business-mentor-phase-2.sql).
//
// Versioned. Each kind has at most ONE draft (the working copy, edited in place) and ONE approved
// version. Approving the draft makes it the approved version and the old approved one "superseded"
// (kept, listed under "Earlier versions"). Nothing is ever approved without a person's click.
//
// ONE server action per capability (mentor.ts): the Plan tab's form, canvas, Save draft and Approve,
// and the chat's strategy_proposal card (mentor-cards.ts → mentor-apply.js) all call saveStrategyDraft /
// approveStrategyDraft here. Approval recompiles every blueprint in the workspace, because approved
// documents reach drafting through src/utils/business-knowledge.ts (the one loader).
//
// ⚠️ Tolerates the table being missing (the SQL is applied by hand on each database): reads return
// "not ready", writes refuse with a plain message.

import { and, desc, eq, sql } from 'drizzle-orm';
import { getGoalMetric } from '../config/goal-metrics';
import { aiAssistants, goals, masterAssistants, organisations, orgOfferProfile, orgProducts, strategyDocuments } from '../../db/schema';

type Db = any;

export const STRATEGY_KIND_KEYS = ['idea_check', 'business_plan', 'marketing_plan'] as const;
export type StrategyKind = typeof STRATEGY_KIND_KEYS[number];
export const isStrategyKind = (v: unknown): v is StrategyKind => typeof v === 'string' && (STRATEGY_KIND_KEYS as readonly string[]).includes(v);

export interface SectionDef {
    key: string;
    label: string;
    /** The question or hint shown under the label on the Plan tab. */
    hint: string;
    max: number;
    /** Approved text in this section reaches every assistant's drafting prompt (§4.4). */
    feedsDrafts?: boolean;
    /** Idea check only: which part of the page it belongs to. */
    group?: 'interview' | 'canvas';
}

// The idea check interview (§4.1) — the same eight questions in chat and in the step-by-step form.
const INTERVIEW: SectionDef[] = [
    { key: 'buyer', label: 'Who exactly is the buyer?', hint: 'Be specific: who they are, where they are, and who pays.', max: 800, group: 'interview' },
    { key: 'problem', label: 'What problem do they have now?', hint: 'In their words, if you can.', max: 800, group: 'interview' },
    { key: 'alternatives', label: 'What do they use instead today?', hint: 'Another business, doing it themselves, or putting up with it.', max: 800, group: 'interview' },
    { key: 'whyYou', label: 'Why would they pay you rather than that?', hint: 'What you do better, faster, cheaper or differently.', max: 800, group: 'interview' },
    { key: 'price', label: 'What would they pay?', hint: 'Your best guess, and how you got to it.', max: 500, group: 'interview' },
    { key: 'reach', label: 'How will they hear about you?', hint: 'The first two or three ways you will reach them.', max: 800, group: 'interview' },
    { key: 'mustBeTrue', label: 'What has to be true for this to work?', hint: 'The beliefs the whole idea rests on.', max: 1000, group: 'interview' },
    { key: 'cheapTest', label: 'How could you test it cheaply this month?', hint: 'Something small you could do in days, not months.', max: 1000, group: 'interview' },
];

// The nine standard Lean Canvas boxes, in the canvas's own reading order.
const CANVAS: SectionDef[] = [
    { key: 'canvasProblem', label: 'Problem', hint: 'The top one to three problems.', max: 600, group: 'canvas' },
    { key: 'canvasSegments', label: 'Customer segments', hint: 'Who has the problem; your first customers.', max: 600, group: 'canvas' },
    { key: 'canvasValue', label: 'Unique value proposition', hint: 'One clear message: why you, and why now.', max: 600, group: 'canvas' },
    { key: 'canvasSolution', label: 'Solution', hint: 'The simplest thing that solves each problem.', max: 600, group: 'canvas' },
    { key: 'canvasChannels', label: 'Channels', hint: 'How you reach your customers.', max: 600, group: 'canvas' },
    { key: 'canvasRevenue', label: 'Revenue streams', hint: 'What you charge, and how.', max: 600, group: 'canvas' },
    { key: 'canvasCosts', label: 'Cost structure', hint: 'What it costs to run and to win a customer.', max: 600, group: 'canvas' },
    { key: 'canvasMetrics', label: 'Key metrics', hint: 'The few numbers that tell you it is working.', max: 600, group: 'canvas' },
    { key: 'canvasAdvantage', label: 'Unfair advantage', hint: 'What can’t easily be copied or bought. "None yet" is an honest answer.', max: 600, group: 'canvas' },
];

export const STRATEGY_KINDS: Record<StrategyKind, { label: string; sections: SectionDef[]; hasAssumptions?: boolean }> = {
    idea_check: { label: 'Idea check', sections: [...INTERVIEW, ...CANVAS], hasAssumptions: true },
    business_plan: {
        label: 'Business plan',
        sections: [
            { key: 'customer', label: 'Who the customer is', hint: 'Who buys, and who you are not for.', max: 1500, feedsDrafts: true },
            { key: 'problem', label: 'The problem', hint: 'What they struggle with that you solve.', max: 1500, feedsDrafts: true },
            { key: 'offer', label: 'The offer', hint: 'What you sell and what makes it worth buying.', max: 1500, feedsDrafts: true },
            { key: 'pricing', label: 'Pricing', hint: 'How you charge. Products & Services stays the place for exact prices.', max: 1000 },
            { key: 'channels', label: 'How customers find you', hint: 'The ways you will reach and win customers.', max: 1500 },
            { key: 'milestones', label: 'The next 90 days', hint: 'Three to five milestones, each with a date.', max: 1500 },
            { key: 'numbers', label: 'The numbers', hint: 'Only figures you supply or agree: sales, costs, targets.', max: 1500 },
        ],
    },
    marketing_plan: {
        label: 'Marketing plan',
        sections: [
            { key: 'audience', label: 'Audience', hint: 'Who you are talking to, and what they care about.', max: 1500, feedsDrafts: true },
            { key: 'messaging', label: 'Messaging', hint: 'The two or three things every piece should get across.', max: 1500, feedsDrafts: true },
            { key: 'channels', label: 'Channels, per assistant', hint: 'Which assistant covers which channel, and what each is for.', max: 1500, feedsDrafts: true },
            { key: 'cadence', label: 'How often', hint: 'How often you post, email or publish on each channel.', max: 1000 },
            { key: 'goals', label: 'Goals', hint: 'What you want this to achieve, with numbers and dates.', max: 1000 },
        ],
    },
};

export const MAX_ASSUMPTIONS = 6;

export interface StrategyBody {
    sections: Record<string, string>;
    assumptions?: Array<{ assumption: string; test: string }>;
}

export interface StrategyDoc {
    id: number;
    kind: StrategyKind;
    version: number;
    status: 'draft' | 'approved' | 'superseded';
    body: StrategyBody;
    approvedAt: Date | null;
    approvedBy: number | null;
    updatedAt: Date | null;
}

const clip = (v: unknown, max: number): string | null => {
    if (typeof v !== 'string') return null;
    const t = v.replace(/\r\n/g, '\n').trim();
    return t ? t.slice(0, max) : '';
};

/**
 * Pure: the sections and assumptions a save may write for this kind. Unknown keys are dropped; an
 * empty string clears a section. Returns null when nothing usable was sent.
 */
export function cleanStrategyPatch(kind: StrategyKind, raw: { sections?: unknown; assumptions?: unknown }): { sections: Record<string, string>; assumptions?: StrategyBody['assumptions'] } | null {
    const def = STRATEGY_KINDS[kind];
    const src = raw.sections && typeof raw.sections === 'object' ? raw.sections as Record<string, unknown> : {};
    const sections: Record<string, string> = {};
    for (const s of def.sections) {
        if (!(s.key in src)) continue;
        const v = clip(src[s.key], s.max);
        if (v !== null) sections[s.key] = v;
    }
    let assumptions: StrategyBody['assumptions'];
    if (def.hasAssumptions && Array.isArray(raw.assumptions)) {
        assumptions = raw.assumptions.slice(0, MAX_ASSUMPTIONS).flatMap((a) => {
            const o = a && typeof a === 'object' ? a as Record<string, unknown> : {};
            const assumption = clip(o.assumption, 400);
            if (!assumption) return [];
            return [{ assumption, test: clip(o.test, 400) || '' }];
        });
    }
    if (!Object.keys(sections).length && assumptions === undefined) return null;
    return assumptions === undefined ? { sections } : { sections, assumptions };
}

/** Pure: a body read from the database, keeping only this kind's sections. */
export function readBody(kind: StrategyKind, raw: unknown): StrategyBody {
    const b = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const clean = cleanStrategyPatch(kind, { sections: b.sections, assumptions: b.assumptions });
    return { sections: clean?.sections ?? {}, ...(STRATEGY_KINDS[kind].hasAssumptions ? { assumptions: clean?.assumptions ?? [] } : {}) };
}

/** Pure: the body after a patch. Sections not in the patch are kept; assumptions are replaced when sent. */
export function mergeBody(current: StrategyBody | null, patch: { sections: Record<string, string>; assumptions?: StrategyBody['assumptions'] }): StrategyBody {
    const sections = { ...(current?.sections ?? {}) };
    for (const [k, v] of Object.entries(patch.sections)) {
        if (v) sections[k] = v; else delete sections[k];
    }
    const out: StrategyBody = { sections };
    const assumptions = patch.assumptions ?? current?.assumptions;
    if (assumptions !== undefined) out.assumptions = assumptions;
    return out;
}

/** Pure: is there anything written in it? */
export function bodyIsEmpty(b: StrategyBody | null | undefined): boolean {
    return !b || (!Object.values(b.sections ?? {}).some((v) => v && v.trim()) && !(b.assumptions ?? []).length);
}

// ── Diff (Plan tab "Changes", and the approve card) ──────────────────────────────────────────────

export type DiffPart = { op: 'same' | 'add' | 'del'; text: string };
export interface SectionDiff { key: string; label: string; change: 'added' | 'removed' | 'changed'; parts: DiffPart[] }

/** Pure: a word-level diff of two texts (longest common subsequence over words and spaces). */
export function diffWords(before: string, after: string): DiffPart[] {
    const a = before.split(/(\s+)/).filter((x) => x !== '');
    const b = after.split(/(\s+)/).filter((x) => x !== '');
    // Long texts: show a whole replacement rather than spend O(n·m) on a 2,000-word pair.
    if (a.length * b.length > 400_000) return [...(before ? [{ op: 'del' as const, text: before }] : []), ...(after ? [{ op: 'add' as const, text: after }] : [])];
    const n = a.length, m = b.length;
    const L: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    const parts: DiffPart[] = [];
    const push = (op: DiffPart['op'], text: string) => {
        const last = parts[parts.length - 1];
        if (last && last.op === op) last.text += text; else parts.push({ op, text });
    };
    let i = 0, j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) { push('same', a[i]); i++; j++; }
        else if (L[i + 1][j] >= L[i][j + 1]) { push('del', a[i]); i++; }
        else { push('add', b[j]); j++; }
    }
    while (i < n) push('del', a[i++]);
    while (j < m) push('add', b[j++]);
    return parts;
}

const assumptionsText = (b: StrategyBody | null) => (b?.assumptions ?? []).map((a) => `${a.assumption}${a.test ? ` → ${a.test}` : ''}`).join('\n');

/** Pure: what changes between the approved version (or nothing) and the draft, section by section. */
export function diffStrategy(kind: StrategyKind, approved: StrategyBody | null, draft: StrategyBody | null): SectionDiff[] {
    const out: SectionDiff[] = [];
    const rows: Array<{ key: string; label: string; before: string; after: string }> = STRATEGY_KINDS[kind].sections.map((s) => ({
        key: s.key, label: s.label, before: approved?.sections[s.key] ?? '', after: draft?.sections[s.key] ?? '',
    }));
    if (STRATEGY_KINDS[kind].hasAssumptions) rows.push({ key: 'assumptions', label: 'Riskiest assumptions', before: assumptionsText(approved), after: assumptionsText(draft) });
    for (const r of rows) {
        if (r.before.trim() === r.after.trim()) continue;
        out.push({
            key: r.key, label: r.label,
            change: !r.before.trim() ? 'added' : !r.after.trim() ? 'removed' : 'changed',
            parts: diffWords(r.before, r.after),
        });
    }
    return out;
}

// ── Pre-draft from the workspace (§13.2) ─────────────────────────────────────────────────────────

export interface PrefillSources {
    description: string | null;
    audience: string | null;
    industry: string | null;
    products: Array<{ name: string; kind: string | null; price: string | null }>;
    offerKinds: string[] | null;
    activeTeam: Array<{ name: string; role: string }>;
    goals: Array<{ assistant: string; label: string; target: number; targetDate: Date }>;
}

const OFFER_WORDS: Record<string, string> = {
    products: 'products', services: 'services', subscriptions: 'subscriptions', bookings: 'bookings',
    visits: 'visits to a place', menu: 'food and drink from a menu',
};

/**
 * Pure: an existing workspace's plans, pre-filled from what is already saved — no model, so nothing
 * is invented and nothing is spent. Only sections with a real source are filled; the rest stay empty
 * for the user (or "Draft it for me") to write. Never saved until the user presses Save draft.
 */
export function prefillStrategy(kind: StrategyKind, s: PrefillSources): StrategyBody | null {
    const sections: Record<string, string> = {};
    const productLine = s.products.length
        ? s.products.slice(0, 8).map((p) => `${p.name}${p.price?.trim() ? ` (${p.price.trim()})` : ''}`).join('; ')
        : '';
    const offerLine = s.offerKinds?.length ? `They offer ${s.offerKinds.map((k) => OFFER_WORDS[k] ?? k).join(', ')}.` : '';
    if (kind === 'business_plan') {
        if (s.audience?.trim()) sections.customer = s.audience.trim();
        const offer = [s.description?.trim(), offerLine, productLine ? `What they sell: ${productLine}.` : ''].filter(Boolean).join('\n');
        if (offer) sections.offer = offer;
        if (s.products.some((p) => p.price?.trim())) sections.pricing = `Prices as listed in Products & Services: ${productLine}.`;
        if (s.activeTeam.length) sections.channels = s.activeTeam.map((t) => `${t.role} (${t.name})`).join('\n');
    } else if (kind === 'marketing_plan') {
        if (s.audience?.trim()) sections.audience = s.audience.trim();
        if (s.activeTeam.length) sections.channels = s.activeTeam.map((t) => `${t.name} (${t.role})`).join('\n');
        if (s.goals.length) sections.goals = s.goals.slice(0, 6).map((g) => `${g.label} — ${g.target} by ${g.targetDate.toISOString().slice(0, 10)} (${g.assistant})`).join('\n');
    } else {
        if (s.audience?.trim()) sections.buyer = s.audience.trim();
        if (s.description?.trim()) sections.whyYou = s.description.trim();
    }
    for (const def of STRATEGY_KINDS[kind].sections) if (sections[def.key]) sections[def.key] = sections[def.key].slice(0, def.max);
    return Object.keys(sections).length ? { sections, ...(STRATEGY_KINDS[kind].hasAssumptions ? { assumptions: [] } : {}) } : null;
}

/** What the pre-draft is filled from (org-scoped; optional tables read as empty). */
export async function loadPrefillSources(db: Db, orgId: number): Promise<PrefillSources> {
    const optional = async <T>(q: () => Promise<T>, fallback: T): Promise<T> => {
        try { return await q(); } catch (err) { if (missing(err)) return fallback; throw err; }
    };
    const [org] = await db.select({ description: organisations.businessDescription, audience: organisations.targetAudience, industry: organisations.industry })
        .from(organisations).where(eq(organisations.id, orgId)).limit(1);
    const products = await optional(() => db.select({ name: orgProducts.name, kind: orgProducts.kind, price: orgProducts.price })
        .from(orgProducts).where(eq(orgProducts.organisationId, orgId)).limit(12), [] as PrefillSources['products']);
    const [offer] = await optional(() => db.select({ offers: orgOfferProfile.offers }).from(orgOfferProfile)
        .where(eq(orgOfferProfile.organisationId, orgId)).limit(1), [] as Array<{ offers: string[] }>);
    const team = await db.select({ name: aiAssistants.name, role: masterAssistants.name, type: sql<string>`${aiAssistants.configuration} ->> 'type'` })
        .from(aiAssistants).leftJoin(masterAssistants, eq(aiAssistants.masterAssistantId, masterAssistants.id))
        .where(and(eq(aiAssistants.organisationId, orgId), eq(aiAssistants.lifecycleStatus, 'working')));
    const goalRows = await db.select({ assistant: aiAssistants.name, title: goals.title, metricKey: goals.metricKey, target: goals.targetValue, targetDate: goals.targetDate })
        .from(goals).innerJoin(aiAssistants, eq(goals.assistantId, aiAssistants.id))
        .where(and(eq(goals.organisationId, orgId), eq(goals.isActive, true), eq(aiAssistants.lifecycleStatus, 'working'))).limit(6);
    return {
        description: org?.description ?? null, audience: org?.audience ?? null, industry: org?.industry ?? null,
        products: products.map((p: any) => ({ name: p.name, kind: p.kind ?? null, price: p.price ?? null })),
        offerKinds: offer ? (offer.offers ?? []).filter((k: string) => !k.startsWith('asked:')) : null,
        // Only the role assistants: the Mentor itself is not a channel.
        activeTeam: team.filter((t: any) => t.type !== 'business_mentor').map((t: any) => ({ name: t.name || t.role || 'Assistant', role: t.role || 'Assistant' })),
        // A goal with no title is named by its metric's label, never its internal key (staging, 2026-10-25).
        goals: goalRows.map((g: any) => ({ assistant: g.assistant || 'An assistant', label: g.title || getGoalMetric(g.metricKey)?.label || 'A goal', target: Number(g.target), targetDate: new Date(g.targetDate) })),
    };
}

// ── Database ─────────────────────────────────────────────────────────────────────────────────────

const missing = (err: any) => {
    const code = err?.code ?? err?.cause?.code;
    return code === '42P01' || code === '42703';
};

export const NOT_READY = 'Strategy documents aren’t switched on for this workspace yet — please try again later.';

function toDoc(r: any): StrategyDoc {
    const kind = r.kind as StrategyKind;
    return {
        id: r.id, kind, version: r.version, status: r.status, body: readBody(kind, r.body),
        approvedAt: r.approvedAt ?? null, approvedBy: r.approvedBy ?? null, updatedAt: r.updatedAt ?? null,
    };
}

/** Every version of every document, newest first; null when the table isn't there yet. Org-scoped. */
export async function loadStrategyDocs(db: Db, orgId: number): Promise<StrategyDoc[] | null> {
    try {
        const rows = await db.select().from(strategyDocuments)
            .where(eq(strategyDocuments.organisationId, orgId))
            .orderBy(strategyDocuments.kind, desc(strategyDocuments.version));
        return rows.filter((r: any) => isStrategyKind(r.kind)).map(toDoc);
    } catch (err) {
        if (missing(err)) return null;
        throw err;
    }
}

/** Pure: the draft and the approved version of one kind, and the superseded ones (newest first). */
export function pickVersions(docs: StrategyDoc[], kind: StrategyKind) {
    const mine = docs.filter((d) => d.kind === kind);
    return {
        draft: mine.find((d) => d.status === 'draft') ?? null,
        approved: mine.find((d) => d.status === 'approved') ?? null,
        earlier: mine.filter((d) => d.status === 'superseded'),
    };
}

export type StrategyWriteResult = { ok: true; doc: StrategyDoc } | { ok: false; status: number; error: string };

/**
 * Save into this kind's draft: create it (next version number, starting from the approved text so an
 * edit doesn't wipe the rest) or merge into it. The Plan tab's Save draft, the step-by-step form, the
 * canvas and the chat card all come here.
 */
export async function saveStrategyDraft(db: Db, orgId: number, userId: number, kind: StrategyKind, raw: { sections?: unknown; assumptions?: unknown }): Promise<StrategyWriteResult> {
    const patch = cleanStrategyPatch(kind, raw);
    if (!patch) return { ok: false, status: 400, error: 'There was nothing to save.' };
    try {
        return await db.transaction(async (tx: any) => {
            // Serialise saves of one document (two tabs, or the form and a chat card at once).
            await tx.execute(sql`SELECT pg_advisory_xact_lock(${orgId}::int, hashtext(${`strategy:${kind}`}::text))`);
            const rows = await tx.select().from(strategyDocuments)
                .where(and(eq(strategyDocuments.organisationId, orgId), eq(strategyDocuments.kind, kind)))
                .orderBy(desc(strategyDocuments.version));
            const docs = rows.map(toDoc);
            const { draft, approved } = pickVersions(docs, kind);
            if (draft) {
                const body = mergeBody(draft.body, patch);
                const [r] = await tx.update(strategyDocuments).set({ body, updatedBy: userId, updatedAt: new Date() })
                    .where(and(eq(strategyDocuments.id, draft.id), eq(strategyDocuments.organisationId, orgId))).returning();
                return { ok: true as const, doc: toDoc(r) };
            }
            const version = (docs[0]?.version ?? 0) + 1;
            const body = mergeBody(approved?.body ?? null, patch);
            const [r] = await tx.insert(strategyDocuments).values({
                organisationId: orgId, kind, version, status: 'draft', body, createdBy: userId, updatedBy: userId,
            }).returning();
            return { ok: true as const, doc: toDoc(r) };
        });
    } catch (err) {
        if (missing(err)) return { ok: false, status: 503, error: NOT_READY };
        throw err;
    }
}

/** Who may approve a strategy document: the roles that manage the workspace (§2.5). */
export const canApproveStrategy = (role: string | null | undefined) => role === 'owner' || role === 'admin';

/**
 * Approve this kind's draft. `expectedDraftId` is the draft the user looked at (the card or the page):
 * if it changed since, nothing is approved. The old approved version becomes superseded. The caller
 * recompiles blueprints afterwards (recompileOrgBlueprints) so drafting picks it up.
 */
export async function approveStrategyDraft(db: Db, orgId: number, userId: number, kind: StrategyKind, expected: { draftId?: unknown; updatedAt?: unknown }): Promise<StrategyWriteResult> {
    try {
        return await db.transaction(async (tx: any) => {
            await tx.execute(sql`SELECT pg_advisory_xact_lock(${orgId}::int, hashtext(${`strategy:${kind}`}::text))`);
            const rows = await tx.select().from(strategyDocuments)
                .where(and(eq(strategyDocuments.organisationId, orgId), eq(strategyDocuments.kind, kind)));
            const { draft } = pickVersions(rows.map(toDoc), kind);
            if (!draft) return { ok: false as const, status: 404, error: 'There is no draft to approve.' };
            if (expected.draftId !== undefined && Number(expected.draftId) !== draft.id) return { ok: false as const, status: 409, error: 'The draft has changed since this was shown — open the Plan tab to see the latest before approving.' };
            if (typeof expected.updatedAt === 'string' && draft.updatedAt && new Date(expected.updatedAt).getTime() < draft.updatedAt.getTime() - 1000) {
                return { ok: false as const, status: 409, error: 'The draft has been edited since this was shown — check the latest changes before approving.' };
            }
            if (bodyIsEmpty(draft.body)) return { ok: false as const, status: 400, error: 'The draft is empty — write something before approving it.' };
            await tx.update(strategyDocuments).set({ status: 'superseded', updatedAt: new Date() })
                .where(and(eq(strategyDocuments.organisationId, orgId), eq(strategyDocuments.kind, kind), eq(strategyDocuments.status, 'approved')));
            const [r] = await tx.update(strategyDocuments).set({ status: 'approved', approvedBy: userId, approvedAt: new Date(), updatedAt: new Date() })
                .where(and(eq(strategyDocuments.id, draft.id), eq(strategyDocuments.organisationId, orgId))).returning();
            return { ok: true as const, doc: toDoc(r) };
        });
    } catch (err) {
        if (missing(err)) return { ok: false, status: 503, error: NOT_READY };
        throw err;
    }
}

// ── What reaches prompts ─────────────────────────────────────────────────────────────────────────

export const STRATEGY_DRAFTS_CHAR_CAP = 2500;

/** Pure: the approved sections every assistant drafts from (§4.4), within the cap. Null when none. */
export function renderApprovedStrategyForDrafts(docs: StrategyDoc[]): string | null {
    const lines: string[] = [];
    for (const kind of ['business_plan', 'marketing_plan'] as const) {
        const approved = docs.find((d) => d.kind === kind && d.status === 'approved');
        if (!approved) continue;
        const rows = STRATEGY_KINDS[kind].sections.filter((s) => s.feedsDrafts && approved.body.sections[s.key]?.trim())
            .map((s) => `- ${s.label}: ${approved.body.sections[s.key].trim().replace(/\s*\n+\s*/g, '; ')}`);
        if (rows.length) lines.push(`${STRATEGY_KINDS[kind].label} (approved by the owner):`, ...rows);
    }
    if (!lines.length) return null;
    const text = lines.join('\n');
    return text.length > STRATEGY_DRAFTS_CHAR_CAP ? `${text.slice(0, STRATEGY_DRAFTS_CHAR_CAP - 1)}…` : text;
}

/** Pure: the Mentor's own view of its documents (its <workspace> block): what's approved, what's drafted, what's empty. */
export function renderStrategyForMentor(docs: StrategyDoc[] | null): string[] {
    const lines = ['STRATEGY DOCUMENTS (your Plan tab):'];
    if (docs === null) return [...lines, '- Not available in this workspace yet. Don’t offer to save or approve any; you can still talk them through it.'];
    for (const kind of STRATEGY_KIND_KEYS) {
        const { draft, approved } = pickVersions(docs, kind);
        const def = STRATEGY_KINDS[kind];
        const state = approved ? `approved v${approved.version}${draft ? `; a draft v${draft.version} is waiting for approval` : ''}` : draft ? `draft v${draft.version}, not approved yet` : 'not started';
        lines.push(`- ${def.label}: ${state}.`);
        const show = draft ?? approved;
        if (!show) continue;
        for (const s of def.sections) {
            const v = show.body.sections[s.key]?.trim();
            lines.push(`  · ${s.key} "${s.label}": ${v ? v.replace(/\s*\n+\s*/g, '; ').slice(0, 300) : '(empty)'}`);
        }
        if (def.hasAssumptions) {
            const a = show.body.assumptions ?? [];
            lines.push(`  · assumptions: ${a.length ? a.map((x) => `${x.assumption}${x.test ? ` (test: ${x.test})` : ''}`).join(' | ').slice(0, 600) : '(none yet)'}`);
        }
    }
    return lines;
}
