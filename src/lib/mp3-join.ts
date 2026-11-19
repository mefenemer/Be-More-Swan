// src/lib/mp3-join.ts
//
// Join MP3s spoken in parts into one (Phase 4c: a long voiceover is spoken in parts, side by side). Each part
// ElevenLabs returns starts with an ID3v2 tag and a LAME "Info" frame (checked 2026-11-19). Simply joining them
// leaves a tag and an Info frame in the middle, and decoders stop or click there (ffmpeg: "Header missing"). So each
// part loses its ID3v2 tag and its Xing/Info frame, and the plain MPEG frames are joined. Pure; no decoding.

/** The bytes of an ID3v2 tag at the start, or 0. */
export function id3Length(buf: Buffer): number {
    if (buf.length < 10 || buf.toString('latin1', 0, 3) !== 'ID3') return 0;
    // Size is synchsafe (7 bits a byte), plus the 10-byte header, plus a 10-byte footer if flagged.
    const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    const footer = (buf[5] & 0x10) ? 10 : 0;
    return Math.min(buf.length, 10 + size + footer);
}

const BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

/** The length in bytes of an MPEG audio Layer III frame starting at `at`, or 0 if no valid frame starts there. */
export function frameLength(buf: Buffer, at: number): number {
    if (at + 4 > buf.length || buf[at] !== 0xff || (buf[at + 1] & 0xe0) !== 0xe0) return 0;
    const version = (buf[at + 1] >> 3) & 0x03;   // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
    const layer = (buf[at + 1] >> 1) & 0x03;     // 1 = Layer III
    if (version === 1 || layer !== 1) return 0;
    const bitrate = (version === 3 ? BITRATES_V1_L3 : BITRATES_V2_L3)[(buf[at + 2] >> 4) & 0x0f] * 1000;
    const rate = RATES[version]?.[(buf[at + 2] >> 2) & 0x03];
    if (!bitrate || !rate) return 0;
    const padding = (buf[at + 2] >> 1) & 0x01;
    return Math.floor(((version === 3 ? 144 : 72) * bitrate) / rate) + padding;
}

/** One part's audio frames: its ID3v2 tag and its Xing/Info frame (if the first frame is one) removed. */
export function mp3Frames(buf: Buffer): Buffer {
    let at = id3Length(buf);
    // Find the first frame sync after the tag.
    while (at < buf.length - 4 && !frameLength(buf, at)) at++;
    const len = frameLength(buf, at);
    if (!len) return buf.subarray(id3Length(buf));
    const head = buf.toString('latin1', at + 4, Math.min(buf.length, at + 4 + 40));
    if (head.includes('Xing') || head.includes('Info')) at += len;
    return buf.subarray(at);
}

/** Parts spoken one after another, joined into one MP3. A single part comes back as it was. */
export function joinMp3(parts: Buffer[]): Buffer {
    if (parts.length <= 1) return parts[0] ?? Buffer.alloc(0);
    return Buffer.concat(parts.map(mp3Frames));
}
