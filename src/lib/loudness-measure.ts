// src/lib/loudness-measure.ts
//
// Measuring and levelling real audio, so a Video Producer render lands at about −14 LUFS whatever its
// parts were. Measuring SAMPLES was not enough (staging, 2026-11-10): the default voice ("sage") had
// never been sampled, so the mix assumed −16 LUFS; the real voiceover was −31 LUFS and the finished
// video came out at −26. And a quiet voice with sharp peaks (−31 LUFS, peak −12.5 dBFS) cannot reach
// −14 by volume alone — the render can only multiply, so the peaks would clip long before. So:
//
//   · integratedLufs — ITU-R BS.1770-4 integrated loudness: K-weighting, 400 ms blocks with 75 %
//     overlap, the −70 LUFS absolute gate and the −10 LU relative gate. Matches ffmpeg's ebur128.
//   · levelTo        — gain to a target, through a look-ahead peak limiter with a ceiling, so speech
//     can be raised as far as it needs to without clipping.
//   · wavBytes / readWav — 16-bit PCM WAV out (no MP3 encoder is needed: the render reads WAV), and in.
//
// PURE: arrays in, arrays out. Decoding an MP3 lives in src/utils/audio-levelling.ts.
// Tested in tests/video-producer-seven.test.ts.

export interface Pcm { channels: Float32Array[]; sampleRate: number }

