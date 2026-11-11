// src/lib/video-chapters.ts
//
// Chapters on a finished Video Producer video (2026-11-11).
//
//   · In the app — the Videos tab lists a video's chapters under the player; clicking one jumps there.
//     A chapter is a run of scenes that share a story beat (hook → problem → value → proof → call to
//     action), so a 60-second video has four or five and a short one may have two.
//   · The owner (or the chat, on a card) can rename a chapter. Names are kept on the version's
//     timeline (timeline.chapterTitles, keyed by the chapter's first scene id) — no column of its own.
//   · On YouTube — the chapters go at the end of the description as "0:00 Title" lines, the format
//     YouTube reads as chapters. YouTube only shows them when the first is at 0:00, there are at least
//     three, and each is at least 10 seconds long, so short chapters are folded into their neighbour
//     and a video that can't meet that gets no lines at all (youtubeChapterLines → null).
//
// PURE. Tested in tests/video-chapters.test.ts.

import type { Scene } from './storyboard';
import { sceneTimes, type SceneTime } from './video-notes';

export interface Chapter {
    /** The first scene of the chapter — the key its renamed title is kept under. */
    sceneId: string;
    startS: number;
    endS: number;
    title: string;
    /** 1-based scene numbers in it, for "scenes 2–3". */
    scenes: number[];
    /** True when the owner named it; false = the name was worked out from its words. */
    named: boolean;
}

export const CHAPTER_TITLE_MAX = 60;
/** A name worked out from a voiceover is cut, at a word, past this many characters. */
export const AUTO_TITLE_MAX = 48;
/** YouTube's rules for description chapters. */
export const YT_MIN_CHAPTERS = 3;
export const YT_MIN_CHAPTER_S = 10;

const BEAT_NAMES: Record<string, string> = {
    hook: 'Intro', problem: 'The problem', value: 'How it helps', proof: 'Proof', cta: 'What to do next',
};

type SceneLike = Pick<Scene, 'id' | 'beat' | 'voiceover' | 'onScreenText'>;

/** A clean chapter title, or '' when there's nothing usable. Pure. */
export function cleanChapterTitle(raw: unknown): string {
    if (typeof raw !== 'string') return '';
    // One line, no leading timestamp (it would be read as a second chapter on YouTube), no angle brackets
    // (YouTube refuses a description with them).
    return raw.replace(/[\r\n\t]+/g, ' ').replace(/[<>]/g, '').replace(/^\s*\d{1,2}(:\d{2}){1,2}\s*[-–—:]?\s*/, '')
        .replace(/\s+/g, ' ').trim().slice(0, CHAPTER_TITLE_MAX).trim();
}

/** A chapter's name from its first scene's words: the words on screen, else the voiceover's first phrase, else its beat. Pure. */
export function defaultChapterTitle(scene: SceneLike): string {
    const onScreen = cleanChapterTitle(String(scene.onScreenText ?? '').split('\n')[0]);
    if (onScreen) return onScreen;
    const first = String(scene.voiceover ?? '').split(/(?<=[.!?])\s|[—–;:]/)[0] ?? '';
    const words = cleanChapterTitle(first).replace(/[.!?,]+$/, '');
    if (words) {
        if (words.length <= AUTO_TITLE_MAX) return words;
        const cut = words.slice(0, AUTO_TITLE_MAX + 1);
        const at = cut.lastIndexOf(' ');
        return `${(at > 20 ? cut.slice(0, at) : cut.slice(0, AUTO_TITLE_MAX)).replace(/[\s.,;:!?—–-]+$/, '')}…`;
    }
    return BEAT_NAMES[scene.beat] ?? 'Chapter';
}

/**
 * The video's chapters: consecutive scenes that share a beat, placed by the timeline's scene times.
 * Scenes with no time (an old timeline) are skipped. `titles` = the owner's names, by first scene id. Pure.
 */
export function videoChapters(scenes: SceneLike[], times: SceneTime[], titles?: Record<string, unknown> | null): Chapter[] {
    if (!scenes.length || !times.length) return [];
    const byId = new Map(scenes.map((s, i) => [s.id, { s, n: i + 1 }]));
    const out: Chapter[] = [];
    let lastBeat: string | null = null;
    for (const t of times) {
        const hit = byId.get(t.sceneId);
        if (!hit) continue;
        const prev = out[out.length - 1];
        if (prev && hit.s.beat === lastBeat) {
            prev.endS = t.endS;
            prev.scenes.push(hit.n);
            continue;
        }
        lastBeat = hit.s.beat;
        const own = cleanChapterTitle(titles?.[t.sceneId]);
        out.push({ sceneId: t.sceneId, startS: t.startS, endS: t.endS, title: own || defaultChapterTitle(hit.s), scenes: [hit.n], named: !!own });
    }
    // The first chapter starts the video, whatever a stray rounding says.
    if (out.length) out[0].startS = 0;
    return out;
}

