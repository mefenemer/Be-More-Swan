// Meeting Note Taker step 4: a long transcript FILE in chat (docs/meeting-note-taker-finish-plan.md).
// Caption files lose their timings, a 60-minute transcript is accepted whole and reaches the model in
// full, and the Website Assistant's limits are unchanged. Run: npx tsx tests/meeting-transcript.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readAttachments } from '../src/utils/chat-attachments';
import { MAX_WORDS_CHARS } from '../src/utils/site-words';
import {
    TRANSCRIPT_MAX_CHARS, isCaptionFile, stripCaptionTimestamps, transcriptAttachmentsBlock,
} from '../src/utils/meeting-transcript';

const read = (f: string) => readFileSync(f, 'utf8');
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
// Documents never touch the database (only pictures are looked up), so no db is needed here.
const noDb = {} as Parameters<typeof readAttachments>[0];

// Microsoft Teams: cue ids, <v Name> voice tags, a caption split over two cues.
const TEAMS_VTT = `WEBVTT

0b1c2d3e-1/12-0
00:00:01.200 --> 00:00:04.500
<v Sarah Jones>Morning all, let's start with the pipeline.</v>

0b1c2d3e-1/18-0
00:00:04.500 --> 00:00:07.100
<v Sarah Jones>We're going with vendor A.</v>

0b1c2d3e-2/3-0
00:00:07.300 --> 00:00:09.000
<v Tom Lee>I'll send the deck by Friday &amp; chase legal.</v>
`;

// Zoom: numbered cues, "Name: words" inside the cue.
const ZOOM_VTT = `WEBVTT

1
00:00:00.000 --> 00:00:03.000
Priya Shah: Can we review the budget?

2
00:00:03.000 --> 00:00:05.000
Ben Cole: Yes, I'll circulate it today.
`;

// SRT: commas in the timings, no speakers, a rolling caption repeated.
const SRT = `1
00:00:01,000 --> 00:00:03,000
Welcome to the weekly ops sync.

2
00:00:03,000 --> 00:00:05,000
Welcome to the weekly ops sync.

3
00:01:05,000 --> 00:01:09,000
Launch slips to Q4.
`;