/** The two K-weighting biquads for a sample rate (BS.1770, as libebur128 derives them). */
function kWeighting(fs: number): Array<{ b: [number, number, number]; a: [number, number] }> {
    // Stage 1: the head's high shelf (+4 dB above ~1.7 kHz).
    let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
    let K = Math.tan(Math.PI * f0 / fs);
    const Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
    let a0 = 1 + K / Q + K * K;
    const shelf = {
        b: [(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0] as [number, number, number],
        a: [2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0] as [number, number],
    };
    // Stage 2: the RLB high-pass (~38 Hz).
    f0 = 38.13547087602444; Q = 0.5003270373238773;
    K = Math.tan(Math.PI * f0 / fs);
    a0 = 1 + K / Q + K * K;
    const hp = { b: [1, -2, 1] as [number, number, number], a: [2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0] as [number, number] };
    return [shelf, hp];
}

function filter(x: Float32Array, f: { b: [number, number, number]; a: [number, number] }): Float64Array {
    const y = new Float64Array(x.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let n = 0; n < x.length; n++) {
        const v = f.b[0] * x[n] + f.b[1] * x1 + f.b[2] * x2 - f.a[0] * y1 - f.a[1] * y2;
        x2 = x1; x1 = x[n]; y2 = y1; y1 = v; y[n] = v;
    }
    return y;
}

/** Integrated loudness in LUFS (mono or stereo; every channel weighted 1). Null for silence. */
export function integratedLufs(pcm: Pcm): number | null {
    const { channels, sampleRate: fs } = pcm;
    if (!channels.length || !channels[0].length || !(fs > 0)) return null;
    const [s1, s2] = kWeighting(fs);
    const weighted = channels.map((c) => { const a = filter(c, s1); const f32 = new Float32Array(a.length); for (let i = 0; i < a.length; i++) f32[i] = a[i]; return filter(f32, s2); });
    const block = Math.round(0.4 * fs), step = Math.round(0.1 * fs);
    const len = weighted[0].length;
    if (len < block) {
        // Shorter than one block: one block of what there is.
        let z = 0;
        for (const w of weighted) { let s = 0; for (let i = 0; i < len; i++) s += w[i] * w[i]; z += s / Math.max(1, len); }
        return z > 0 ? Math.round((-0.691 + 10 * Math.log10(z)) * 10) / 10 : null;
    }
    // Running sums make each block O(1).
    const sq = weighted.map((w) => { const p = new Float64Array(len + 1); for (let i = 0; i < len; i++) p[i + 1] = p[i] + w[i] * w[i]; return p; });
    const zs: number[] = [];
    for (let start = 0; start + block <= len; start += step) {
        let z = 0;
        for (const p of sq) z += (p[start + block] - p[start]) / block;
        zs.push(z);
    }
    const lufsOf = (z: number) => -0.691 + 10 * Math.log10(z);
    const aboveAbs = zs.filter((z) => z > 0 && lufsOf(z) > -70);
    if (!aboveAbs.length) return null;
    const rel = lufsOf(aboveAbs.reduce((a, b) => a + b, 0) / aboveAbs.length) - 10;
    const gated = aboveAbs.filter((z) => lufsOf(z) > rel);
    if (!gated.length) return null;
    return Math.round(lufsOf(gated.reduce((a, b) => a + b, 0) / gated.length) * 10) / 10;
}

/** The loudest sample, in dBFS (−Infinity for silence). */
export function samplePeakDb(pcm: Pcm): number {
    let peak = 0;
    for (const c of pcm.channels) for (let i = 0; i < c.length; i++) { const v = Math.abs(c[i]); if (v > peak) peak = v; }
    return peak > 0 ? Math.round(20 * Math.log10(peak) * 10) / 10 : -Infinity;
}

/** Most a quiet voice is raised (+24 dB): beyond that it is noise, not speech. */
export const MAX_LEVELLING_GAIN_DB = 24;
/** Where the limiter holds the peaks: −1 dBFS, the usual ceiling for social video. */
export const LIMIT_CEILING_DB = -1;

/**
 * Gain the audio to `targetLufs`, through a look-ahead peak limiter at `ceilingDb`. The limiter sees
 * 5 ms ahead and ramps the gain down over that window before a peak, then lets it back up over
 * 80 ms, so speech raised a long way keeps its shape without clicks or clipping; a last hard clip at
 * the ceiling catches anything the ramp missed. Returns the levelled audio and what it measures now.
 */
export function levelTo(pcm: Pcm, targetLufs: number, opts: { ceilingDb?: number; maxGainDb?: number } = {}): { pcm: Pcm; gainDb: number; lufs: number | null } | null {
    const before = integratedLufs(pcm);
    if (before == null) return null;
    const maxGain = opts.maxGainDb ?? MAX_LEVELLING_GAIN_DB;
    // The limiter takes away the energy of the peaks it holds, so one pass can land short when the
    // peaks carried much of it. Measure, correct the gain, and go again — at most three passes.
    let gainDb = Math.min(maxGain, targetLufs - before);
    let best: { pcm: Pcm; gainDb: number; lufs: number | null } | null = null;
    for (let pass = 0; pass < 3; pass++) {
        const out = limitedGain(pcm, gainDb, opts.ceilingDb ?? LIMIT_CEILING_DB);
        const lufs = integratedLufs(out);
        best = { pcm: out, gainDb: Math.round(gainDb * 10) / 10, lufs };
        if (lufs == null || Math.abs(targetLufs - lufs) <= 0.3 || gainDb >= maxGain) break;
        gainDb = Math.min(maxGain, gainDb + (targetLufs - lufs));
    }
    return best;
}

/** One pass: `gainDb` of gain through the look-ahead limiter. */
function limitedGain(pcm: Pcm, gainDb: number, ceilingDb: number): Pcm {
    const g = Math.pow(10, gainDb / 20);
    const ceil = Math.pow(10, ceilingDb / 20);
    const fs = pcm.sampleRate;
    const len = pcm.channels[0].length;
    const look = Math.max(1, Math.round(0.005 * fs));
    // The gain each sample needs so no channel passes the ceiling.
    const need = new Float32Array(len);
    for (let n = 0; n < len; n++) {
        let peak = 0;
        for (const c of pcm.channels) { const v = Math.abs(c[n]) * g; if (v > peak) peak = v; }
        need[n] = peak > ceil ? ceil / peak : 1;
    }
    // The gain curve, guaranteed under the need at every peak and smooth: hold the lowest need
    // within ±look samples, then average that over ±look. Every window around a peak contains the
    // peak, so the average there is at or below what the peak needs — no sample reaches the safety
    // clip, which made peaks BETWEEN samples (+0.6 dBTP on a −1 dBFS ceiling, staging 2026-11-10).
    const hold = new Float32Array(len);
    {
        const dq: number[] = []; let head = 0;
        for (let i = 0; i < len + look; i++) {
            if (i < len) { while (dq.length > head && need[dq[dq.length - 1]] >= need[i]) dq.pop(); dq.push(i); }
            const n = i - look;
            if (n < 0) continue;
            while (dq[head] < n - look) head++;
            hold[n] = need[dq[head]];
        }
    }
    const sum = new Float64Array(len + 1);
    for (let n = 0; n < len; n++) sum[n + 1] = sum[n] + hold[n];
    const release = 1 - Math.exp(-1 / (0.08 * fs));
    const out = pcm.channels.map(() => new Float32Array(len));
    let env = 1;
    for (let n = 0; n < len; n++) {
        const a = Math.max(0, n - look), b = Math.min(len, n + look + 1);
        const smooth = (sum[b] - sum[a]) / (b - a);
        // Down exactly as the curve says; back up slowly (80 ms), never above the curve.
        env = smooth < env ? smooth : Math.min(smooth, env + release * (smooth - env));
        const k = g * env;
        for (let ch = 0; ch < pcm.channels.length; ch++) {
            let v = pcm.channels[ch][n] * k;
            if (v > ceil) v = ceil; else if (v < -ceil) v = -ceil;   // safety only — the curve already holds it
            out[ch][n] = v;
        }
    }
    return { channels: out, sampleRate: fs };
}

/** 16-bit PCM WAV bytes for audio (dithered by rounding only — fine for speech and beds). */
export function wavBytes(pcm: Pcm): Uint8Array {
    const ch = pcm.channels.length, len = pcm.channels[0].length, fs = pcm.sampleRate;
    const dataBytes = len * ch * 2;
    const buf = new ArrayBuffer(44 + dataBytes);
    const v = new DataView(buf);
    const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + dataBytes, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true);
    v.setUint32(24, fs, true); v.setUint32(28, fs * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, dataBytes, true);
    let o = 44;
    for (let n = 0; n < len; n++) for (let c = 0; c < ch; c++) {
        const s = Math.max(-1, Math.min(1, pcm.channels[c][n]));
        v.setInt16(o, Math.round(s * 32767), true); o += 2;
    }
    return new Uint8Array(buf);
}

