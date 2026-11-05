// src/utils/design-options.ts — a brief's option as an editable design: opened, saved, changed from chat, and the file
// approving it makes. A design is stored on the option (render_params.design), so its original picture and its round's
// record stay as they were, and an option nobody opened is still approved exactly as it was drawn.

import { and, eq } from 'drizzle-orm';
import { organisations, visualBriefOptions, visualBriefs } from '../../db/schema';
import type { getDb } from '../../db/client';
import { normaliseFlyerContent, paperSizeOf } from '../config/flyer-vocab';
import { FLYER_SOURCE } from '../config/visual-brief-vocab';
import { designPixels, flyerDesign, imageDesign, renderDesign, renderDesignPreview } from '../lib/design-render';
import { persistBufferToR2 } from '../lib/media-persist';
import { applyDesignEdit, designForChat, normaliseDesign, type Design, type DesignEditCard } from './design-doc';
import { fetchFlyerPhoto, type FlyerRenderParams } from './flyer-briefs';
import { normalizeBrandKit } from './brand-kit';
import { resolveAssetDisplayUrl } from './social-publish';

type Db = ReturnType<typeof getDb>;
type OptionRow = typeof visualBriefOptions.$inferSelect;

export type Refused = { ok: false; status: number; error: string };
type Opened = { ok: true; design: Design; photoUrl: string | null; option: OptionRow };

const EDITABLE = (o: OptionRow) => o.status === 'proposed' && !(o.mimeType || '').startsWith('video/');

async function loadOption(db: Db, orgId: number, optionId: number): Promise<OptionRow | Refused> {
    const [row] = await db.select({ o: visualBriefOptions }).from(visualBriefOptions)
        .innerJoin(visualBriefs, eq(visualBriefs.id, visualBriefOptions.briefId))
        .where(and(eq(visualBriefOptions.id, optionId), eq(visualBriefs.organisationId, orgId))).limit(1);
    if (!row) return { ok: false, status: 404, error: 'Option not found.' };
    if (!EDITABLE(row.o)) return { ok: false, status: 409, error: 'This design is finished, so it can no longer be changed here.' };
    return row.o;
}

const params = (o: OptionRow) => (o.renderParams && typeof o.renderParams === 'object' ? o.renderParams as Record<string, unknown> : {});
const storedDesign = (o: OptionRow) => (params(o).design as Design | undefined) ?? null;

async function firstDesign(db: Db, orgId: number, o: OptionRow): Promise<Design> {
    const p = params(o);
    if (o.source === FLYER_SOURCE && p.kind === 'flyer') {
        const fp = p as unknown as FlyerRenderParams;
        const n = normaliseFlyerContent(fp.content);
        if (!n.ok) throw new Error('flyer_needs_words');
        return flyerDesign({
            content: n.content, kit: normalizeBrandKit(fp.kit), paperSize: paperSizeOf(fp.paperSize) ?? 'A5', layout: fp.layout,
            photo: fp.photo, orgName: fp.orgName, style: fp.style ?? null,
        });
    }
    const [org] = await db.select({ kit: organisations.brandKit }).from(organisations).where(eq(organisations.id, orgId)).limit(1);
    return imageDesign(
        { source: o.source, storageKey: o.storageKey, externalUrl: o.externalUrl, mimeType: o.mimeType || 'image/jpeg', width: o.width, height: o.height, attributionName: o.attributionName, attributionUrl: o.attributionUrl },
        o.width || 1080, o.height || 1080, normalizeBrandKit(org?.kit).backgroundColor,
    );
}

const photoUrlOf = (d: Design) => (d.photo
    ? resolveAssetDisplayUrl({ assetType: 'image', storageKey: d.photo.ref.storageKey, externalUrl: d.photo.ref.externalUrl })
    : Promise.resolve(null));

/** The option's design, made the first time it is opened. */
export async function openDesign(db: Db, orgId: number, optionId: number): Promise<Opened | Refused> {
    const o = await loadOption(db, orgId, optionId);
    if ('ok' in o) return o;
    let design = storedDesign(o);
    if (!design) {
        design = await firstDesign(db, orgId, o);
        await db.update(visualBriefOptions).set({ renderParams: { ...params(o), design } }).where(eq(visualBriefOptions.id, o.id));
    }
    return { ok: true, design, photoUrl: await photoUrlOf(design), option: o };
}

