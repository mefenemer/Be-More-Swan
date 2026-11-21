// src/utils/meeting-bot-tile.ts — the Note Taker bot's picture in a call, drawn for each workspace when the bot is sent.
//
// Owner, 2026-11-21 (said in the EU test call): the company's name large, "Hi, I'm ⟨assistant⟩ from ⟨company⟩" above it,
// "Note Taker" and what it is doing below, and "Powered by Be More Swan" at the bottom.
//
// Recall's rules (docs.recall.ai/docs/output-video-in-meetings, read 2026-11-20): JPEG, 16:9, 1280×720 at most, under
// 1.3 MB, bold text ≥ 50 px, solid colours, everything near the middle because Google Meet crops tiles to a square.
// Drawn at 2560×1440 and scaled down once. Text that would not fit is made smaller, then wrapped, then cut with "…" —
// never drawn outside the square.
//
// @napi-rs/canvas is loaded only when a picture is drawn (it is external in netlify.toml for meeting-bots), and the
// font + swan come from meeting-bot-tile-assets.ts. Only netlify/functions/meeting-bots.ts imports this file.

import type { BotVideoTile } from './meeting-bot';
import { TILE_FONT_CODEPOINTS, TILE_FONT_WOFF2_B64, TILE_SWAN_PNG_B64 } from './meeting-bot-tile-assets';

type CanvasLib = typeof import('@napi-rs/canvas');
type Ctx = import('@napi-rs/canvas').SKRSContext2D;

export type TileState = 'recording' | 'not-recording';
export interface TileNames { assistantName: string | null | undefined; businessName: string | null | undefined }

export const TILE_W = 2560;
export const TILE_H = 1440;
/** Google Meet crops tiles, and on a phone a tile can be PORTRAIT: everything fits a centred 3:4 crop with a margin
 *  (a real Meet test on 2026-11-21 cut off a one-line status sized for a square; e6499d91). */
export const TILE_SAFE_WIDTH = Math.round(TILE_H * 0.75) - 60;
export const MAX_JPEG_BYTES = 1_300_000;

const BG = '#16111f';
const PINK = '#d82173';
const WHITE = '#ffffff';
const MUTED = '#b9b2c7';
const RED = '#ff3b4e';
const GREY = '#8a8399';
const FONT = 'Inter';

// Two lines, so a narrow portrait tile doesn't cut it off (e6499d91).
const STATUS: Record<TileState, { lines: [string, string]; dot: string }> = {
    recording: { lines: ['Taking notes', '& recording'], dot: RED },
    'not-recording': { lines: ['In the call', 'not recording'], dot: GREY },
};

/** True when the tile's font has this character (TILE_FONT_CODEPOINTS, measured by the generator script). Pure. */
export function fontHas(cp: number): boolean {
    let lo = 0, hi = TILE_FONT_CODEPOINTS.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const [a, b] = TILE_FONT_CODEPOINTS[mid];
        if (cp < a) hi = mid - 1; else if (cp > b) lo = mid + 1; else return true;
    }
    return false;
}

/** Every character can be drawn (no box in the customer's call; review of #800). Pure. */
export function canDraw(text: string): boolean {
    for (const ch of text) if (!fontHas(ch.codePointAt(0)!)) return false;
    return true;
}

/**
 * A name as the tile can show it: emoji and their joiners removed, spaces tidied. A name with any letter the font
 * can't draw (Ł, Cyrillic, Greek, CJK…) counts as no name, so the tile uses its general words rather than a box. Pure.
 */
export function drawableName(s: string | null | undefined, max: number): string {
    const name = String(s ?? '').normalize('NFC')
        .replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\u200d\ufe0e\ufe0f\u20e3]/gu, '')
        .replace(/\s+/g, ' ').trim().slice(0, max).trim();
    return canDraw(name) ? name : '';
}

