// src/utils/design-options.ts — a brief's option as an editable design: opened, saved, changed from chat, and the file
// approving it makes. A design is stored on the option (render_params.design), so its original picture and its round's
// record stay as they were, and an option nobody opened is still approved exactly as it was drawn.

import { and, eq, inArray, sql } from 'drizzle-orm';
import { contentAssets, organisations, visualBriefOptions, visualBriefs } from '../../db/schema';
import { TASK_WEIGHTS } from '../config/task-weights';
import { hasTaskCapacity, recordCompletedWork, TASK_LIMIT_MESSAGE } from './work-metering';
import type { getDb } from '../../db/client';
import { normaliseFlyerContent, paperSizeOf } from '../config/flyer-vocab';
import { FLYER_SOURCE } from '../config/visual-brief-vocab';
import { designPixels, flyerDesign, imageDesign, imageSize, renderDesign, renderDesignDownload, renderDesignPdf, renderDesignPreview } from '../lib/design-render';
import { falConfigured, FalServiceError, removeImageBackground } from '../lib/fal-gateway';
import { qrToDataURL } from '../lib/render-libs';
import { persistBufferToR2 } from '../lib/media-persist';
import { DESIGN_LIMITS, FIRST_PHOTO_ID, applyDesignEdit, designForChat, normaliseDesign, photoAsPicture, resizeDesign, resizeTarget, sideOf, withBack, type Design, type DesignEditCard, type DesignLayer, type DesignPhotoRef, type HeldLayer, type PictureLayer } from './design-doc';
import { fetchDesignPictures, fetchFlyerPhoto, type FlyerRenderParams } from './flyer-briefs';
import { normalizeBrandKit } from './brand-kit';
import { resolveAssetDisplayUrl } from './social-publish';

type Db = ReturnType<typeof getDb>;
import { designFromTemplate, findDesignTemplate, saveDesignTemplate } from './design-templates';
/** A picture copy of a design at another size, and the library provider it becomes. */
export const DESIGN_COPY = 'design_copy';
export const DESIGN_PROVIDER = 'design';
type OptionRow = typeof visualBriefOptions.$inferSelect;

export type Refused = { ok: false; status: number; error: string };
type Opened = { ok: true; design: Design; photoUrl: string | null; pictureUrls: Record<string, string>; option: OptionRow };

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

/** Where to show each added picture, those on the shelf too: Undo and "put back" need them. Signed, so never stored. */
async function pictureUrlsOf(design: Design): Promise<Record<string, string>> {
    const backgrounds = [design.photo, design.removed?.photo].filter((p): p is NonNullable<typeof p> => !!p).map(photoAsPicture);
    const pictures = [...backgrounds, ...design.layers, ...(design.removed?.layers ?? [])].filter((l): l is PictureLayer => l.kind === 'picture');
    if (design.back) {
        const back = sideOf(design, 'back');
        const onBack = [...[back.photo, back.removed?.photo].filter((p): p is NonNullable<typeof p> => !!p).map(photoAsPicture), ...back.layers, ...(back.removed?.layers ?? [])];
        pictures.push(...onBack.filter((l): l is PictureLayer => l.kind === 'picture'));
    }
    const entries = await Promise.all(pictures.map(async (l) => [l.id, await resolveAssetDisplayUrl({ assetType: 'image', storageKey: l.ref.storageKey, externalUrl: l.ref.externalUrl })] as const));
    return Object.fromEntries(entries.filter((e): e is readonly [string, string] => !!e[1]));
}

/**
 * The QR code and logo this design could have, on the shelf when they are not on the page, so they can be put back even
 * if they came off before the shelf existed. Both come from what the business recorded, never from a browser.
 */
