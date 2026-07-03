// Regenerate the favicon assets from the cleaned swan artwork so the icon actually fills the tab
// (the old one was tiny). Crops to the swan (largest connected component), squares it with a little
// padding, and box-downsamples (alpha-premultiplied) to every size the site already references —
// overwriting the existing files by name, so no HTML <link> needs to change. Pure Node (no sharp).
// Run:  node scripts/gen-favicons.js
const fs = require('fs');
const zlib = require('zlib');

const SRC = 'images/BeMoreSwan_SwanAI.png';

// ── PNG decode → {w,h,rgba} ──
function decode(buf) {
    let p = 8, w, h, idat = [];
    while (p < buf.length) {
        const len = buf.readUInt32BE(p);
        const type = buf.toString('ascii', p + 4, p + 8);
        const data = buf.slice(p + 8, p + 8 + len);
        if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); }
        if (type === 'IDAT') idat.push(data);
        if (type === 'IEND') break;
        p += 12 + len;
    }
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const stride = w * 4 + 1;
    const out = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) {
        const ft = raw[y * stride];
        for (let x = 0; x < w * 4; x++) {
            const v = raw[y * stride + 1 + x];
            const a = x >= 4 ? out[y * w * 4 + x - 4] : 0;
            const b = y > 0 ? out[(y - 1) * w * 4 + x] : 0;
            const c = (x >= 4 && y > 0) ? out[(y - 1) * w * 4 + x - 4] : 0;
            let val;
            if (ft === 0) val = v; else if (ft === 1) val = v + a; else if (ft === 2) val = v + b;
            else if (ft === 3) val = v + ((a + b) >> 1);
            else { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); val = v + ((pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c)); }
            out[y * w * 4 + x] = val & 255;
        }
    }
    return { w, h, rgba: out };
}