/** m:ss (or h:mm:ss) as YouTube writes a chapter time. Pure. */
export function chapterTime(s: number): string {
    const t = Math.max(0, Math.floor(Number(s) || 0));
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = String(t % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/**
 * Chapters as YouTube needs them: any chapter under 10 seconds joins the one before it (the first joins
 * the next), keeping the earlier title. Null when fewer than three are left. Pure.
 */
export function youtubeChapters(chapters: Chapter[], durationS?: number | null): Chapter[] | null {
    if (chapters.length < YT_MIN_CHAPTERS) return null;
    const list = chapters.map((c) => ({ ...c, scenes: [...c.scenes] }));
    if (durationS && Number.isFinite(durationS) && durationS > 0) list[list.length - 1].endS = Math.max(list[list.length - 1].endS, durationS);
    const len = (c: Chapter) => c.endS - c.startS;
    let changed = true;
    while (changed && list.length >= YT_MIN_CHAPTERS) {
        changed = false;
        const i = list.findIndex((c) => len(c) < YT_MIN_CHAPTER_S);
        if (i === -1) break;
        if (i === 0) {
            list[1] = { ...list[1], startS: 0, sceneId: list[0].sceneId, title: list[0].title, named: list[0].named, scenes: [...list[0].scenes, ...list[1].scenes] };
            list.splice(0, 1);
        } else {
            list[i - 1] = { ...list[i - 1], endS: list[i].endS, scenes: [...list[i - 1].scenes, ...list[i].scenes] };
            list.splice(i, 1);
        }
        changed = true;
    }
    if (list.length < YT_MIN_CHAPTERS || list.some((c) => len(c) < YT_MIN_CHAPTER_S)) return null;
    list[0].startS = 0;
    return list;
}

/** The "0:00 Title" block for a YouTube description, or null when YouTube wouldn't show chapters. Pure. */
export function youtubeChapterLines(chapters: Chapter[], durationS?: number | null): string | null {
    const yt = youtubeChapters(chapters, durationS);
    return yt ? yt.map((c) => `${chapterTime(c.startS)} ${c.title}`).join('\n') : null;
}

/** Does this text already hold YouTube chapter lines (a "0:00" line)? Then we add none. Pure. */
export function hasChapterLines(text: string): boolean {
    return /(^|\n)\s*0?0:00\b/.test(text || '');
}

/** The description with the chapters added at the end, kept within `max` characters. Pure. */
export function withChapterLines(description: string, lines: string | null, max: number): string {
    if (!lines || hasChapterLines(description)) return description;
    const block = `Chapters\n${lines}`;
    if (block.length + 2 > max) return description;
    const room = max - block.length - 2;
    const body = (description || '').slice(0, room).trimEnd();
    return body ? `${body}\n\n${block}` : block;
}

/**
 * Rename chapter `n` (1-based) — or the one starting at `sceneId` — to `title`; '' puts its own name
 * back. Returns the new titles map, or why not. Pure.
 */
export function renameChapter(chapters: Chapter[], titles: Record<string, unknown> | null | undefined, at: { n?: number; sceneId?: string }, title: unknown): { titles: Record<string, string>; chapter: Chapter } | { error: string } {
    const ch = at.sceneId ? chapters.find((c) => c.sceneId === at.sceneId) : (Number.isInteger(at.n) && at.n! > 0 ? chapters[at.n! - 1] : undefined);
    if (!ch) return { error: 'That chapter isn’t on this video.' };
    const clean = cleanChapterTitle(title);
    if (typeof title === 'string' && title.trim() && !clean) return { error: 'Give the chapter a name in words.' };
    const keep = new Set(chapters.map((c) => c.sceneId));
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(titles ?? {})) { const c = cleanChapterTitle(v); if (c && keep.has(k)) next[k] = c; }
    if (clean) next[ch.sceneId] = clean; else delete next[ch.sceneId];
    return { titles: next, chapter: { ...ch, title: clean || ch.title, named: !!clean } };
}

export type ChaptersWhyNot = 'short' | 'not_wide' | null;

/**
 * A finished video's chapters, and its YouTube chapter lines — null when YouTube wouldn't show them: too
 * few or too short ('short'), or not wide ('not_wide': a vertical or square video under three minutes
 * becomes a Short on YouTube, and Shorts have no chapters). Takes the project row's jsonb as stored. Pure.
 */
export function chaptersFor(row: { timeline: unknown; brief: unknown; storyboard: unknown }, durationS?: number | null): { chapters: Chapter[]; youtubeChapters: string | null; chaptersWhyNot: ChaptersWhyNot } {
    const tl = row.timeline as ({ durationS?: number; chapterTitles?: Record<string, string> } & Parameters<typeof sceneTimes>[0]) | null;
    const scenes = (row.storyboard as { scenes?: SceneLike[] } | null)?.scenes;
    if (!tl || !scenes?.length) return { chapters: [], youtubeChapters: null, chaptersWhyNot: null };
    const chapters = videoChapters(scenes, sceneTimes(tl), tl.chapterTitles);
    const lines = youtubeChapterLines(chapters, durationS ?? tl.durationS ?? null);
    const wide = ((row.brief as { shape?: string } | null)?.shape ?? '9:16') === '16:9' || (tl.durationS ?? 0) > 180;
    return { chapters, youtubeChapters: lines && wide ? lines : null, chaptersWhyNot: !lines ? 'short' : !wide ? 'not_wide' : null };
}