async function withElements(db: Db, orgId: number, o: OptionRow, stored: Design): Promise<Design> {
    const design = stored.photo && !stored.photo.id ? { ...stored, photo: { ...stored.photo, id: FIRST_PHOTO_ID } } : stored;
    // The back can have the logo and QR code too.
    if (design.back) {
        const [front, back] = await Promise.all([withElements(db, orgId, o, sideOf(design)), withElements(db, orgId, o, sideOf(design, 'back'))]);
        return withBack(front, back);
    }
    const held = [...design.layers, ...(design.removed?.layers ?? [])];
    const has = (kind: DesignLayer['kind']) => held.some((l) => l.kind === kind);
    const add: HeldLayer[] = [];
    const across = design.pageW / design.pageH;
    const p = params(o);
    if (!has('qr') && o.source === FLYER_SOURCE && p.kind === 'flyer') {
        const n = normaliseFlyerContent((p as unknown as FlyerRenderParams).content);
        if (n.ok && n.content.qr) {
            const src = await qrToDataURL(n.content.qr.url, { errorCorrectionLevel: 'M', margin: 4, width: 400, color: { dark: '#000000', light: '#ffffff' } });
            add.push({ id: 'qr', kind: 'qr', role: 'qr', x: 0.73, y: 0.95 - 0.17 * across, w: 0.17, h: 0.17 * across, src });
        }
    }
    if (!has('logo')) {
        const [org] = await db.select({ kit: organisations.brandKit }).from(organisations).where(eq(organisations.id, orgId)).limit(1);
        const logoUrl = normalizeBrandKit(org?.kit).logoUrl;
        if (logoUrl) add.push({ id: 'logo', kind: 'logo', role: 'logo', x: 0.08, y: 0.05, w: 0.3, h: 0.3 * across * 0.4, src: logoUrl });
    }
    if (!add.length) return design;
    return { ...design, removed: { layers: [...(design.removed?.layers ?? []), ...add], photo: design.removed?.photo ?? null } };
}

/** A picture from the workspace's own library: only by id, only its own, and never one the safety check rejected. */
async function libraryPicture(db: Db, orgId: number, assetId: number): Promise<DesignPhotoRef | Refused> {
    const [a] = await db.select({
        storageKey: contentAssets.storageKey, storageUrl: contentAssets.storageUrl, externalUrl: contentAssets.externalUrl, mimeType: contentAssets.mimeType,
        width: contentAssets.width, height: contentAssets.height, provider: contentAssets.provider,
    }).from(contentAssets).where(and(
        eq(contentAssets.id, assetId), eq(contentAssets.organisationId, orgId), sql`${contentAssets.purgedAt} IS NULL`,
        inArray(contentAssets.assetType, ['image']), sql`${contentAssets.status} <> 'rejected'`,
    )).limit(1);
    if (!a) return { ok: false, status: 404, error: 'That picture is not in your library.' };
    const mimeType = (a.mimeType || 'image/jpeg').split(';')[0].trim();
    if (!/^image\/(jpe?g|png|webp)$/i.test(mimeType)) return { ok: false, status: 400, error: 'A design can use a JPG, PNG or WebP picture. Please choose one of those.' };
    return { source: a.provider || 'own', storageKey: a.storageKey, externalUrl: a.storageKey ? null : a.storageUrl || a.externalUrl, mimeType, width: a.width, height: a.height };
}

/** The option's design, made the first time it is opened. */
export async function openDesign(db: Db, orgId: number, optionId: number): Promise<Opened | Refused> {
    const o = await loadOption(db, orgId, optionId);
    if ('ok' in o) return o;
    let design = storedDesign(o);
    if (!design) {
        design = await firstDesign(db, orgId, o);
        await db.update(visualBriefOptions).set({ renderParams: { ...params(o), design } }).where(eq(visualBriefOptions.id, o.id));
    }
    design = await withElements(db, orgId, o, design);
    return { ok: true, design, photoUrl: await photoUrlOf(design), pictureUrls: await pictureUrlsOf(design), option: o };
}

