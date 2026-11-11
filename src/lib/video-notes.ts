// src/lib/video-notes.ts
//
// Notes on a moment of a finished video, and the two "words only" ways of changing a storyboard.
//
//   · Moment notes — on a Ready video the owner clicks a point in the player and leaves a note
//     ("too fast here", "show the cake"). Each note is tied to the scene playing at that moment
//     (from the timeline's scene times). "Make a new version from my notes" turns them into edits of
//     those scenes only; every other scene, and everything already made for it, is kept.
//   · Script first — the voiceover can be approved, or rewritten, on its own before any picture is
//     made. A rewrite changes words only: each scene keeps its source, search words, picture and cut,
//     so no picture is sourced again (mergeScript).
//
// PURE. Tested in tests/video-producer-seven.test.ts.

import type { Scene, Storyboard } from './storyboard';

export interface MomentNote {
    id: string;
    /** Seconds into the finished video. */
    atS: number;
    /** The scene playing then (storyboard scene id), or null when it can't be told. */
    sceneId: string | null;
    text: string;
    /** ISO time it was left, and who left it (user id; null = from a chat card's approval is still a user). */
    at: string;
    by: number | null;
}

export const MAX_NOTES = 30;
export const NOTE_MAX_CHARS = 300;

/** Where each scene sits on the finished video. */
export interface SceneTime { sceneId: string; startS: number; endS: number }

type ClipLike = { id?: string; holdS?: number; inS?: number; outS?: number };

/**
 * Each scene's place on the finished video. A timeline built since 2026-11-10 carries them
 * (timeline.sceneTimes); an older one is read from its clips, whose ids are `vp_<sceneId>` or
 * `vp_<sceneId>_<piece>` (a tightened scene has several). Pure.
 */
export function sceneTimes(timeline: { sceneTimes?: SceneTime[]; videoEdit?: { clips?: ClipLike[] } } | null | undefined): SceneTime[] {
    if (!timeline) return [];
    if (Array.isArray(timeline.sceneTimes) && timeline.sceneTimes.length) return timeline.sceneTimes;
    const out: SceneTime[] = [];
    let t = 0;
    for (const c of timeline.videoEdit?.clips ?? []) {
        const m = /^vp_(s\d+)(?:_\d+)?$/.exec(String(c.id ?? ''));
        const len = c.holdS != null ? Number(c.holdS) : (Number(c.outS ?? 0) - Number(c.inS ?? 0));
        const d = Number.isFinite(len) && len > 0 ? len : 0;
        if (m) {
            const last = out[out.length - 1];
            if (last && last.sceneId === m[1]) last.endS = r2(t + d);
            else out.push({ sceneId: m[1], startS: r2(t), endS: r2(t + d) });
        }
        t += d;
    }
    return out;
}

/** The scene playing `t` seconds in (the last one past the end), or null. Pure. */
export function sceneAt(times: SceneTime[], t: number): string | null {
    if (!times.length || !Number.isFinite(t)) return null;
    const hit = times.find((s) => t >= s.startS && t < s.endS);
    return hit ? hit.sceneId : (t >= times[times.length - 1].endS ? times[times.length - 1].sceneId : times[0].sceneId);
}

/** Read stored notes, dropping anything malformed. Pure. */
export function readNotes(raw: unknown): MomentNote[] {
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((n) => {
        const o = (n && typeof n === 'object' ? n : {}) as Record<string, unknown>;
        const text = String(o.text ?? '').trim();
        const atS = Number(o.atS);
        if (!text || !Number.isFinite(atS) || typeof o.id !== 'string') return [];
        return [{ id: o.id, atS: Math.max(0, atS), sceneId: typeof o.sceneId === 'string' ? o.sceneId : null, text: text.slice(0, NOTE_MAX_CHARS), at: String(o.at ?? ''), by: o.by == null ? null : Number(o.by) }];
    }).slice(0, MAX_NOTES);
}

