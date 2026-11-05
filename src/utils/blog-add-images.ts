// src/utils/blog-add-images.ts — "Add pictures": the assistant reads an EXISTING article, decides
// where a picture would help (or follows the owner's instruction), finds or generates them, and
// puts them into the body. Owner request 2026-11-04.
//
// Rides the same interactive blog job as Shorter / Longer / Revise (generate-blog { addImages } →
// process-blog-jobs → here), so the Studio's lock-and-poll and the chat card both reuse what exists.
//
// ── Two sources, chosen by the owner ────────────────────────────────────────────────────────────
//   'stock' — Pexels, through sourceBlogImages (the same attach the autopilot drafter uses). Free.
//   'ai'    — one AI image per spot, each held and settled like any other AI image (IMAGE_CREDIT_COST).
//             A spot the allowance cannot pay for is skipped, never charged.
//
// ── ⚠️ One body write, at the end ───────────────────────────────────────────────────────────────
// The text of the article is never sent back through a model: pictures are INSERTED between the
// existing blocks, by index, so nothing the author wrote can be reworded or lost. And the body is
// written once, after every picture is in hand, so a crash part-way leaves the article as it was.

import Anthropic from '@anthropic-ai/sdk';
import { and, eq } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { blogPostAssets, blogPosts } from '../../db/schema';
import { logAiUsage } from './ai-usage';
import { stripCodeFences, parseModelJson } from './model-json';
import { BLOG_MODEL } from './blog-generate';
import { sourceBlogImages } from './blog-media-source';
import { generateAndPersistImage } from '../lib/media-persist';
import { holdCredits, settleHold, IMAGE_CREDIT_COST } from './ai-credits';

type Db = ReturnType<typeof getDb>;

export const BLOG_IMAGE_SOURCES = ['stock', 'ai'] as const;
export type BlogImageSource = typeof BLOG_IMAGE_SOURCES[number];

/** Most pictures one run may add. Same ceiling as drafting (MAX_SOURCED_IMAGES): a post that grows
 *  six photographs reads like a content farm whatever the words say. */
export const MAX_ADDED_IMAGES = 3;

export interface BodyBlock {
    text: string;
    /** Prose a picture may follow. Media lines, column groups and code are not. */
    placeable: boolean;
    /** Already a picture (or a column group, which usually holds one). */
    media: boolean;
}

/**
 * Split a body into blocks on blank lines, keeping `::::columns … ::::` and fenced code whole —
 * both can contain blank lines, and a picture inserted inside one would break it. Pure.
 */