/** Redraw the tile's picture, so the brief's card shows the design as it now is. */
async function redrawPreview(orgId: number, o: OptionRow, design: Design): Promise<string> {
    const photo = design.photo ? await fetchFlyerPhoto(design.photo.ref) : null;
    // The tile shows the front.
    const r = await renderDesignPreview(sideOf(design), photo, await fetchDesignPictures(design));
    return (await persistBufferToR2({ orgId, bytes: r.png, contentType: 'image/png', folder: 'briefs' })).storageKey;
}

/**
 * Another file in a picture's frame. A new name, and the old picture on the shelf, so Undo brings the old one back.
 * `keepCrop` when it is the same picture, only changed: what showed before still means the same.
 */
function swapPicture(design: Design, target: string, ref: DesignPhotoRef, keepCrop = false): { design: Design; newId: string } | null {
    const newId = `p${Date.now().toString(36)}`;
    const shelved = (l: HeldLayer) => ({ layers: [...(design.removed?.layers ?? []), l].slice(-DESIGN_LIMITS.shelf), photo: design.removed?.photo ?? null });
    if (target === 'photo' && design.photo) {
        const { crop, ...photo } = design.photo;
        return { newId, design: { ...design, photo: { ...photo, ...(keepCrop && crop ? { crop } : {}), ref, id: newId }, removed: shelved(photoAsPicture(design.photo)) } };
    }
    const at = design.layers.find((l) => l.id === target);
    if (!at || at.kind !== 'picture') return null;
    const { crop, ...picture } = at;
    return { newId, design: { ...design, layers: design.layers.map((l) => (l === at ? { ...picture, ...(keepCrop && crop ? { crop } : {}), ref, id: newId } : l)), removed: shelved(at) } };
}

/**
 * Take the background out of a picture: 1 task (src/config/task-weights.ts), asked before the provider call and
 * charged only once the cut-out is saved on the design, here so the editor and the chat card charge alike. The file it sends and the file it keeps are the design's own, by name only.
 */
export async function removePictureBackground(db: Db, args: { orgId: number; userId: number | null; optionId: number; design?: unknown; target: string; side?: 'back' | null }) {
    if (!falConfigured()) return { ok: false as const, status: 503, error: 'Removing a background is not available just now.' };
    const saved = args.design === undefined ? await openDesign(db, args.orgId, args.optionId) : await saveDesign(db, { orgId: args.orgId, optionId: args.optionId, design: args.design });
    if (!saved.ok) return saved;
    const opened = await openDesign(db, args.orgId, args.optionId);
    if (!opened.ok) return opened;
    const onBack = args.side === 'back' && !!opened.design.back;
    const page = onBack ? sideOf(opened.design, 'back') : opened.design;
    const layer = page.layers.find((l) => l.id === args.target);
    const from = args.target === 'photo' ? page.photo?.ref : layer?.kind === 'picture' ? layer.ref : null;
    if (!from) return { ok: false as const, status: 400, error: 'That picture is not on this design any more.' };
    const imageUrl = await resolveAssetDisplayUrl({ assetType: 'image', storageKey: from.storageKey, externalUrl: from.externalUrl });
    if (!imageUrl) return { ok: false as const, status: 400, error: 'That picture could not be read just now. Please try again.' };
    if (!(await hasTaskCapacity(db, args.orgId, TASK_WEIGHTS.background_removal))) return { ok: false as const, status: 402, error: TASK_LIMIT_MESSAGE };
    let bytes: Buffer;
    try {
        const cut = await removeImageBackground({ imageUrl, usage: { workspaceId: args.orgId, userId: args.userId } });
        const res = await fetch(cut.url, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) throw new Error(`download ${res.status}`);
        bytes = Buffer.from(await res.arrayBuffer());
    } catch (err) {
        console.error('[design-options] remove background failed:', err instanceof Error ? err.message : err);
        const down = err instanceof FalServiceError;
        return { ok: false as const, status: down ? 503 : 502, error: down ? 'Removing a background is not available just now.' : 'The background could not be removed. Please try again.' };
    }
    const size = imageSize(bytes);
    const { storageKey } = await persistBufferToR2({ orgId: args.orgId, bytes, contentType: 'image/png', folder: 'briefs' });
    const swapped = swapPicture(page, args.target, { source: 'cutout', storageKey, externalUrl: null, mimeType: 'image/png', width: size?.width ?? from.width, height: size?.height ?? from.height }, true);
    if (!swapped) return { ok: false as const, status: 400, error: 'That picture is not on this design any more.' };
    const result = onBack ? withBack(opened.design, swapped.design) : swapped.design;
    await db.update(visualBriefOptions).set({ renderParams: { ...params(opened.option), design: result } }).where(eq(visualBriefOptions.id, opened.option.id));
    // A failed lookup must not lose the charge: it is then just unattributed.
    const brief = (await db.select({ assistantId: visualBriefs.aiAssistantId }).from(visualBriefs)
        .where(eq(visualBriefs.id, opened.option.briefId)).limit(1).catch(() => []))[0];
    await recordCompletedWork(db, args.orgId, 'background_removal', { ref: `design-option-${opened.option.id}`, assistantId: brief?.assistantId ?? null });
    return { ok: true as const, design: result, photoUrl: await photoUrlOf(result), pictureUrls: await pictureUrlsOf(result), addedId: swapped.newId };
}