async function main() {
    // ── Caption files lose their timings, keep who said what ───────────────────
    assert.equal(stripCaptionTimestamps(TEAMS_VTT),
        "Sarah Jones: Morning all, let's start with the pipeline. We're going with vendor A.\nTom Lee: I'll send the deck by Friday & chase legal.");
    assert.equal(stripCaptionTimestamps(ZOOM_VTT), "Priya Shah: Can we review the budget?\nBen Cole: Yes, I'll circulate it today.");
    assert.equal(stripCaptionTimestamps(SRT), 'Welcome to the weekly ops sync. Launch slips to Q4.');
    assert.equal(stripCaptionTimestamps('﻿WEBVTT\r\n\r\nNOTE made by Meet\r\n\r\n00:00.000 --> 00:02.000\r\n<v Ana>Hi.</v>\r\n'), 'Ana: Hi.');
    for (const out of [TEAMS_VTT, ZOOM_VTT, SRT].map(stripCaptionTimestamps)) {
        assert.ok(!/-->|\d{2}:\d{2}[.,]\d{3}|WEBVTT|<\/?v/.test(out), `no timings or tags left: ${out}`);
    }
    assert.ok(isCaptionFile('Weekly sync.VTT') && isCaptionFile('call.srt') && !isCaptionFile('notes.txt'));

    // ── Reading attachments: transcripts vs the Website Assistant ──────────────
    const [teams] = await readAttachments(noDb, 1, [{ kind: 'document', name: 'Q3 review.vtt', type: 'text/vtt', data: b64(TEAMS_VTT) }], { transcripts: true });
    assert.equal(teams.kind, 'document');
    assert.match(teams.text!, /^Sarah Jones: Morning all/);
    const [srt] = await readAttachments(noDb, 1, [{ kind: 'document', name: 'ops.srt', type: '', data: b64(SRT) }], { transcripts: true });
    assert.equal(srt.text, 'Welcome to the weekly ops sync. Launch slips to Q4.');

    // A 60-minute meeting: about 9,000 spoken words (~55k characters), many speakers.
    const speakers = ['Sarah', 'Tom', 'Priya', 'Ben', 'Ana'];
    const hour = Array.from({ length: 600 }, (_, i) =>
        `${speakers[i % speakers.length]}: Point ${i + 1} — we talked through the pipeline, the budget for next quarter and who owns the follow-up on each account.`,
    ).join('\n');
    assert.ok(hour.length > 50_000 && hour.length < TRANSCRIPT_MAX_CHARS, `fixture is an hour's worth (${hour.length} chars)`);
    const long = await readAttachments(noDb, 1, [{ kind: 'document', name: 'All-hands.txt', type: 'text/plain', data: b64(hour) }], { transcripts: true });
    assert.equal(long.length, 1, 'one file, one transcript');
    assert.equal(long[0].text!.length, hour.length, 'nothing cut from a 60-minute transcript');

    // The Website Assistant keeps its one-page limit, and takes no caption files.
    await assert.rejects(readAttachments(noDb, 1, [{ kind: 'document', name: 'All-hands.txt', type: 'text/plain', data: b64(hour) }]), /longer than one page can hold/);
    assert.ok(hour.length > MAX_WORDS_CHARS);
    await assert.rejects(readAttachments(noDb, 1, [{ kind: 'document', name: 'call.vtt', type: 'application/octet-stream', data: b64(ZOOM_VTT) }]), /can't be read/);

    // Transcripts: past ~2 hours is refused in plain words; pictures are not transcripts.
    const tooLong = 'Sarah: words words words words words.\n'.repeat(Math.ceil((TRANSCRIPT_MAX_CHARS + 10) / 38));
    await assert.rejects(readAttachments(noDb, 1, [{ kind: 'document', name: 'Offsite.txt', type: 'text/plain', data: b64(tooLong) }], { transcripts: true }), /longer than about 2 hours/);
    await assert.rejects(readAttachments(noDb, 1, [{ kind: 'image', assetId: 5 }], { transcripts: true }), /as a file/);

    // ── What the model sees: the newest transcript in full, older ones by name ──
    const block = transcriptAttachmentsBlock([
        { id: 9, name: 'All-hands.txt', text: hour },
        { id: 4, name: 'Monday sync.vtt', text: 'Ana: Hi.' },
        { id: 3, name: 'scan.pdf', text: null },
    ])!;
    assert.ok(block.includes(hour), 'the whole hour, not a preview');
    assert.ok(block.includes('"Monday sync.vtt"') && !block.includes('Ana: Hi.'), 'an older transcript is named, not resent');
    assert.match(block, /do not wait for more parts/);
    assert.equal(transcriptAttachmentsBlock([]), null);
    assert.ok(transcriptAttachmentsBlock([{ id: 1, name: 'x.txt', text: 'y'.repeat(TRANSCRIPT_MAX_CHARS + 500) }])!.length < TRANSCRIPT_MAX_CHARS + 500);

    // ── Wiring ───────────────────────────────────────────────────────────────────
    const orch = read('netlify/functions/chat-orchestrator.ts');
    const route = orch.slice(orch.indexOf('    meeting_note_taker: {'), orch.indexOf('buildRolePrompt', orch.indexOf('    meeting_note_taker: {')));
    assert.match(route, /maxTokens: 4096,/);
    assert.match(route, /acceptsAttachments: true,/);
    assert.match(route, /transcriptAttachments: true,/);
    assert.ok(orch.includes("${rc.attachmentsBlock ?? 'No transcript file is attached in this conversation.'}"), 'the meeting prompt carries the transcript');
    assert.ok(orch.includes('An ATTACHED transcript is always complete: write it up at once.'));
    assert.ok(orch.includes('readAttachments(db, orgId, body.attachments, { transcripts })'), 'the limit follows the assistant, looked up server-side');
    assert.ok(orch.includes('buildAttachmentsBlock(db, orgId, session.id, { transcripts: !!route.transcriptAttachments })'));

    const chat = read('src/components/chat-session.js');
    const cfg = chat.slice(chat.indexOf('    meeting_note_taker: {'), chat.indexOf('  const ATTACH_MAX'));
    assert.match(cfg, /pictures: false,/);
    for (const ext of ['.txt', '.docx', '.pdf', '.vtt', '.srt']) assert.ok(cfg.includes(ext), `the paperclip offers ${ext}`);
    assert.ok(chat.includes('if (!attachCfg.pictures) return;'), 'no picture window on the meeting chat');

    console.log('meeting-transcript: all checks passed');
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
