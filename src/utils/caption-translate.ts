// src/utils/caption-translate.ts
//
// Translated captions for a finished Video Producer video (2026-11-11, owner: 1 task per language,
// set in Admin → Money → Task costs as caption_translation). The English caption lines (youtube-video.ts
// videoCaptionLines) are translated line for line, so every line keeps its timing; the result is kept
// on the version's timeline (timeline.captionTranslations[code]) — no column of its own.
//
// What a translation is for: a caption file to download (.srt / .vtt), and an extra caption track on
// YouTube when the video is posted there (once youtube.force-ssl is granted). The burned-in captions
// stay in the language spoken.
//
// Charged only after the translation is saved; a failure costs nothing.

import { eq } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { videoProjects } from '../../db/schema';
import { gatewayGenerate } from '../lib/ai-gateway';
import { CAPTION_LANGUAGES, isCaptionLanguage, MAX_TRANSLATIONS, mergeTranslation, type CaptionLine } from '../lib/youtube-extras';
import { gatewayRoleModel } from './assistant-model';
import { getTaskCosts } from './task-costs';
import { hasTaskCapacity, recordCompletedWork } from './work-metering';
import { translationsOf, videoCaptionLines } from './youtube-video';

type Db = ReturnType<typeof getDb>;
type ProjectRow = typeof videoProjects.$inferSelect;

export function translationPrompt(lines: CaptionLine[], language: string): { system: string; user: string } {
    return {
        system: `You translate video captions from English into ${language} for a small business. Translate each line on its own, keeping its meaning, tone and length close to the English so it fits the same moment on screen. Keep names, brand names, prices, web addresses and hashtags as they are. Use the natural everyday wording a native speaker would use, not a word-for-word translation. Reply with a JSON array of strings only: exactly one translated string for each line, in the same order, with no other text.`,
        user: JSON.stringify(lines.map((l) => l.t)),
    };
}

/** The JSON array in a model reply, or null. Pure. */
export function parseTranslationReply(text: string): unknown[] | null {
    const m = String(text ?? '').match(/\[[\s\S]*\]/);
    if (!m) return null;
    try { const v = JSON.parse(m[0]); return Array.isArray(v) ? v : null; } catch { return null; }
}

export type TranslateResult = { ok: true; code: string; lines: number; tasks: number } | { ok: false; status: number; error: string; cost?: number };

/** Translate a ready video's captions into `code`, save them, then charge. */
export async function translateCaptions(db: Db, row: ProjectRow, code: unknown): Promise<TranslateResult> {
    if (row.status !== 'ready' || !row.timeline) return { ok: false, status: 409, error: 'Captions are translated on a finished video.' };
    if (!isCaptionLanguage(code)) return { ok: false, status: 400, error: 'Choose a language from the list.' };
    const have = translationsOf(row.timeline);
    if (!have[code] && Object.keys(have).length >= MAX_TRANSLATIONS) return { ok: false, status: 409, error: `A video can have up to ${MAX_TRANSLATIONS} translations. Remove one first.` };
    const english = await videoCaptionLines(db, row.organisationId, row.timeline);
    if (!english.length) return { ok: false, status: 409, error: 'This video has no spoken words to translate.' };
    const cost = (await getTaskCosts()).weights.caption_translation;
    if (cost > 0 && !(await hasTaskCapacity(db, row.organisationId, cost))) return { ok: false, status: 402, error: 'insufficient_credits', cost };

    const language = CAPTION_LANGUAGES[code];
    const prompt = translationPrompt(english, language);
    const model = await gatewayRoleModel(db, 'video_producer').catch(() => ({}));
    const res = await gatewayGenerate({
        system: prompt.system, messages: [{ role: 'user', content: prompt.user }],
        maxTokens: Math.min(8000, 200 + english.length * 60), deadlineMs: 90_000,
        usage: { workspaceId: row.organisationId, assistantId: row.aiAssistantId ?? null },
        ...model,
    });
    const merged = mergeTranslation(english, parseTranslationReply(res.text));
    if ('error' in merged) return { ok: false, status: 502, error: merged.error };

    // Re-read the timeline so a rename or a results refresh in the meantime isn't lost.
    const [fresh] = await db.select({ timeline: videoProjects.timeline }).from(videoProjects).where(eq(videoProjects.id, row.id)).limit(1);
    const tl = (fresh?.timeline ?? row.timeline) as Record<string, unknown>;
    const prev = (tl.captionTranslations ?? {}) as Record<string, unknown>;
    await db.update(videoProjects).set({ timeline: { ...tl, captionTranslations: { ...prev, [code]: { lines: merged, at: new Date().toISOString() } } }, updatedAt: new Date() })
        .where(eq(videoProjects.id, row.id));
    if (cost > 0) await recordCompletedWork(db, row.organisationId, 'caption_translation', { units: cost, ref: `video-project-${row.id}-${code}`, assistantId: row.aiAssistantId ?? null });
    return { ok: true, code, lines: merged.length, tasks: cost };
}

/** Remove one translation. Free. */
export async function removeTranslation(db: Db, row: ProjectRow, code: unknown): Promise<boolean> {
    if (typeof code !== 'string' || !row.timeline) return false;
    const tl = row.timeline as Record<string, unknown>;
    const prev = { ...((tl.captionTranslations ?? {}) as Record<string, unknown>) };
    if (!(code in prev)) return false;
    delete prev[code];
    await db.update(videoProjects).set({ timeline: { ...tl, captionTranslations: prev }, updatedAt: new Date() }).where(eq(videoProjects.id, row.id));
    return true;
}