/** The design as a PNG to save, with or without its page colour. Spends nothing and changes nothing on the design. */
export async function downloadDesignPng(db: Db, args: { orgId: number; optionId: number; design: unknown; seeThrough: boolean; side?: 'back' | null }) {
    const saved = await saveDesign(db, { orgId: args.orgId, optionId: args.optionId, design: args.design });
    if (!saved.ok) return saved;
    const page = sideOf(saved.design, args.side === 'back' ? 'back' : 'front');
    const photo = page.photo ? await fetchFlyerPhoto(page.photo.ref) : null;
    const r = await renderDesignDownload(page, photo, await fetchDesignPictures(page), args.seeThrough);
    const { storageKey } = await persistBufferToR2({ orgId: args.orgId, bytes: r.png, contentType: 'image/png', folder: 'briefs' });
    return { ok: true as const, storageKey };
}

/** The design as a PDF to save: every side of it, whichever is open. Spends nothing and finishes nothing. */
export async function downloadDesignPdf(db: Db, args: { orgId: number; optionId: number; design: unknown; bleedMm: number; title: string }) {
    const saved = await saveDesign(db, { orgId: args.orgId, optionId: args.optionId, design: args.design });
    if (!saved.ok) return saved;
    const front = saved.design;
    const photo = front.photo ? await fetchFlyerPhoto(front.photo.ref) : null;
    if (front.photo && !photo) return { ok: false as const, status: 502, error: 'A picture on this design could not be read just now. Please try again.' };
    const back = front.back ? sideOf(front, 'back') : null;
    const backPhoto = back?.photo ? await fetchFlyerPhoto(back.photo.ref) : null;
    if (back?.photo && !backPhoto) return { ok: false as const, status: 502, error: 'A picture on this design could not be read just now. Please try again.' };
    try {
        const pdf = await renderDesignPdf({
            design: front, photo, pictures: await fetchDesignPictures(front, true),
            backFiles: back ? { photo: backPhoto, pictures: await fetchDesignPictures(back, true) } : undefined,
            title: args.title, bleedMm: args.bleedMm,
        });
        const { storageKey } = await persistBufferToR2({ orgId: args.orgId, bytes: pdf, contentType: 'application/pdf', folder: 'briefs' });
        return { ok: true as const, storageKey };
    } catch (err) {
        if (err instanceof Error && err.message === 'flyer_photo_unavailable') return { ok: false as const, status: 502, error: 'A picture on this design could not be read just now. Please try again.' };
        throw err;
    }
}

