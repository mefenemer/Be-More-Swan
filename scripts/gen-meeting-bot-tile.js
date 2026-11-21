#!/usr/bin/env node
// The Note Taker bot's "camera" in a meeting: a still picture in its video tile, like other note takers show
// ("Taking notes & recording"). Recall shows it through automatic_video_output on the bot (src/utils/meeting-bot.ts).
//
// Recall's rules (docs.recall.ai/docs/output-video-in-meetings, read 2026-11-20): JPEG, 16:9, 1280×720 at most, under
// 1.3 MB, bold text ≥ 50 px, solid colours, and keep everything near the middle because Google Meet crops tiles.
// Drawn at 2560×1440 and scaled down once, as Recall advises.
//
//   node scripts/gen-meeting-bot-tile.js
//
// Writes images/meeting-bot/{recording,not-recording}.jpg (to look at) and src/utils/meeting-bot-tile-data.ts (what
// the bot sends; base64, so no file has to ship with the function). Re-run after changing the design; commit all three.

const fs = require('fs');
const path = require('path');
const { createCanvas, loadImage, GlobalFonts } = require('@napi-rs/canvas');

const ROOT = path.join(__dirname, '..');
const LOGO = path.join(ROOT, 'scripts/assets/BeMoreSwan_SwanAI-master.png');
GlobalFonts.registerFromPath(path.join(ROOT, 'site-fonts/inter.woff2'), 'Inter');

// Recall's limit for the JPEG itself (docs: "The maximum size is 1.3MB"); ours are ~50 KB.
const MAX_JPEG_BYTES = 1_300_000;
const W = 2560, H = 1440;
const BG = '#16111f';       // deep plum, close to black, so the pink swan stands out like a webcam tile
const PINK = '#d82173';     // the swan in the logo
const WHITE = '#ffffff';
const MUTED = '#b9b2c7';
const RED = '#ff3b4e';
const GREY = '#8a8399';

const STATES = {
    recording: { lines: ['Taking notes', '& recording'], dot: RED },
    'not-recording': { lines: ['In the call', 'not recording'], dot: GREY },
};

// Google Meet crops tiles (Recall: keep to the safe zone). On a phone a tile can be PORTRAIT, so everything must fit a
// centred 3:4 portrait crop (0.75 × H wide) with a margin. A real Meet test on 2026-11-21 cut off "Taking notes &
// recording" when it was one line sized for a square. Throws rather than draw a picture that would be cropped.
const SAFE_WIDTH = Math.round(H * 0.75) - 60;
function fitsSafe(what, width) {
    if (width > SAFE_WIDTH) throw new Error(`"${what}" is ${Math.round(width)} px wide; the portrait safe zone is ${SAFE_WIDTH} px`);
}

function centredRow(ctx, parts, y) {
    // parts: [{ draw(x) , width }] laid out side by side, centred.
    const total = parts.reduce((s, p) => s + p.width, 0);
    let x = (W - total) / 2;
    for (const p of parts) { p.draw(x, y); x += p.width; }
}

async function draw(state) {
    const s = STATES[state];
    const c = createCanvas(W, H);
    const ctx = c.getContext('2d');
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);

    // A soft pink glow behind the logo — one wide radial, kept faint (Recall: minimal gradients).
    const glow = ctx.createRadialGradient(W / 2, H * 0.38, 0, W / 2, H * 0.38, W * 0.32);
    glow.addColorStop(0, 'rgba(216,33,115,0.22)');
    glow.addColorStop(1, 'rgba(216,33,115,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);

    // Logo, centred.
    const logo = await loadImage(LOGO);
    const lh = 230, lw = Math.round((logo.width / logo.height) * lh);
    ctx.drawImage(logo, (W - lw) / 2, 250, lw, lh);
    fitsSafe('logo', lw);

    // Name on two lines: "Be More Swan" white, "Note Taker" pink.
    ctx.textBaseline = 'alphabetic';
    ctx.font = '800 136px Inter';
    for (const [text, colour, y] of [['Be More Swan', WHITE, 660], ['Note Taker', PINK, 810]]) {
        const w = ctx.measureText(text).width;
        fitsSafe(text, w);
        ctx.fillStyle = colour;
        ctx.fillText(text, (W - w) / 2, y);
    }

    // Status on two lines, a dot (like a "REC" light) before the first.
    ctx.font = '700 104px Inter';
    const r = 28, gap = 34;
    const [first, second] = s.lines;
    const fw = ctx.measureText(first).width;
    fitsSafe(first, r * 2 + gap + fw);
    centredRow(ctx, [
        { width: r * 2 + gap, draw: (x, y) => { ctx.fillStyle = s.dot; ctx.beginPath(); ctx.arc(x + r, y - 37, r, 0, Math.PI * 2); ctx.fill(); } },
        { width: fw, draw: (x, y) => { ctx.fillStyle = MUTED; ctx.fillText(first, x, y); } },
    ], 1000);
    const sw = ctx.measureText(second).width;
    fitsSafe(second, sw);
    ctx.fillStyle = MUTED;
    ctx.fillText(second, (W - sw) / 2, 1130);

    // Scale down once to 1280×720 with high-quality smoothing.
    const out = createCanvas(1280, 720);
    const octx = out.getContext('2d');
    octx.imageSmoothingEnabled = true;
    octx.imageSmoothingQuality = 'high';
    octx.drawImage(c, 0, 0, 1280, 720);
    return out.encode('jpeg', 90);
}

(async () => {
    const dir = path.join(ROOT, 'images/meeting-bot');
    fs.mkdirSync(dir, { recursive: true });
    const b64 = {};
    for (const state of Object.keys(STATES)) {
        const jpg = await draw(state);
        if (jpg.length > MAX_JPEG_BYTES) throw new Error(`${state}.jpg is ${jpg.length} bytes; Recall's limit is ${MAX_JPEG_BYTES} bytes (1.3 MB)`);
        fs.writeFileSync(path.join(dir, `${state}.jpg`), jpg);
        b64[state] = jpg.toString('base64');
        console.log(`${state}.jpg ${(jpg.length / 1024).toFixed(0)} KB`);
    }
    const ts = `// GENERATED by scripts/gen-meeting-bot-tile.js — do not edit; re-run the script instead.
// The Note Taker bot's video tile in a meeting (JPEG 1280×720, base64). Pictures: images/meeting-bot/.

export const BOT_TILE_RECORDING_JPEG_B64 =
    '${b64.recording}';

export const BOT_TILE_NOT_RECORDING_JPEG_B64 =
    '${b64['not-recording']}';
`;
    fs.writeFileSync(path.join(ROOT, 'src/utils/meeting-bot-tile-data.ts'), ts);
    console.log('wrote src/utils/meeting-bot-tile-data.ts');
})();
