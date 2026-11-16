// Meeting Note Taker: transcript files attached in chat (docs/meeting-note-taker-finish-plan.md step 4).
// chat-attachments.ts reads the file; this turns caption files (.vtt from Zoom/Teams/Meet, .srt) into
// plain "Speaker: words" lines and sets how much one transcript may hold. Pure, so
// tests/meeting-transcript.test.ts can run it on fixtures.

/** About 2 hours of talk (a 60-minute meeting is roughly 50–60k characters). A longer file goes in parts. */
export const TRANSCRIPT_MAX_CHARS = 120_000;

/** What the paperclip offers on the meeting chat. Pictures are not transcripts. */
export const TRANSCRIPT_FILE_TYPES = ['.txt', '.docx', '.pdf', '.vtt', '.srt', '.md'] as const;

export function isCaptionFile(name: string): boolean {
    return /\.(vtt|srt)$/i.test(String(name || '').trim());
}

const TIMING = /^\s*(\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3}\s*-->\s*(\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3}.*$/;

/**
 * A caption file as plain transcript lines: the WEBVTT header, NOTE/STYLE/REGION blocks, cue numbers,
 * cue ids and timings go; `<v Name>` voice tags become "Name: "; other tags (<c>, <b>, <00:01.000>)
 * go. Consecutive lines from the same speaker are joined, and a line repeated straight after itself
 * (rolling captions) is kept once.
 */
export function stripCaptionTimestamps(raw: string): string {
    const text = String(raw || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    const blocks = text.split(/\n\s*\n/);
    const lines: { speaker: string | null; words: string }[] = [];
    for (const block of blocks) {
        const rows = block.split('\n').map((r) => r.trim()).filter(Boolean);
        if (!rows.length) continue;
        if (/^WEBVTT\b/.test(rows[0]) || /^(NOTE|STYLE|REGION)\b/.test(rows[0])) {
            // The header block may carry a first cue right after it in files with no blank line.
            const at = rows.findIndex((r) => TIMING.test(r));
            if (at < 0) continue;
            rows.splice(0, at);
        }
        const timingAt = rows.findIndex((r) => TIMING.test(r));
        // A block with no timing line is not a cue (stray text); keep its words anyway.
        const body = timingAt >= 0 ? rows.slice(timingAt + 1) : rows.filter((r) => !/^\d+$/.test(r));
        for (const row of body) {
            if (TIMING.test(row)) continue;
            let speaker: string | null = null;
            const voice = row.match(/^<v(?:\.[^\s>]*)?\s+([^>]+)>/i);
            if (voice) speaker = voice[1].trim();
            let words = row.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
            if (!speaker) {
                // Zoom writes "Name: words" in the cue itself.
                const named = words.match(/^([A-Z][^:]{0,60}):\s+(.+)$/);
                if (named) { speaker = named[1].trim(); words = named[2]; }
            }
            if (!words) continue;
            const last = lines[lines.length - 1];
            if (last && last.speaker === speaker && last.words.endsWith(words)) continue;
            if (last && last.speaker === speaker && speaker !== null) { last.words = `${last.words} ${words}`; continue; }
            if (last && speaker === null && last.speaker === null) { last.words = `${last.words} ${words}`; continue; }
            lines.push({ speaker, words });
        }
    }
    return lines.map((l) => (l.speaker ? `${l.speaker}: ${l.words}` : l.words)).join('\n');
}

/**
 * What the meeting chat sees of its attached transcripts: the NEWEST one in full (that is the meeting
 * being written up, and later turns — "shorter", "who owns the deck?" — still need it), the older
 * ones by name only, so one conversation never pays for several transcripts on every turn.
 */
export function transcriptAttachmentsBlock(docs: readonly { id: number; name: string; text: string | null }[]): string | null {
    const withText = docs.filter((d) => d.text && d.text.trim());
    if (!withText.length) return null;
    const [newest, ...older] = withText;
    const text = newest.text!.length > TRANSCRIPT_MAX_CHARS ? newest.text!.slice(0, TRANSCRIPT_MAX_CHARS) : newest.text!;
    const words = text.split(/\s+/).filter(Boolean).length;
    const lines = [
        `ATTACHED TRANSCRIPT — "${newest.name}" (${words.toLocaleString('en-GB')} words). This is the whole meeting: write the minutes from all of it in one card, and do not wait for more parts.`,
        '<<<TRANSCRIPT',
        text,
        'TRANSCRIPT>>>',
    ];
    if (older.length) lines.push(`Earlier transcripts in this conversation (already written up; ask before using them): ${older.map((d) => `"${d.name}"`).join(', ')}.`);
    return lines.join('\n');
}
