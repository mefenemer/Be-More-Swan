// src/utils/content-pillars-store.ts
// A Social Media assistant's content pillars as RECORDS (db/z-content-pillars.sql,
// docs/pillar-records-plan.md). One row per pillar: name, an optional description, order, on/off.
//
// ⚠️ The table is the TRUTH. ai_assistants.onboarding_context.content_pillars is DERIVED from it (the
// names of the active pillars, in order), rewritten by writeDerivedPillars() after every change, so
// the readers that only want names (profile bio, goal AI, Mentor, auto-responder…) keep working.
// Never write content_pillars into onboarding_context anywhere else: a text answer (the chat set-up
// card, the wizard) goes through syncPillarsFromNames(), which reconciles the rows to it.
//
// Pillars are archived, never deleted: posts keep their pillar_id, so the balance counts survive a
// rename and the history stays true.
//
// Until the SQL is applied (table missing) every read falls back to the old text, so drafting carries on.

import { and, asc, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { aiAssistants, contentPillars } from '../../db/schema';
import { parsePillars, MAX_PILLARS, MAX_PILLAR_CHARS } from '../public/content-pillars.js';

type Db = ReturnType<typeof getDb>;
/** The client or a transaction: only what this module uses. */
export type PillarDb = Pick<Db, 'select' | 'insert' | 'update' | 'execute'>;

/** At most this many pillars switched on. Switched-off and archived ones don't count. */
export const MAX_ACTIVE_PILLARS = MAX_PILLARS;
export const MAX_PILLAR_NAME = MAX_PILLAR_CHARS;
export const MAX_PILLAR_DESCRIPTION = 300;

export interface Pillar {
    id: number;
    name: string;
    description: string | null;
    sortOrder: number;
    isActive: boolean;
}

/** What drafting needs. `id` is null when the pillars still come from the old text. */
export interface DraftPillar {
    id: number | null;
    name: string;
    description: string | null;
}

export type PillarResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string };

// ── Pure ────────────────────────────────────────────────────────────────────────────────────────

/** Whitespace collapsed and trimmed. */
export function cleanPillarText(v: unknown): string {
    return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
}

/** Validates the fields that were sent. An absent field stays absent; a blank description clears it. */
export function validatePillarFields(input: { name?: unknown; description?: unknown })
    : { ok: true; name?: string; description?: string | null } | { ok: false; error: string } {
    const out: { ok: true; name?: string; description?: string | null } = { ok: true };
    if (input.name !== undefined) {
        const name = cleanPillarText(input.name);
        if (!name) return { ok: false, error: 'Give the pillar a name.' };
        if (name.length > MAX_PILLAR_NAME) {
            return { ok: false, error: `A pillar name is a short theme, at most ${MAX_PILLAR_NAME} characters. Put the detail in the description.` };
        }
        out.name = name;
    }
    if (input.description !== undefined && input.description !== null) {
        if (typeof input.description !== 'string') return { ok: false, error: 'The description must be text.' };
        const d = input.description.trim();
        if (d.length > MAX_PILLAR_DESCRIPTION) return { ok: false, error: `Keep the description to ${MAX_PILLAR_DESCRIPTION} characters.` };
        out.description = d || null;
    } else if (input.description === null) {
        out.description = null;
    }
    return out;
}

/** Live rows in display order: sort_order, then id. */
export function sortPillars<T extends { sortOrder: number; id: number }>(rows: T[]): T[] {
    return [...rows].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
}

/** The derived onboarding_context.content_pillars value: active names, in order. */
export function derivedPillarNames(rows: Pillar[]): string[] {
    return sortPillars(rows.filter((r) => r.isActive)).map((r) => r.name);
}

export interface NameSyncPlan {
    /** Rows kept (or switched back on), with their new position and the name as typed now. */
    updates: { id: number; name: string; sortOrder: number; isActive: true }[];
    creates: { name: string; sortOrder: number }[];
    /** Archived rows the text names again: brought back with their description and posts. */
    revives: { id: number; name: string; sortOrder: number }[];
    /** Active rows the new text no longer lists. */
    archives: number[];
    /** Switched-off rows the text never showed, moved after the active ones. */
    reorders: { id: number; sortOrder: number }[];
}