/** Save what the studio sent. `finish` also redraws the preview: leaving the design, not every keystroke. */
export async function saveDesign(db: Db, args: { orgId: number; optionId: number; design: unknown; finish?: boolean; usePhotoFromOption?: number | null; addPicture?: number | null; replacePicture?: { assetId: number; target: string } | null; side?: 'back' | null }) {
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
        base = { ...base, photo: { ...(base.photo ?? { x: 0, y: 0, w: 1, h: 0.42, opacity: 1 }), ref, id: `o${other.id}` } };
    }
    const raw = args.design as { photo?: unknown } | null;
    const incoming = args.usePhotoFromOption && raw ? { ...raw, photo: { ...(raw.photo as object | null ?? base.photo), id: base.photo?.id } } : args.design;
    const whole = normaliseDesign(incoming, base);
    // A picture added or replaced lands on the side that is open.
    const onBack = args.side === 'back' && !!whole.back;
    let design = onBack ? sideOf(whole, 'back') : whole;
    let addedId: string | null = null;
    // A new picture from the library, on top of the page: as wide as half of it, in the picture's own shape.
    if (args.addPicture) {
        if (design.layers.filter((l) => l.kind === 'picture').length >= DESIGN_LIMITS.pictures) return { ok: false as const, status: 409, error: `A design can hold ${DESIGN_LIMITS.pictures} added pictures. Remove one to add another.` };
        if (design.layers.length >= DESIGN_LIMITS.layers) return { ok: false as const, status: 409, error: 'This design is full. Remove something to add a picture.' };
        const ref = await libraryPicture(db, args.orgId, args.addPicture);
        if ('ok' in ref) return ref;
        const shape = ref.width && ref.height ? ref.height / ref.width : 1;
        const w = 0.5;
        const h = Math.min(0.9, w * (design.pageW / design.pageH) * shape);
        addedId = `p${Date.now().toString(36)}`;
        design = { ...design, layers: [...design.layers, { id: addedId, kind: 'picture', role: 'picture', x: 0.25, y: Math.max(0, (1 - h) / 2), w, h, opacity: 1, ref }] };
    }
    // Another picture in the same frame; what showed of the old one means nothing for the new one, so its crop goes.
    if (args.replacePicture) {
        const { assetId, target } = args.replacePicture;
        const ref = await libraryPicture(db, args.orgId, assetId);
        if ('ok' in ref) return ref;
        const swapped = swapPicture(design, target, ref);
        if (!swapped) return { ok: false as const, status: 400, error: 'That picture is not on this design any more.' };
        design = swapped.design;
        addedId = swapped.newId;
    }
    if (onBack) design = withBack(whole, design);
    const next: Record<string, unknown> = { ...params(o), design };
    if (args.finish) next.previewKey = await redrawPreview(args.orgId, o, design);
    await db.update(visualBriefOptions).set({ renderParams: next }).where(eq(visualBriefOptions.id, o.id));
    return { ok: true as const, design, photoUrl: await photoUrlOf(design), pictureUrls: await pictureUrlsOf(design), addedId };
}

/**
 * A copy of the design at another size, as a new option on the same brief, so the original stays as it is. A flyer page
 * can be any paper size or a picture's shape; a picture has no words or print details to make a flyer's PDFs from, so it
 * can only become another picture's shape.
 */