export function splitBlocks(body: string): BodyBlock[] {
    const raw = String(body || '').replace(/\r\n/g, '\n').split(/\n{2,}/);
    const out: BodyBlock[] = [];
    for (let i = 0; i < raw.length; i++) {
        let text = raw[i];
        const opensColumns = /^::::columns\{/.test(text.trimStart()) && !/\n::::[ \t]*$/.test(text);
        const fences = (text.match(/^```/gm) || []).length;
        if (opensColumns) {
            while (i + 1 < raw.length && !/(^|\n)::::[ \t]*$/.test(text)) text += '\n\n' + raw[++i];
        } else if (fences % 2 === 1) {
            while (i + 1 < raw.length && ((text.match(/^```/gm) || []).length % 2 === 1)) text += '\n\n' + raw[++i];
        }
        const t = text.trim();
        if (!t) continue;
        const media = /^:::media\{/.test(t) || /^::::columns\{/.test(t) || /^!\[[^\]]*\]\(asset:\/\/\d+\)$/.test(t);
        const placeable = !media && !/^```/.test(t);
        out.push({ text: t, placeable, media });
    }
    return out;
}

export interface Placement { after: number; query: string; scene: string; alt: string }

/**
 * Keep only placements that land after a real prose block, not straight before or after a picture
 * that is already there, one per spot, in article order, capped. Pure.
 */
export function cleanPlacements(raw: unknown, blocks: BodyBlock[], cap = MAX_ADDED_IMAGES): Placement[] {
    const list = Array.isArray(raw) ? raw : [];
    const seen = new Set<number>();
    const out: Placement[] = [];
    for (const p of list) {
        if (!p || typeof p !== 'object') continue;
        const o = p as Record<string, unknown>;
        const after = Number(o.after);
        if (!Number.isInteger(after) || after < 0 || after >= blocks.length) continue;
        if (!blocks[after].placeable || seen.has(after)) continue;
        if (blocks[after + 1]?.media) continue;   // a picture already follows this paragraph
        const query = String(o.query ?? '').trim().slice(0, 100);
        const scene = String(o.scene ?? '').trim().slice(0, 600);
        const alt = String(o.alt ?? '').replace(/["\n]/g, ' ').trim().slice(0, 140);
        if (!query && !scene) continue;
        seen.add(after);
        out.push({ after, query: query || alt || scene.slice(0, 80), scene: scene || query, alt });
    }
    return out.sort((a, b) => a.after - b.after).slice(0, cap);
}

/** Put a `:::media` line after each chosen block. Pure. */
export function insertPictures(blocks: BodyBlock[], pics: { after: number; assetId: number; alt: string }[]): string {
    const byBlock = new Map<number, string[]>();
    for (const p of pics) {
        const attrs = [`asset=${p.assetId}`, 'type=image'];
        if (p.alt) attrs.push(`alt="${p.alt.replace(/"/g, "'")}"`);
        const line = `:::media{${attrs.join(' ')}}`;
        byBlock.set(p.after, [...(byBlock.get(p.after) || []), line]);
    }
    const parts: string[] = [];
    blocks.forEach((b, i) => { parts.push(b.text); for (const l of byBlock.get(i) || []) parts.push(l); });
    return parts.join('\n\n') + '\n';
}

export interface AddImagesResult {
    added: number;
    /** Why nothing (or less than asked) was added — shown to the owner when added is 0. */
    note?: string;
}

/**
 * Read the post, pick spots, source the pictures, write the body once. Never rewrites the words.
 * Returns `added: 0` with a note (rather than throwing) for the ordinary "nothing to add" outcomes,
 * so the worker can stop without spending retries on them.
 */