/**
 * Pure: how to make the live rows match a text answer (the chat set-up card, the wizard). The text
 * lists only ACTIVE pillars, so: a name that matches a live row (any case) keeps that row and its
 * history; a new name creates a row; an active row the text dropped is archived; a switched-off row
 * (never in the text) is left alone, after the active ones.
 */
export function planNameSync(rows: Pillar[], raw: unknown, archived: Pillar[] = []): NameSyncPlan {
    const names = parsePillars(raw);
    const byKey = new Map(rows.map((r) => [r.name.toLowerCase(), r]));
    // The most recently archived row of each name (callers pass newest first).
    const archivedByKey = new Map<string, Pillar>();
    for (const a of archived) if (!archivedByKey.has(a.name.toLowerCase())) archivedByKey.set(a.name.toLowerCase(), a);
    const plan: NameSyncPlan = { updates: [], creates: [], revives: [], archives: [], reorders: [] };
    const used = new Set<number>();
    names.forEach((name, i) => {
        const row = byKey.get(name.toLowerCase());
        const old = archivedByKey.get(name.toLowerCase());
        if (row && !used.has(row.id)) {
            used.add(row.id);
            plan.updates.push({ id: row.id, name, sortOrder: i, isActive: true });
        } else if (!row && old && !used.has(old.id)) {
            used.add(old.id);
            plan.revives.push({ id: old.id, name, sortOrder: i });
        } else {
            plan.creates.push({ name: name.slice(0, MAX_PILLAR_NAME), sortOrder: i });
        }
    });
    let next = names.length;
    for (const r of sortPillars(rows)) {
        if (used.has(r.id)) continue;
        if (r.isActive) plan.archives.push(r.id);
        else plan.reorders.push({ id: r.id, sortOrder: next++ });
    }
    return plan;
}

/** The prompt text for one pillar: the name, then what goes under it when the owner said. */
export function pillarPromptText(p: DraftPillar): string {
    return p.description ? `"${p.name}" (${p.description})` : `"${p.name}"`;
}

// ── Database ────────────────────────────────────────────────────────────────────────────────────

/** True for "relation content_pillars does not exist" (the SQL not applied yet). */
function isMissingTable(err: unknown): boolean {
    const e = err as { code?: string; message?: string; cause?: { code?: string } };
    return e?.code === '42P01' || e?.cause?.code === '42P01' || /content_pillars.*does not exist|pillar_id.*does not exist/i.test(String(e?.message ?? ''));
}

function isUniqueViolation(err: unknown): boolean {
    const e = err as { code?: string; cause?: { code?: string } };
    return e?.code === '23505' || e?.cause?.code === '23505';
}

let tableSeen = false;
/**
 * Whether db/z-content-pillars.sql has been applied. Checked up front, never by catching the error: a
 * failed statement inside a transaction (update-assistant-context's save) aborts the whole save.
 * Only "yes" is cached, so applying the SQL takes effect without a redeploy.
 */
export async function pillarsTableExists(db: PillarDb): Promise<boolean> {
    if (tableSeen) return true;
    const res = await db.execute(sql`select to_regclass('public.content_pillars') is not null as ok`);
    const first = (Array.isArray(res) ? res[0] : (res as { rows?: unknown[] }).rows?.[0]) as { ok?: boolean } | undefined;
    tableSeen = first?.ok === true;
    return tableSeen;
}

/** Every non-archived row of the assistant, in order. Null when the table does not exist yet. */
export async function listPillars(db: PillarDb, orgId: number, assistantId: number): Promise<Pillar[] | null> {
    if (!(await pillarsTableExists(db))) return null;
    try {
        const rows = await db.select({
            id: contentPillars.id, name: contentPillars.name, description: contentPillars.description,
            sortOrder: contentPillars.sortOrder, isActive: contentPillars.isActive,
        }).from(contentPillars)
            .where(and(eq(contentPillars.organisationId, orgId), eq(contentPillars.assistantId, assistantId), isNull(contentPillars.archivedAt)))
            .orderBy(asc(contentPillars.sortOrder), asc(contentPillars.id));
        return rows;
    } catch (err) {
        if (isMissingTable(err)) return null;
        throw err;
    }
}