/** Read a 16-bit (or 32-bit float) PCM WAV; null for anything else. */
export function readWav(bytes: Uint8Array): Pcm | null {
    if (bytes.length < 44) return null;
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tag = (o: number) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
    if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
    let o = 12, fmt: { format: number; ch: number; fs: number; bits: number } | null = null;
    while (o + 8 <= bytes.length) {
        const id = tag(o), size = v.getUint32(o + 4, true);
        if (id === 'fmt ') fmt = { format: v.getUint16(o + 8, true), ch: v.getUint16(o + 10, true), fs: v.getUint32(o + 12, true), bits: v.getUint16(o + 22, true) };
        if (id === 'data' && fmt) {
            const { format, ch, fs, bits } = fmt;
            const pcm16 = format === 1 && bits === 16, f32 = format === 3 && bits === 32;
            if (!(pcm16 || f32) || ch < 1) return null;
            const frames = Math.floor(Math.min(size, bytes.length - o - 8) / (ch * (bits / 8)));
            const channels = Array.from({ length: ch }, () => new Float32Array(frames));
            let p = o + 8;
            for (let n = 0; n < frames; n++) for (let c = 0; c < ch; c++) {
                channels[c][n] = pcm16 ? v.getInt16(p, true) / 32768 : v.getFloat32(p, true); p += bits / 8;
            }
            return { channels, sampleRate: fs };
        }
        o += 8 + size + (size % 2);
    }
    return null;
}
