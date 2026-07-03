// One-off: the supplied BeMoreSwan_SwanAI.png shipped with a *baked-in* checkerboard background
// (opaque grey/white pixels) instead of real transparency. This flood-fills the checkerboard from
// the image edges and rewrites it as a genuinely transparent PNG, leaving the pink artwork intact.
// Pure Node (no sharp). Run:  node scripts/clean-wand-image.js
const fs = require('fs');
const zlib = require('zlib');

const FILE = 'images/BeMoreSwan_SwanAI.png';
const buf = fs.readFileSync(FILE);

// ── decode ──
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
        if (ft === 0) val = v;
        else if (ft === 1) val = v + a;
        else if (ft === 2) val = v + b;
        else if (ft === 3) val = v + ((a + b) >> 1);
        else { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); val = v + ((pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c)); }
        out[y * w * 4 + x] = val & 255;
    }
}

// ── flood-fill the grey/white checkerboard from the borders → alpha 0 ──
const isBg = (i) => {
    const r = out[i], g = out[i + 1], b = out[i + 2];
    return r >= 200 && g >= 200 && b >= 200 && (Math.max(r, g, b) - Math.min(r, g, b)) <= 30;
};
const visited = new Uint8Array(w * h);
const stack = [];
for (let x = 0; x < w; x++) { stack.push(x); stack.push((h - 1) * w + x); }
for (let y = 0; y < h; y++) { stack.push(y * w); stack.push(y * w + (w - 1)); }
let cleared = 0;
while (stack.length) {
    const pix = stack.pop();
    if (visited[pix]) continue;
    visited[pix] = 1;
    const i = pix * 4;
    if (!isBg(i)) continue;
    out[i + 3] = 0; cleared++;
    const x = pix % w, y = (pix / w) | 0;
    if (x > 0) stack.push(pix - 1);
    if (x < w - 1) stack.push(pix + 1);
    if (y > 0) stack.push(pix - w);
    if (y < h - 1) stack.push(pix + w);
}

// ── re-encode (filter 0 scanlines) ──
const CRC = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
const crc32 = (b) => { let c = ~0; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return ~c >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'ascii'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
const rawOut = Buffer.alloc(h * stride);
for (let y = 0; y < h; y++) { rawOut[y * stride] = 0; out.copy(rawOut, y * stride + 1, y * w * 4, (y + 1) * w * 4); }
const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(rawOut, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
]);
fs.writeFileSync(FILE, png);
console.log(`Cleared ${cleared.toLocaleString()} background px (${((cleared / (w * h)) * 100).toFixed(1)}%). Wrote transparent ${FILE} (${png.length.toLocaleString()} bytes).`);