/** Redraw the tile's picture, so the brief's card shows the design as it now is. */
async function redrawPreview(orgId: number, o: OptionRow, design: Design): Promise<string> {
    const photo = design.photo ? await fetchFlyerPhoto(design.photo.ref) : null;
    const r = await renderDesignPreview(design, photo);
    return (await persistBufferToR2({ orgId, bytes: r.png, contentType: 'image/png', folder: 'briefs' })).storageKey;
}

/** Save what the studio sent. `finish` also redraws the preview: leaving the design, not every keystroke. */
export async function saveDesign(db: Db, args: { orgId: number; optionId: number; design: unknown; finish?: boolean; usePhotoFromOption?: number | null }) {
    const opened = await openDesign(db, args.orgId, args.optionId);
    if (!opened.ok) return opened;
    const o = opened.option;
    let base = opened.design;
    // Another picture from the same brief. Only by option id: a browser never names a file.
    if (args.usePhotoFromOption) {
        const other = await loadOption(db, args.orgId, args.usePhotoFromOption);
        if ('ok' in other) return other;
        if (other.briefId !== o.briefId) return { ok: false as const, status: 400, error: 'That picture is from another brief.' };
        const from = (await openDesign(db, args.orgId, other.id));
        const ref = from.ok ? from.design.photo?.ref : null;
        if (!ref) return { ok: false as const, status: 400, error: 'That option has no picture.' };
        base = { ...base, photo: { ...(base.photo ?? { x: 0, y: 0, w: 1, h: 0.42, opacity: 1 }), ref } };
    }
    const raw = args.design as { photo?: unknown } | null;
    const incoming = args.usePhotoFromOption && raw ? { ...raw, photo: raw.photo ?? base.photo } : args.design;
    const design = normaliseDesign(incoming, base);
    const next: Record<string, unknown> = { ...params(o), design };
    if (args.finish) next.previewKey = await redrawPreview(args.orgId, o, design);
    await db.update(visualBriefOptions).set({ renderParams: next }).where(eq(visualBriefOptions.id, o.id));
    return { ok: true as const, design, photoUrl: await photoUrlOf(design) };
}

/** A change from a chat card: the same store, with its own rebuilt change. */
export async function applyDesignCard(db: Db, args: { orgId: number; card: DesignEditCard }) {
    const opened = await openDesign(db, args.orgId, args.card.optionId);
    if (!opened.ok) return opened;
    if (opened.option.briefId !== args.card.briefId) return { ok: false as const, status: 400, error: 'That option is on another brief.' };
    const { design, applied } = applyDesignEdit(opened.design, args.card, { fromChat: true });
    if (!applied) return { ok: false as const, status: 409, error: 'Nothing changed: those parts are not on this design any more, or they are your contact details or offer, which only you can reword in the editor.' };
    const key = await redrawPreview(args.orgId, opened.option, design);
    await db.update(visualBriefOptions).set({ renderParams: { ...params(opened.option), design, previewKey: key } }).where(eq(visualBriefOptions.id, opened.option.id));
    return { ok: true as const, design, photoUrl: opened.photoUrl };
}

/** The finished picture for an image option with a design: drawn at its own size. Null when there is no design to draw. */
export async function bakeImageDesign(orgId: number, renderParams: unknown): Promise<{ storageKey: string; externalUrl: null; mimeType: string; width: number; height: number } | null> {
    const design = (renderParams && typeof renderParams === 'object' ? (renderParams as { design?: Design }).design : null) ?? null;
    if (!design || design.kind !== 'image') return null;
    const untouched = !design.layers.length && design.photo && design.photo.opacity >= 1 && design.photo.x === 0 && design.photo.y === 0 && design.photo.w === 1 && design.photo.h === 1;
    if (untouched) return null;
    const photo = design.photo ? await fetchFlyerPhoto(design.photo.ref) : null;
    if (design.photo && !photo) throw new Error('flyer_photo_unavailable');
    const { width, height } = designPixels(design, 0, 4096);
    const r = await renderDesign({ design, photo, width, height });
    const { storageKey } = await persistBufferToR2({ orgId, bytes: r.png, contentType: 'image/png', folder: 'briefs' });
    return { storageKey, externalUrl: null, mimeType: 'image/png', width: r.width, height: r.height };
}

export { designForChat };