export async function copyDesignAtSize(db: Db, args: { orgId: number; optionId: number; design?: unknown; size: string }) {
    const size = resizeTarget(args.size);
    if (!size) return { ok: false as const, status: 400, error: 'That size is not one of the choices.' };
    const saved = args.design === undefined ? await openDesign(db, args.orgId, args.optionId) : await saveDesign(db, { orgId: args.orgId, optionId: args.optionId, design: args.design });
    if (!saved.ok) return saved;
    const opened = await openDesign(db, args.orgId, args.optionId);
    if (!opened.ok) return opened;
    const o = opened.option;
    const isFlyer = o.source === FLYER_SOURCE && params(o).kind === 'flyer';
    if (size.kind === 'flyer' && !isFlyer) return { ok: false as const, status: 400, error: 'Only a flyer can be copied to a paper size. Choose a picture shape for this one.' };
    const design = resizeDesign(opened.design, size);
    const previewKey = await redrawPreview(args.orgId, o, design);
    const px = designPixels(design, 96, 1600);
    const keepsFlyer = size.kind === 'flyer';
    const [row] = await db.insert(visualBriefOptions).values({
        organisationId: args.orgId, briefId: o.briefId, round: o.round, source: keepsFlyer ? FLYER_SOURCE : 'brand_card', mimeType: 'image/png',
        storageKey: previewKey, width: px.width, height: px.height, prompt: size.label,
        // The picture copy's source is 'brand_card' only because the column's list of sources allows no other drawn
        // picture. DESIGN_COPY keeps it out of the branded-card editor once it is in the library (visual-briefs.ts).
        renderParams: keepsFlyer ? { ...params(o), paperSize: size.paperSize, design, previewKey } : { kind: DESIGN_COPY, design, previewKey },
    }).returning({ id: visualBriefOptions.id });
    return { ok: true as const, optionId: row.id };
}

/** Keep what is on screen as a template. */
export async function saveAsTemplate(db: Db, args: { orgId: number; userId: number | null; optionId: number; design?: unknown; name: unknown }) {
    const saved = args.design === undefined ? await openDesign(db, args.orgId, args.optionId) : await saveDesign(db, { orgId: args.orgId, optionId: args.optionId, design: args.design });
    if (!saved.ok) return saved;
    return saveDesignTemplate(db, { orgId: args.orgId, userId: args.userId, name: args.name, design: saved.design });
}

/** Put a template on this option, at its size. What was there stays within reach of Undo. */
export async function useTemplate(db: Db, args: { orgId: number; optionId: number; design?: unknown; templateId?: number | null; name?: unknown }) {
    const saved = args.design === undefined ? await openDesign(db, args.orgId, args.optionId) : await saveDesign(db, { orgId: args.orgId, optionId: args.optionId, design: args.design });
    if (!saved.ok) return saved;
    const template = await findDesignTemplate(db, args.orgId, { id: args.templateId, name: args.name });
    if (!template) return { ok: false as const, status: 404, error: 'That template is not there any more.' };
    const opened = await openDesign(db, args.orgId, args.optionId);
    if (!opened.ok) return opened;
    const design = await withElements(db, args.orgId, opened.option, designFromTemplate(opened.design, template, Date.now().toString(36)));
    await db.update(visualBriefOptions).set({ renderParams: { ...params(opened.option), design } }).where(eq(visualBriefOptions.id, opened.option.id));
    return { ok: true as const, design, photoUrl: await photoUrlOf(design), pictureUrls: await pictureUrlsOf(design) };
}