// ── PNG encode (filter 0) ──
const CRCT = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
const crc32 = (b) => { let c = ~0; for (let i = 0; i < b.length; i++) c = CRCT[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return ~c >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'ascii'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
function encode(w, h, rgba) {
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
    const stride = w * 4 + 1, raw = Buffer.alloc(h * stride);
    for (let y = 0; y < h; y++) { raw[y * stride] = 0; rgba.copy(raw, y * stride + 1, y * w * 4, (y + 1) * w * 4); }
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// ── largest connected component (the swan) → bbox ──
function swanBBox(img) {
    const { w, h, rgba } = img;
    const A = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) A[i] = rgba[i * 4 + 3] > 40 ? 1 : 0;
    const label = new Int32Array(w * h);
    let cur = 0, bestArea = 0, bb = {};
    for (let s = 0; s < w * h; s++) {
        if (!A[s] || label[s]) continue;
        cur++; let area = 0, mnx = w, mxx = 0, mny = h, mxy = 0; const st = [s]; label[s] = cur;
        while (st.length) {
            const q = st.pop(); area++; const x = q % w, y = (q / w) | 0;
            if (x < mnx) mnx = x; if (x > mxx) mxx = x; if (y < mny) mny = y; if (y > mxy) mxy = y;
            if (x > 0 && A[q - 1] && !label[q - 1]) { label[q - 1] = cur; st.push(q - 1); }
            if (x < w - 1 && A[q + 1] && !label[q + 1]) { label[q + 1] = cur; st.push(q + 1); }
            if (y > 0 && A[q - w] && !label[q - w]) { label[q - w] = cur; st.push(q - w); }
            if (y < h - 1 && A[q + w] && !label[q + w]) { label[q + w] = cur; st.push(q + w); }
        }
        if (area > bestArea) { bestArea = area; bb = { minX: mnx, maxX: mxx, minY: mny, maxY: mxy }; }
    }
    return bb;
}

// ── alpha-premultiplied box downsample of a square crop → size×size ──
function renderSquare(img, cropX, cropY, side, size) {
    const { w, h, rgba } = img;
    const out = Buffer.alloc(size * size * 4);
    for (let dy = 0; dy < size; dy++) {
        for (let dx = 0; dx < size; dx++) {
            const sx0 = cropX + (dx * side) / size, sx1 = cropX + ((dx + 1) * side) / size;
            const sy0 = cropY + (dy * side) / size, sy1 = cropY + ((dy + 1) * side) / size;
            let ar = 0, ag = 0, ab = 0, aa = 0, n = 0;
            for (let sy = Math.floor(sy0); sy < Math.ceil(sy1); sy++) {
                for (let sx = Math.floor(sx0); sx < Math.ceil(sx1); sx++) {
                    n++;
                    if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue; // out of bounds → transparent
                    const i = (sy * w + sx) * 4, a = rgba[i + 3];
                    ar += rgba[i] * a; ag += rgba[i + 1] * a; ab += rgba[i + 2] * a; aa += a;
                }
            }
            const o = (dy * size + dx) * 4;
            const alpha = n ? Math.round(aa / n) : 0;
            out[o] = aa ? Math.round(ar / aa) : 0;
            out[o + 1] = aa ? Math.round(ag / aa) : 0;
            out[o + 2] = aa ? Math.round(ab / aa) : 0;
            out[o + 3] = alpha;
        }
    }
    return out;
}

// ── ICO container with embedded PNGs ──
function ico(entries) { // entries: [{size, png}]
    const head = Buffer.alloc(6); head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(entries.length, 4);
    const dir = Buffer.alloc(16 * entries.length); let offset = 6 + dir.length;
    const blobs = [];
    entries.forEach((e, i) => {
        const b = i * 16;
        dir[b] = e.size >= 256 ? 0 : e.size; dir[b + 1] = e.size >= 256 ? 0 : e.size;
        dir[b + 2] = 0; dir[b + 3] = 0; dir.writeUInt16LE(1, b + 4); dir.writeUInt16LE(32, b + 6);
        dir.writeUInt32LE(e.png.length, b + 8); dir.writeUInt32LE(offset, b + 12);
        offset += e.png.length; blobs.push(e.png);
    });
    return Buffer.concat([head, dir, ...blobs]);
}

// ── run ──
const img = decode(fs.readFileSync(SRC));
const bb = swanBBox(img);
const sw = bb.maxX - bb.minX + 1, sh = bb.maxY - bb.minY + 1;
const side = Math.round(Math.max(sw, sh) * 1.06);            // square, ~6% breathing room
const cropX = Math.round((bb.minX + bb.maxX) / 2 - side / 2);
const cropY = Math.round((bb.minY + bb.maxY) / 2 - side / 2);

const sizes = {
    'favicon/favicon-16x16.png': 16,
    'favicon/favicon-32x32.png': 32,
    'favicon/favicon-96x96.png': 96,
    'favicon/apple-touch-icon.png': 180,
    'favicon/android-chrome-192x192.png': 192,
    'favicon/android-chrome-512x512.png': 512,
    'favicon/web-app-manifest-192x192.png': 192,
    'favicon/web-app-manifest-512x512.png': 512,
};
const pngCache = {};
const pngOf = (size) => (pngCache[size] ||= encode(size, size, renderSquare(img, cropX, cropY, side, size)));
for (const [file, size] of Object.entries(sizes)) { fs.writeFileSync(file, pngOf(size)); }

// favicon.ico — embed 16/32/48 PNGs (modern browsers read PNG-in-ICO)
fs.writeFileSync('favicon/favicon.ico', ico([16, 32, 48].map(s => ({ size: s, png: pngOf(s) }))));

// favicon.svg — embed the 192px crop as base64 (small, crisp, scalable)
const b64 = pngOf(192).toString('base64');
fs.writeFileSync('favicon/favicon.svg',
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"><image width="192" height="192" href="data:image/png;base64,${b64}"/></svg>\n`);

console.log(`swan bbox ${sw}x${sh} → square side ${side} @ (${cropX},${cropY}). Regenerated ${Object.keys(sizes).length} PNGs + favicon.ico + favicon.svg.`);