/** The words on the tile, top to bottom. Pure. With no business name the tile is Be More Swan's own. */
export function tileWords(names: TileNames, state: TileState): { greeting: string | null; shortGreeting: string | null; business: string; noteTaker: string; status: [string, string]; poweredBy: string | null } {
    const business = drawableName(names.businessName, 80);
    const assistant = drawableName(names.assistantName, 40);
    if (!business) return { greeting: null, shortGreeting: null, business: 'Be More Swan', noteTaker: 'Note Taker', status: STATUS[state].lines, poweredBy: null };
    return {
        greeting: assistant ? `Hi, I'm ${assistant} from ${business}` : `Hi, I'm the Note Taker from ${business}`,
        // When the whole greeting won't fit: the company is written large just below, so it can go.
        shortGreeting: assistant ? `Hi, I'm ${assistant}` : null,
        business,
        noteTaker: 'Note Taker',
        status: STATUS[state].lines,
        poweredBy: 'Powered by Be More Swan',
    };
}

/** Width of a string at a size, as the canvas measures it. Injected so the wrapping can be tested without a canvas. */
export type Measure = (text: string, size: number) => number;

/**
 * Break `text` into at most `maxLines` lines no wider than `width`, at the largest size in `sizes` that fits.
 * At the smallest size it still wraps, and a last line that is too long is cut with "…". Pure.
 */
export function fitLines(text: string, sizes: number[], width: number, maxLines: number, measure: Measure): { size: number; lines: string[]; cut: boolean } {
    const words = text.split(' ').filter(Boolean);
    const wrap = (size: number): string[] | null => {
        const lines: string[] = [];
        let line = '';
        for (const w of words) {
            const next = line ? `${line} ${w}` : w;
            if (measure(next, size) <= width) { line = next; continue; }
            if (!line) return null; // one word wider than the line
            lines.push(line);
            line = w;
            if (measure(line, size) > width) return null;
        }
        if (line) lines.push(line);
        return lines.length <= maxLines ? lines : null;
    };
    for (const size of sizes) {
        const lines = wrap(size);
        if (lines) return { size, lines, cut: false };
    }
    // Still too long at the smallest size: fill the lines word by word, then cut the last one with "…".
    // Whole words only where possible ("The Northumberland Coastal…", never "The / Northumberland C…"); a single word
    // wider than the line is cut by characters.
    const size = sizes[sizes.length - 1];
    const fits = (s: string) => measure(s, size) <= width;
    const chop = (s: string) => { let c = s; while (c.length > 1 && !fits(`${c}…`)) c = c.slice(0, -1); return `${c.trimEnd()}…`; };
    const lines: string[] = [];
    let i = 0;
    while (lines.length < maxLines - 1 && i < words.length) {
        if (!fits(words[i])) break; // an over-long word goes on the last line, cut
        let line = words[i++];
        while (i < words.length && fits(`${line} ${words[i]}`)) line += ` ${words[i++]}`;
        lines.push(line);
    }
    if (i < words.length) {
        let last = '';
        while (i < words.length && fits(`${last ? `${last} ` : ''}${words[i]}…`)) last = `${last ? `${last} ` : ''}${words[i++]}`;
        lines.push(last ? (i < words.length ? `${last}…` : last) : chop(words[i]));
    }
    return { size, lines, cut: true };
}

let fontsReady = false;
async function canvasLib(): Promise<CanvasLib> {
    const lib = await import('@napi-rs/canvas') as unknown as CanvasLib & { default?: CanvasLib };
    const c = (lib.GlobalFonts ? lib : lib.default) as CanvasLib;
    if (!fontsReady) {
        // register() answers null rather than throwing; without the font every picture would be wrong, so throw and let
        // sendMeetingBot send the fallback picture (review of #800).
        if (!c.GlobalFonts.register(Buffer.from(TILE_FONT_WOFF2_B64, 'base64'), FONT)) throw new Error('tile font not registered');
        fontsReady = true;
    }
    return c;
}

interface Block { size: number; weight: number; colour: string; lines: string[]; gapBefore: number; dot?: string; swan?: boolean }

