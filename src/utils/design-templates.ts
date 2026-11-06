// src/utils/design-templates.ts — saved designs a workspace can start from (owner, 2026-11-06). A template is a copy of a
// design, private to the workspace. Using one brings it onto the open option at that option's size; what was there goes
// on the shelf, so Undo brings it back and no file is lost.

import { and, asc, eq, sql } from 'drizzle-orm';
import { designTemplates } from '../../db/schema';
import type { getDb } from '../../db/client';
import { photoAsPicture, resizeDesign, sideOf, type Design, type DesignLayer, type DesignPhoto, type HeldLayer } from './design-doc';

type Db = ReturnType<typeof getDb>;

export const TEMPLATE_LIMITS = { perWorkspace: 50, name: 60 } as const;

export const cleanTemplateName = (v: unknown): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, TEMPLATE_LIMITS.name) : '');

/** The templates, or none if the table is not there yet: the editor must never fail for want of them. */
export async function listDesignTemplates(db: Db, orgId: number): Promise<Array<{ id: number; name: string }>> {
    try {
        return await db.select({ id: designTemplates.id, name: designTemplates.name }).from(designTemplates)
            .where(eq(designTemplates.organisationId, orgId)).orderBy(asc(designTemplates.name));
    } catch (err) {
        console.warn('[design-templates] list failed:', err instanceof Error ? err.message : err);
        return [];
    }
}

type Refused = { ok: false; status: number; error: string };

/** Keep this design under a name. The same name again replaces that template. */
export async function saveDesignTemplate(db: Db, args: { orgId: number; userId: number | null; name: unknown; design: Design }): Promise<{ ok: true; id: number; name: string } | Refused> {
    const name = cleanTemplateName(args.name);
    if (!name) return { ok: false, status: 400, error: 'Give the template a name.' };
    const existing = await db.select({ id: designTemplates.id, name: designTemplates.name }).from(designTemplates).where(eq(designTemplates.organisationId, args.orgId));
    const same = existing.find((t) => t.name.toLowerCase() === name.toLowerCase());
    if (!same && existing.length >= TEMPLATE_LIMITS.perWorkspace) return { ok: false, status: 409, error: `You can keep ${TEMPLATE_LIMITS.perWorkspace} templates. Delete one to save another.` };
    // What had been taken off is this design's own history, not part of the template.
    const stripSide = <T extends { removed?: unknown }>(d: T): T => { const { removed: _removed, ...rest } = d; return rest as T; };
    const design: Design = { ...stripSide(args.design), back: args.design.back ? stripSide(args.design.back) : undefined };
    if (same) {
        await db.update(designTemplates).set({ name, design, updatedAt: new Date() }).where(and(eq(designTemplates.id, same.id), eq(designTemplates.organisationId, args.orgId)));
        return { ok: true, id: same.id, name };
    }
    const [row] = await db.insert(designTemplates).values({ organisationId: args.orgId, name, design, createdBy: args.userId }).returning({ id: designTemplates.id });
    return { ok: true, id: row.id, name };
}

export async function deleteDesignTemplate(db: Db, orgId: number, templateId: number): Promise<void> {
    await db.delete(designTemplates).where(and(eq(designTemplates.id, templateId), eq(designTemplates.organisationId, orgId)));
}

/** A template by id or by name, only ever this workspace's own. */
export async function findDesignTemplate(db: Db, orgId: number, which: { id?: number | null; name?: unknown }): Promise<Design | null> {
    const name = cleanTemplateName(which.name);
    const where = which.id
        ? and(eq(designTemplates.organisationId, orgId), eq(designTemplates.id, which.id))
        : name ? and(eq(designTemplates.organisationId, orgId), sql`lower(${designTemplates.name}) = ${name.toLowerCase()}`) : null;
    if (!where) return null;
    const [row] = await db.select({ design: designTemplates.design }).from(designTemplates).where(where).limit(1);
    return (row?.design as Design | undefined) ?? null;
}

/**
 * The template on this design's page. Pure. Its pictures take new names, as the same template may be used twice and the
 * old pictures keep theirs on the shelf for Undo. A picture option has one side, so a flyer template's back stays behind.
 */
export function designFromTemplate(current: Design, template: Design, stamp: string): Design {
    const sized = resizeDesign(template, { kind: current.kind, pageW: current.pageW, pageH: current.pageH, paperSize: current.paperSize });
    let n = 0;
    const fresh = () => `t${stamp}${n++}`;
    const freshLayers = (layers: DesignLayer[]): DesignLayer[] => layers.map((l) => (l.kind === 'picture' ? { ...l, id: fresh() } : l));
    const freshPhoto = (p: DesignPhoto | null): DesignPhoto | null => (p ? { ...p, id: fresh() } : null);
    const heldOf = (d: Design): HeldLayer[] => [
        ...d.layers.filter((l): l is HeldLayer => l.kind === 'qr' || l.kind === 'logo' || l.kind === 'picture'),
        ...(d.removed?.layers ?? []),
        ...[d.photo, d.removed?.photo].filter((p): p is DesignPhoto => !!p).map(photoAsPicture),
    ];
    const front = sideOf(current);
    const old = [...heldOf(front), ...(current.back ? heldOf(sideOf(current, 'back')) : [])];
    const layers = freshLayers(sized.layers);
    const photo = freshPhoto(sized.photo);
    const unique = (list: HeldLayer[], using: DesignLayer[]) => list.filter((l, i, all) => all.findIndex((x) => x.id === l.id) === i && !using.some((u) => u.id === l.id)).slice(-12);
    const backLayers = sized.back ? freshLayers(sized.back.layers) : [];
    return {
        ...current, pageColor: sized.pageColor, pageOpacity: sized.pageOpacity, photo, layers,
        removed: { layers: unique(old, layers), photo: null },
        back: sized.back && current.kind === 'flyer'
            ? { pageColor: sized.back.pageColor, pageOpacity: sized.back.pageOpacity, photo: freshPhoto(sized.back.photo), layers: backLayers, removed: { layers: unique(old, backLayers), photo: null } }
            : undefined,
    };
}