/** The assistant's archived rows, most recently archived first. */
async function listArchivedPillars(db: PillarDb, orgId: number, assistantId: number): Promise<Pillar[]> {
    return db.select({
        id: contentPillars.id, name: contentPillars.name, description: contentPillars.description,
        sortOrder: contentPillars.sortOrder, isActive: contentPillars.isActive,
    }).from(contentPillars)
        .where(and(eq(contentPillars.organisationId, orgId), eq(contentPillars.assistantId, assistantId), isNotNull(contentPillars.archivedAt)))
        .orderBy(desc(contentPillars.archivedAt), desc(contentPillars.id));
}

/** Whether the assistant has ever had a pillar row (archived ones included). */
async function hasAnyRow(db: PillarDb, orgId: number, assistantId: number): Promise<boolean> {
    const [r] = await db.select({ id: contentPillars.id }).from(contentPillars)
        .where(and(eq(contentPillars.organisationId, orgId), eq(contentPillars.assistantId, assistantId))).limit(1);
    return !!r;
}

/** Rewrites onboarding_context.content_pillars from the rows. Returns the names written. */
export async function writeDerivedPillars(db: PillarDb, orgId: number, assistantId: number, rows?: Pillar[]): Promise<string[]> {
    const live = rows ?? (await listPillars(db, orgId, assistantId)) ?? [];
    const names = derivedPillarNames(live);
    await db.update(aiAssistants)
        .set({ onboardingContext: sql`jsonb_set(coalesce(${aiAssistants.onboardingContext}, '{}'::jsonb), '{content_pillars}', ${JSON.stringify(names)}::jsonb)` })
        .where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.organisationId, orgId)));
    return names;
}

/**
 * The rows, creating them from the old text the first time (an assistant set up before records, or
 * not yet backfilled). Null when the table does not exist yet.
 */
export async function ensurePillarRecords(db: PillarDb, orgId: number, assistantId: number, onboardingContext: unknown): Promise<Pillar[] | null> {
    const rows = await listPillars(db, orgId, assistantId);
    if (rows === null || rows.length) return rows;
    if (await hasAnyRow(db, orgId, assistantId)) return rows; // every pillar archived: that is the answer
    const names = parsePillars((onboardingContext as Record<string, unknown> | null)?.content_pillars);
    if (!names.length) return rows;
    try {
        await db.insert(contentPillars).values(names.map((name, i) => ({
            organisationId: orgId, assistantId, name: name.slice(0, MAX_PILLAR_NAME), sortOrder: i, isActive: true,
        })));
    } catch (err) {
        if (!isUniqueViolation(err)) throw err; // a concurrent first load seeded them: read theirs
    }
    return listPillars(db, orgId, assistantId);
}

/**
 * The pillars drafting writes under: the active rows, or the old text (ids null) when the table is
 * missing or the assistant has never had rows. Never writes, so it is safe in any worker.
 */
export async function loadDraftPillars(db: PillarDb, orgId: number, assistantId: number, onboardingContext: unknown): Promise<DraftPillar[]> {
    const fromText = (): DraftPillar[] => parsePillars((onboardingContext as Record<string, unknown> | null)?.content_pillars)
        .map((name) => ({ id: null, name, description: null }));
    let rows: Pillar[] | null;
    try {
        rows = await listPillars(db, orgId, assistantId);
    } catch (err) {
        console.warn('[content-pillars] read failed, using the profile text:', (err as Error)?.message);
        return fromText();
    }
    if (rows === null) return fromText();
    if (!rows.length && !(await hasAnyRow(db, orgId, assistantId).catch(() => true))) return fromText();
    return rows.filter((r) => r.isActive).slice(0, MAX_ACTIVE_PILLARS)
        .map((r) => ({ id: r.id, name: r.name, description: r.description }));
}