/** A change from a chat card: the same store, with its own rebuilt change. */
export async function applyDesignCard(db: Db, args: { orgId: number; card: DesignEditCard }): Promise<{ ok: true; design: Design; photoUrl: string | null; pictureUrls: Record<string, string> } | Refused> {
    const opened = await openDesign(db, args.orgId, args.card.optionId);
    if (!opened.ok) return opened;
    if (opened.option.briefId !== args.card.briefId) return { ok: false as const, status: 400, error: 'That option is on another brief.' };
    // Templates are their own step, around the card's other changes: first a template to start from, last one to keep.
    if (args.card.useTemplate) {
        const used = await useTemplate(db, { orgId: args.orgId, optionId: args.card.optionId, name: args.card.useTemplate });
        if (!used.ok) return used;
        const { useTemplate: _used, ...rest } = args.card;
        const anythingElse = rest.changes.length || rest.add.length || rest.shapes || rest.pageColor || rest.pageOpacity !== undefined || rest.font || rest.saveTemplate;
        return anythingElse ? applyDesignCard(db, { orgId: args.orgId, card: rest }) : used;
    }
    if (args.card.saveTemplate) {
        const { saveTemplate: name, ...rest } = args.card;
        const anythingElse = rest.changes.length || rest.add.length || rest.shapes || rest.putBack || rest.group || rest.ungroup || rest.setBackground || rest.detachBackground || rest.addBack || rest.removeBack || rest.removeBackground || rest.resizeCopy || rest.pageColor || rest.pageOpacity !== undefined || rest.photoOpacity !== undefined || rest.photoCrop !== undefined || rest.font;
        const after = anythingElse ? await applyDesignCard(db, { orgId: args.orgId, card: rest }) : opened;
        if (!after.ok) return after;
        const kept = await saveDesignTemplate(db, { orgId: args.orgId, userId: null, name, design: after.design });
        if (!kept.ok) return kept;
        return { ok: true as const, design: after.design, photoUrl: after.photoUrl, pictureUrls: after.pictureUrls };
    }
    const { design, applied } = applyDesignEdit(opened.design, args.card, { fromChat: true });
    // Only a cut-out was asked for: that is its own step, and the design changes only by it.
    if (!applied && args.card.removeBackground) return removePictureBackground(db, { orgId: args.orgId, userId: null, optionId: args.card.optionId, target: args.card.removeBackground, side: args.card.side });
    // Only a copy was asked for: this design stays exactly as it is.
    if (!applied && args.card.resizeCopy) {
        const copy = await copyDesignAtSize(db, { orgId: args.orgId, optionId: args.card.optionId, size: args.card.resizeCopy });
        return copy.ok ? { ok: true as const, design: opened.design, photoUrl: opened.photoUrl, pictureUrls: opened.pictureUrls } : copy;
    }
    if (!applied) return { ok: false as const, status: 409, error: 'Nothing changed: those parts are not on this design any more, or they are your contact details or offer, which only you can reword in the editor.' };
    const key = await redrawPreview(args.orgId, opened.option, design);
    await db.update(visualBriefOptions).set({ renderParams: { ...params(opened.option), design, previewKey: key } }).where(eq(visualBriefOptions.id, opened.option.id));
    if (args.card.removeBackground) {
        const cut = await removePictureBackground(db, { orgId: args.orgId, userId: null, optionId: args.card.optionId, target: args.card.removeBackground, side: args.card.side });
        if (cut.ok) return cut;
    }
    if (args.card.resizeCopy) {
        const copy = await copyDesignAtSize(db, { orgId: args.orgId, optionId: args.card.optionId, size: args.card.resizeCopy });
        if (!copy.ok) return copy;
    }
    return { ok: true as const, design, photoUrl: await photoUrlOf(design), pictureUrls: await pictureUrlsOf(design) };
}

/** The finished picture for an image option with a design: drawn at its own size. Null when there is no design to draw. */
export async function bakeImageDesign(orgId: number, renderParams: unknown): Promise<{ storageKey: string; externalUrl: null; mimeType: string; width: number; height: number } | null> {
    const design = (renderParams && typeof renderParams === 'object' ? (renderParams as { design?: Design }).design : null) ?? null;
    if (!design || design.kind !== 'image') return null;
    const untouched = !design.layers.length && design.photo && (design.photo.id ?? FIRST_PHOTO_ID) === FIRST_PHOTO_ID && !design.photo.crop && design.photo.opacity >= 1 && design.photo.x === 0 && design.photo.y === 0 && design.photo.w === 1 && design.photo.h === 1;
    if (untouched) return null;
    const photo = design.photo ? await fetchFlyerPhoto(design.photo.ref) : null;
    if (design.photo && !photo) throw new Error('flyer_photo_unavailable');
    const { width, height } = designPixels(design, 0, 4096);
    const r = await renderDesign({ design, photo, pictures: await fetchDesignPictures(design, true), width, height });
    const { storageKey } = await persistBufferToR2({ orgId, bytes: r.png, contentType: 'image/png', folder: 'briefs' });
    return { storageKey, externalUrl: null, mimeType: 'image/png', width: r.width, height: r.height };
}

export { designForChat };