/** Add one note at `atS`, tied to its scene. Returns the new list, or why not. Pure. */
export function addNote(notes: MomentNote[], args: { id: string; atS: number; text: string; times: SceneTime[]; by: number | null; now: Date; durationS?: number | null }): { notes: MomentNote[]; note: MomentNote } | { error: string } {
    const text = String(args.text ?? '').replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX_CHARS);
    if (!text) return { error: 'Write what should change at that moment.' };
    if (notes.length >= MAX_NOTES) return { error: `A video can have ${MAX_NOTES} notes at most — make a new version from these first.` };
    let atS = Number(args.atS);
    if (!Number.isFinite(atS) || atS < 0) atS = 0;
    if (args.durationS && atS > args.durationS) atS = args.durationS;
    atS = Math.round(atS * 10) / 10;
    const note: MomentNote = { id: args.id, atS, sceneId: sceneAt(args.times, atS), text, at: args.now.toISOString(), by: args.by };
    return { notes: [...notes, note].sort((a, b) => a.atS - b.atS), note };
}

/** The notes per scene, in time order. Notes with no scene are left out. Pure. */
export function notesByScene(notes: MomentNote[]): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const n of [...notes].sort((a, b) => a.atS - b.atS)) if (n.sceneId) (out[n.sceneId] ??= []).push(n.text);
    return out;
}

/** m:ss. Pure. */
export function mmss(s: number): string {
    const t = Math.max(0, Math.floor(Number(s) || 0));
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

/**
 * Take the model's version of the noted scenes only. Every scene without a note is kept exactly as
 * it was (same id, words, picture, cut); a noted scene takes the model's words, on-screen text, name
 * caption and — when the note asks for a different picture — its source, search words or prompt.
 * Scene count and order never change. Pure.
 */
export function mergeNotedScenes(old: Storyboard, raw: unknown, noted: string[]): Storyboard {
    const rs = rawScenes(raw);
    const set = new Set(noted);
    const scenes = old.scenes.map((s, i) => {
        if (!set.has(s.id)) return s;
        const n = rs[i];
        if (!n) return s;
        const out: Scene = { ...s };
        if (typeof n.voiceover === 'string' && n.voiceover.trim()) out.voiceover = n.voiceover;
        if (typeof n.onScreenText === 'string') { if (n.onScreenText.trim()) out.onScreenText = n.onScreenText; else delete out.onScreenText; }
        if (typeof n.source === 'string' && n.source && n.source !== s.source) out.source = n.source as Scene['source'];
        if (typeof n.keywords === 'string' && n.keywords.trim()) out.keywords = n.keywords;
        if (typeof n.prompt === 'string' && n.prompt.trim()) out.prompt = n.prompt;
        if (n.nameCaption && typeof n.nameCaption === 'object') out.nameCaption = n.nameCaption as Scene['nameCaption'];
        return out;
    });
    return { ...old, scenes };
}

/**
 * A script rewrite: the model's voiceover and on-screen text for each scene, onto the scenes as they
 * are. Nothing a picture depends on changes — source, search words, prompt, picture, cut — so no
 * scene is sourced again. A branded card's words are drawn into its picture, so its on-screen text is
 * kept too. Pure.
 */
export function mergeScript(old: Storyboard, raw: unknown): Storyboard {
    const rs = rawScenes(raw);
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const scenes = old.scenes.map((s, i) => {
        const n = rs[i];
        if (!n) return s;
        const out: Scene = { ...s };
        if (typeof n.voiceover === 'string' && n.voiceover.trim()) out.voiceover = n.voiceover;
        if (s.source !== 'brand_card' && typeof n.onScreenText === 'string') {
            if (n.onScreenText.trim()) out.onScreenText = n.onScreenText; else delete out.onScreenText;
        }
        return out;
    });
    return { ...old, scenes, caption: typeof r.caption === 'string' && r.caption.trim() ? r.caption : old.caption };
}

function rawScenes(raw: unknown): Array<Record<string, unknown>> {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    return (Array.isArray(r.scenes) ? r.scenes : []).map((x) => (x && typeof x === 'object' ? x : {}) as Record<string, unknown>);
}

const r2 = (n: number) => Math.round(n * 100) / 100;