function tableMissing<T>(): PillarResult<T> {
    return { ok: false, status: 503, error: 'Pillars are being upgraded. Try again in a few minutes.' };
}

/** Adds a pillar at the end. Switched on unless that would make more than five. */
export async function addPillar(db: PillarDb, orgId: number, assistantId: number, input: { name?: unknown; description?: unknown; isActive?: unknown })
    : Promise<PillarResult<Pillar[]>> {
    const v = validatePillarFields({ name: input.name ?? '', description: input.description });
    if (!v.ok) return { ok: false, status: 400, error: v.error };
    const rows = await listPillars(db, orgId, assistantId);
    if (rows === null) return tableMissing();
    const wantActive = input.isActive !== false;
    if (wantActive && rows.filter((r) => r.isActive).length >= MAX_ACTIVE_PILLARS) {
        return { ok: false, status: 409, error: `You can have ${MAX_ACTIVE_PILLARS} pillars switched on. Switch one off or archive it first.` };
    }
    if (rows.some((r) => r.name.toLowerCase() === v.name!.toLowerCase())) {
        return { ok: false, status: 409, error: `You already have a pillar called "${v.name}".` };
    }
    const sortOrder = rows.reduce((m, r) => Math.max(m, r.sortOrder), -1) + 1;
    try {
        await db.insert(contentPillars).values({
            organisationId: orgId, assistantId, name: v.name!, description: v.description ?? null, sortOrder, isActive: wantActive,
        });
    } catch (err) {
        if (isUniqueViolation(err)) return { ok: false, status: 409, error: `You already have a pillar called "${v.name}".` };
        throw err;
    }
    const after = (await listPillars(db, orgId, assistantId)) ?? [];
    await writeDerivedPillars(db, orgId, assistantId, after);
    return { ok: true, value: after };
}

/** Renames, re-describes or switches a pillar on/off. */
export async function updatePillar(db: PillarDb, orgId: number, assistantId: number, pillarId: number,
    input: { name?: unknown; description?: unknown; isActive?: unknown }): Promise<PillarResult<Pillar[]>> {
    const v = validatePillarFields({ name: input.name, description: input.description });
    if (!v.ok) return { ok: false, status: 400, error: v.error };
    const rows = await listPillars(db, orgId, assistantId);
    if (rows === null) return tableMissing();
    const row = rows.find((r) => r.id === pillarId);
    if (!row) return { ok: false, status: 404, error: 'That pillar was not found. It may have been archived.' };
    if (v.name && rows.some((r) => r.id !== pillarId && r.name.toLowerCase() === v.name!.toLowerCase())) {
        return { ok: false, status: 409, error: `You already have a pillar called "${v.name}".` };
    }
    const set: Partial<typeof contentPillars.$inferInsert> = { updatedAt: new Date() };
    if (v.name !== undefined) set.name = v.name;
    if (v.description !== undefined) set.description = v.description;
    if (typeof input.isActive === 'boolean' && input.isActive !== row.isActive) {
        if (input.isActive && rows.filter((r) => r.isActive).length >= MAX_ACTIVE_PILLARS) {
            return { ok: false, status: 409, error: `You can have ${MAX_ACTIVE_PILLARS} pillars switched on. Switch another one off first.` };
        }
        set.isActive = input.isActive;
    }
    try {
        await db.update(contentPillars).set(set)
            .where(and(eq(contentPillars.id, pillarId), eq(contentPillars.organisationId, orgId), eq(contentPillars.assistantId, assistantId)));
    } catch (err) {
        if (isUniqueViolation(err)) return { ok: false, status: 409, error: `You already have a pillar called "${v.name}".` };
        throw err;
    }
    const after = (await listPillars(db, orgId, assistantId)) ?? [];
    await writeDerivedPillars(db, orgId, assistantId, after);
    return { ok: true, value: after };
}