export async function addImagesToBlog(
    db: Db,
    opts: { blogPostId: number; organisationId: number; userId: number; source: BlogImageSource; instruction?: string },
): Promise<AddImagesResult> {
    const [post] = await db
        .select({ id: blogPosts.id, title: blogPosts.title, body: blogPosts.bodyMarkdown })
        .from(blogPosts)
        .where(and(eq(blogPosts.id, opts.blogPostId), eq(blogPosts.organisationId, opts.organisationId)))
        .limit(1);
    if (!post) throw new Error('Blog post not found.');

    const blocks = splitBlocks(post.body || '');
    const prose = blocks.filter((b) => b.placeable);
    if (prose.length < 2) return { added: 0, note: 'There is not enough of the article yet to place pictures in — write or draft it first.' };
    const existing = blocks.filter((b) => b.media).length;
    const instruction = (opts.instruction || '').trim().slice(0, 500);

    const listing = blocks
        .map((b, i) => `[${i}]${b.media ? ' (picture already here)' : b.placeable ? '' : ' (not text)'} ${b.text.slice(0, 400)}`)
        .join('\n\n');

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
        model: BLOG_MODEL,
        max_tokens: 1500,
        system:
            'You choose pictures for a blog article that is already written. You never change its words. '
            + 'Respond with valid JSON only.',
        messages: [{ role: 'user', content:
            `Article title: ${post.title || '(untitled)'}\n`
            + `It already has ${existing} picture${existing === 1 ? '' : 's'}.\n\n`
            + `The article, as numbered blocks:\n"""\n${listing}\n"""\n\n`
            + (instruction
                ? `The owner asked: "${instruction.replace(/"/g, "'")}". Follow it — which pictures, where, and how many (at most ${MAX_ADDED_IMAGES}).\n\n`
                : `Decide where a picture would genuinely help a reader — usually 1 or 2, never more than ${MAX_ADDED_IMAGES}, `
                  + 'spread through the article, never two in a row. If it already has enough pictures, choose none.\n\n')
            + 'For each picture give the number of the block it should come AFTER. Only a plain text block (not one marked as a picture or not text).\n'
            + 'Return ONLY: {"placements":[{"after":<block number>,"query":"<3-6 word stock photo search>",'
            + '"scene":"<one or two sentences describing a photograph to make: subject, setting, light; no words, signs or text in it>",'
            + '"alt":"<short alt text for a screen reader>"}]}',
        }],
    });
    void logAiUsage({
        userId: opts.userId, workspaceId: opts.organisationId, model: BLOG_MODEL,
        inputTokens: response.usage?.input_tokens ?? 0, outputTokens: response.usage?.output_tokens ?? 0,
    });
    const raw = stripCodeFences(((response.content[0] as { text?: string })?.text ?? '').trim());
    const parsed = parseModelJson<{ placements?: unknown }>(raw);
    if (!parsed) throw new Error('The assistant’s answer could not be read. Try again.');
    const placements = cleanPlacements(parsed.placements, blocks);
    if (!placements.length) {
        return { added: 0, note: existing
            ? 'Your assistant thinks the article already has the pictures it needs. Say what you want in the box and try again.'
            : 'Your assistant did not find a good place for a picture. Say what you want in the box and try again.' };
    }

    let assetIds: (number | null)[];
    let unpaid = 0;
    if (opts.source === 'stock') {
        assetIds = await sourceBlogImages(db, {
            blogPostId: post.id, organisationId: opts.organisationId, userId: opts.userId,
            queries: placements.map((p) => p.query),
        });
    } else {
        assetIds = [];
        for (const p of placements) {
            const hold = await holdCredits(db, { orgId: opts.organisationId, amount: IMAGE_CREDIT_COST });
            if (!hold.ok) { unpaid++; assetIds.push(null); continue; }
            try {
                const id = await generateAndPersistImage(db, {
                    orgId: opts.organisationId, userId: opts.userId, prompt: p.scene, aspectRatio: '16:9',
                });
                await settleHold(db, { orgId: opts.organisationId, amount: IMAGE_CREDIT_COST, success: true, mediaType: 'image', userId: opts.userId });
                const existingPos = await db.select({ position: blogPostAssets.position })
                    .from(blogPostAssets).where(eq(blogPostAssets.blogPostId, post.id));
                const nextPos = existingPos.reduce((max, r) => Math.max(max, r.position + 1), 0);
                await db.insert(blogPostAssets).values({ blogPostId: post.id, contentAssetId: id, position: nextPos }).onConflictDoNothing();
                assetIds.push(id);
            } catch (err) {
                await settleHold(db, { orgId: opts.organisationId, amount: IMAGE_CREDIT_COST, success: false, mediaType: 'image', userId: opts.userId }).catch(() => {});
                console.error('[blog-add-images] an AI image failed — skipped', { blogPostId: post.id }, err);
                assetIds.push(null);
            }
        }
    }

    const pics = placements
        .map((p, i) => ({ after: p.after, assetId: assetIds[i], alt: p.alt }))
        .filter((p): p is { after: number; assetId: number; alt: string } => typeof p.assetId === 'number');
    if (!pics.length) {
        return { added: 0, note: unpaid
            ? 'Your monthly tasks are used up, so no AI images were made — try stock photos, or wait for the reset on the 1st.'
            : opts.source === 'stock'
                ? 'No suitable stock photos were found. Try describing what you want, or use AI images.'
                : 'The AI images could not be made just now. Nothing was charged — please try again.' };
    }

    await db.update(blogPosts)
        .set({ bodyMarkdown: insertPictures(blocks, pics), updatedAt: new Date() })
        .where(and(eq(blogPosts.id, post.id), eq(blogPosts.organisationId, opts.organisationId)));
    return { added: pics.length, note: unpaid ? `${unpaid} more would have needed tasks you don’t have left this month.` : undefined };
}