/** One tile as a 1280×720 JPEG. */
export async function drawTile(names: TileNames, state: TileState, lib?: CanvasLib): Promise<Buffer> {
    const c = lib ?? await canvasLib();
    const canvas = c.createCanvas(TILE_W, TILE_H);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, TILE_W, TILE_H);
    const glow = ctx.createRadialGradient(TILE_W / 2, TILE_H * 0.45, 0, TILE_W / 2, TILE_H * 0.45, TILE_W * 0.32);
    glow.addColorStop(0, 'rgba(216,33,115,0.20)');
    glow.addColorStop(1, 'rgba(216,33,115,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, TILE_W, TILE_H);

    const font = (size: number, weight: number) => `${weight} ${size}px ${FONT}`;
    const measureAt = (weight: number): Measure => (text, size) => { ctx.font = font(size, weight); return ctx.measureText(text).width; };
    const words = tileWords(names, state);
    const dotRoom = 56 + 36; // the status dot and its gap
    const swanH = 96, swanGap = 28;
    const swanImg = words.poweredBy ? await c.loadImage(Buffer.from(TILE_SWAN_PNG_B64, 'base64')) : null;
    const swanRoom = swanImg ? swanH * (swanImg.width / swanImg.height) + swanGap : 0;

    const blocks: Block[] = [];
    if (words.greeting) {
        let g = fitLines(words.greeting, [110, 100], TILE_SAFE_WIDTH, 2, measureAt(600));
        if (g.cut && words.shortGreeting) g = fitLines(words.shortGreeting, [110, 100], TILE_SAFE_WIDTH, 2, measureAt(600));
        blocks.push({ ...g, weight: 600, colour: MUTED, gapBefore: 0 });
    }
    const b = fitLines(words.business, [200, 180, 160, 140, 120, 104], TILE_SAFE_WIDTH, 2, measureAt(800));
    blocks.push({ ...b, weight: 800, colour: WHITE, gapBefore: words.greeting ? 40 : 0 });
    blocks.push({ size: 120, weight: 800, colour: PINK, lines: [words.noteTaker], gapBefore: 70 });
    blocks.push({ size: 100, weight: 700, colour: MUTED, lines: [...words.status], gapBefore: 20, dot: STATUS[state].dot });
    if (words.poweredBy) {
        const p = fitLines(words.poweredBy, [72, 64, 56], TILE_SAFE_WIDTH - swanRoom, 1, measureAt(600));
        blocks.push({ ...p, weight: 600, colour: MUTED, gapBefore: 90, swan: true });
    }

    const lineH = (blk: Block) => Math.round(blk.size * (blk.swan ? 1.3 : 1.18));
    const total = blocks.reduce((sum, blk) => sum + blk.gapBefore + blk.lines.length * lineH(blk), 0);
    let y = Math.round((TILE_H - total) / 2);

    const swan = swanImg;
    ctx.textBaseline = 'middle';
    for (const blk of blocks) {
        y += blk.gapBefore;
        ctx.font = font(blk.size, blk.weight);
        for (const [n, line] of blk.lines.entries()) {
            if (!canDraw(line)) throw new Error('tile text has a character the font cannot draw');
            const mid = y + lineH(blk) / 2;
            const tw = ctx.measureText(line).width;
            const dotHere = Boolean(blk.dot) && n === 0; // the "REC" light before the first status line only
            const lead = dotHere ? dotRoom : blk.swan && swan ? swanRoom : 0;
            if (lead + tw > TILE_SAFE_WIDTH + 1) throw new Error('tile text wider than the safe zone');
            const x = (TILE_W - (lead + tw)) / 2;
            if (dotHere) {
                ctx.fillStyle = blk.dot!;
                ctx.beginPath();
                ctx.arc(x + 28, mid, 28, 0, Math.PI * 2);
                ctx.fill();
            }
            if (blk.swan && swan) ctx.drawImage(swan, x, mid - swanH / 2, swanH * (swan.width / swan.height), swanH);
            ctx.fillStyle = blk.colour;
            ctx.fillText(line, x + lead, mid);
            y += lineH(blk);
        }
    }

    const out = c.createCanvas(1280, 720);
    const octx = out.getContext('2d') as Ctx;
    octx.imageSmoothingEnabled = true;
    octx.imageSmoothingQuality = 'high';
    octx.drawImage(canvas, 0, 0, 1280, 720);
    const jpg = await out.encode('jpeg', 90);
    if (jpg.length > MAX_JPEG_BYTES) throw new Error(`tile is ${jpg.length} bytes; Recall's limit is ${MAX_JPEG_BYTES}`);
    return jpg;
}

/** Both pictures for one bot, base64 as Recall takes them. */
export async function drawBotTiles(names: TileNames): Promise<BotVideoTile> {
    const [rec, notRec] = await Promise.all([drawTile(names, 'recording'), drawTile(names, 'not-recording')]);
    return { recordingJpegB64: rec.toString('base64'), notRecordingJpegB64: notRec.toString('base64') };
}