/** Archives a pillar: gone from the list and from drafting, its posts keep their link. */
export async function archivePillar(db: PillarDb, orgId: number, assistantId: number, pillarId: number): Promise<PillarResult<Pillar[]>> {
    const rows = await listPillars(db, orgId, assistantId);
    if (rows === null) return tableMissing();
    if (!rows.some((r) => r.id === pillarId)) return { ok: false, status: 404, error: 'That pillar was not found. It may already be archived.' };
    await db.update(contentPillars).set({ archivedAt: new Date(), isActive: false, updatedAt: new Date() })
        .where(and(eq(contentPillars.id, pillarId), eq(contentPillars.organisationId, orgId), eq(contentPillars.assistantId, assistantId)));
    const after = (await listPillars(db, orgId, assistantId)) ?? [];
    await writeDerivedPillars(db, orgId, assistantId, after);
    return { ok: true, value: after };
}

/** Puts the live pillars in the order given. Every live pillar must be listed once. */
export async function reorderPillars(db: PillarDb, orgId: number, assistantId: number, ids: unknown): Promise<PillarResult<Pillar[]>> {
    const rows = await listPillars(db, orgId, assistantId);
    if (rows === null) return tableMissing();
    const list = Array.isArray(ids) ? ids.map(Number) : [];
    const liveIds = new Set(rows.map((r) => r.id));
    if (list.length !== rows.length || new Set(list).size !== list.length || !list.every((id) => liveIds.has(id))) {
        return { ok: false, status: 400, error: 'The order must list every pillar once. Reload the page and try again.' };
    }
    for (let i = 0; i < list.length; i++) {
        const row = rows.find((r) => r.id === list[i])!;
        if (row.sortOrder === i) continue;
        await db.update(contentPillars).set({ sortOrder: i, updatedAt: new Date() })
            .where(and(eq(contentPillars.id, list[i]), eq(contentPillars.organisationId, orgId), eq(contentPillars.assistantId, assistantId)));
    }
    const after = (await listPillars(db, orgId, assistantId)) ?? [];
    await writeDerivedPillars(db, orgId, assistantId, after);
    return { ok: true, value: after };
}

/**
 * Makes the rows match a text answer (the chat set-up card, the wizard, an older page's autosave),
 * keeping each matching pillar's row and history (planNameSync). Returns the derived names, or null
 * when the table does not exist yet (the caller then keeps the text as it is).
 * Does NOT write onboarding_context: the caller is mid-save and writes the returned names itself.
 */
export async function syncPillarsFromNames(db: PillarDb, orgId: number, assistantId: number, raw: unknown): Promise<string[] | null> {
    const rows = await listPillars(db, orgId, assistantId);
    if (rows === null) return null;
    const plan = planNameSync(rows, raw, await listArchivedPillars(db, orgId, assistantId));
    const now = new Date();
    for (const u of plan.updates) {
        await db.update(contentPillars).set({ name: u.name, sortOrder: u.sortOrder, isActive: true, updatedAt: now })
            .where(and(eq(contentPillars.id, u.id), eq(contentPillars.organisationId, orgId)));
    }
    for (const r of plan.revives) {
        await db.update(contentPillars).set({ name: r.name, sortOrder: r.sortOrder, isActive: true, archivedAt: null, updatedAt: now })
            .where(and(eq(contentPillars.id, r.id), eq(contentPillars.organisationId, orgId)));
    }
    for (const id of plan.archives) {
        await db.update(contentPillars).set({ archivedAt: now, isActive: false, updatedAt: now })
            .where(and(eq(contentPillars.id, id), eq(contentPillars.organisationId, orgId)));
    }
    for (const r of plan.reorders) {
        await db.update(contentPillars).set({ sortOrder: r.sortOrder, updatedAt: now })
            .where(and(eq(contentPillars.id, r.id), eq(contentPillars.organisationId, orgId)));
    }
    if (plan.creates.length) {
        await db.insert(contentPillars).values(plan.creates.map((c) => ({
            organisationId: orgId, assistantId, name: c.name, sortOrder: c.sortOrder, isActive: true,
        })));
    }
    return derivedPillarNames((await listPillars(db, orgId, assistantId)) ?? []);
}
