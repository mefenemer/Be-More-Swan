// scripts/ingest-music-tracks.ts
// Put a licensed pack of music into the library: upload the files to R2, write the music_tracks rows.
//
// The library is curated rather than searched from a stock API, because a customer publishes
// commercially and the exposure from a wrongly-licensed bed lands on them and on us. The whole point
// is that every track in it has paperwork — so this script's real job is not the upload, it is
// refusing to write a row whose licence we cannot state.
//
// ── The manifest ────────────────────────────────────────────────────────────────────────────────
// A JSON file next to the audio, naming what each file is and what we may do with it:
//
//   {
//     "licence": {
//       "name": "AudioJungle Music Standard Licence",
//       "termsUrl": "https://audiojungle.net/licenses/standard",
//       "attributionRequired": false,
//       "source": "AudioJungle",
//       "sourceReference": "invoice 12345"
//     },
//     "tracks": [
//       { "file": "slow-water.mp3", "title": "Slow Water", "artist": "K. Reed", "tags": ["calm", "ambient"] }
//     ]
//   }
//
// The licence block is stated ONCE and applied to every track, because a pack is bought under one
// licence — and a per-track licence field would invite it being filled in from memory. A track may
// override it where a pack genuinely mixes terms.
//
// ⚠️ DURATION IS READ FROM THE FILE, never from the manifest. It is the one number that must be
// exact: the editor draws a bed's bar against it and the renderer sequences against the real audio,
// so a transcribed value that is a second out means the reviewer times text against a length the
// renderer does not share. Sixty durations typed by hand would be wrong somewhere, and silently.
//
// DRY RUN by default. Nothing is uploaded and nothing is written without --apply.
//
//   npx tsx scripts/ingest-music-tracks.ts --manifest=./music/pack.json
//   npx tsx scripts/ingest-music-tracks.ts --manifest=./music/pack.json --apply
//   npx tsx scripts/ingest-music-tracks.ts --manifest=./music/pack.json --apply --url-var=DATABASE_URL_PROD
//
// ⚠️ --url-var takes the NAME of an environment variable, never a connection string: a URL on the
// command line ends up in shell history and in this session's transcript.

import { config } from 'dotenv';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

config({ path: path.resolve(process.cwd(), '.env') });

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const urlVar = flag('url-var') ?? 'NETLIFY_DATABASE_URL';
const manifestPath = flag('manifest');

/** Where a library object lives. Shared across every workspace — one object, licensed once. */
const LIBRARY_PREFIX = 'library/music';

/** What we will accept. Anything the renderer cannot play is a curation mistake, caught here. */
const ALLOWED = new Map<string, string>([
    ['.mp3', 'audio/mpeg'],
    ['.m4a', 'audio/mp4'],
    ['.aac', 'audio/aac'],
    ['.wav', 'audio/wav'],
    ['.ogg', 'audio/ogg'],
]);

interface ManifestLicence {
    name: string;
    termsUrl?: string;
    attributionRequired?: boolean;
    attributionText?: string;
    expiresAt?: string;
    source?: string;
    sourceReference?: string;
}
interface ManifestTrack {
    file: string;
    title: string;
    artist: string;
    tags?: string[];
    licence?: Partial<ManifestLicence>;
}

/** Host + database of the connection, so the operator can confirm the target. Never the password. */
function describeTarget(): string {
    const raw = process.env[urlVar];
    if (!raw) return `${urlVar} is not set — the script will fail to connect`;
    try { const u = new URL(raw); return `${u.host}${u.pathname}  [${urlVar}]`; }
    catch { return `unparseable ${urlVar}`; }
}

function fail(msg: string): never {
    console.error(`\n  ${msg}\n`);
    process.exit(1);
}

async function main() {
    if (!manifestPath) fail('--manifest=<path to pack.json> is required.');
    const manifestAbs = path.resolve(process.cwd(), manifestPath);
    if (!fs.existsSync(manifestAbs)) fail(`No manifest at ${manifestAbs}`);
    const packDir = path.dirname(manifestAbs);

    let manifest: { licence?: ManifestLicence; tracks?: ManifestTrack[] };
    try { manifest = JSON.parse(fs.readFileSync(manifestAbs, 'utf8')); }
    catch (e: any) { fail(`The manifest is not valid JSON: ${e.message}`); }

    const packLicence = manifest.licence;
    const tracks = Array.isArray(manifest.tracks) ? manifest.tracks : [];
    if (!tracks.length) fail('The manifest lists no tracks.');

    if (urlVar !== 'NETLIFY_DATABASE_URL') {
        const override = process.env[urlVar];
        if (!override) fail(`${urlVar} is not set. Export it, or drop --url-var to use NETLIFY_DATABASE_URL.`);
        process.env.NETLIFY_DATABASE_URL = override;
    }

    console.log('\nIngest: licensed music pack → music_tracks');
    console.log(`  target   : ${describeTarget()}`);
    console.log(`  mode     : ${apply ? 'APPLY (uploads + writes)' : 'DRY RUN (nothing uploaded, nothing written)'}`);
    console.log(`  manifest : ${manifestAbs}`);
    console.log(`  tracks   : ${tracks.length}`);
    console.log('');

    // ── Read every file and its licence BEFORE uploading anything ────────────────────────────────
    // A half-ingested pack is the worst outcome: some rows in, some files in R2 with no row, and no
    // way to tell which without listing the bucket. Everything is validated and measured first, and
    // a single bad track stops the run.
    const mm = await import('music-metadata');
    type Ready = {
        title: string; artist: string; tags: string[]; durationS: number;
        bytes: Buffer; contentType: string; storageKey: string; licence: ManifestLicence;
    };
    const ready: Ready[] = [];
    const problems: string[] = [];

    for (const [i, t] of tracks.entries()) {
        const where = `track ${i + 1}${t.file ? ` (${t.file})` : ''}`;
        if (!t.file || !t.title || !t.artist) { problems.push(`${where}: needs file, title and artist`); continue; }

        const abs = path.resolve(packDir, t.file);
        if (!fs.existsSync(abs)) { problems.push(`${where}: no such file`); continue; }

        const ext = path.extname(abs).toLowerCase();
        const contentType = ALLOWED.get(ext);
        if (!contentType) { problems.push(`${where}: ${ext} is not a format the renderer plays`); continue; }

        // ⚠️ The licence, before anything else. A row we cannot state the terms of is the one thing
        // this library exists to prevent, so it is a hard stop rather than a default.
        const lic = { ...(packLicence || {}), ...(t.licence || {}) } as ManifestLicence;
        if (!lic.name) { problems.push(`${where}: no licence name — state it in the pack's licence block`); continue; }
        if (lic.attributionRequired && !lic.attributionText) {
            problems.push(`${where}: the licence requires attribution but gives no wording to use`);
            continue;
        }

        const bytes = fs.readFileSync(abs);
        let durationS = 0;
        try { durationS = Number((await mm.parseFile(abs)).format.duration) || 0; }
        catch (e: any) { problems.push(`${where}: could not read its length (${e.message})`); continue; }
        if (!(durationS > 0)) { problems.push(`${where}: reports no length`); continue; }

        // Content-addressed, so re-running the same pack cannot create a second copy of one file,
        // and the unique index on storage_key turns a duplicate into a refusal rather than a row.
        const digest = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 32);
        ready.push({
            title: t.title, artist: t.artist,
            tags: Array.isArray(t.tags) ? t.tags.map(s => String(s).toLowerCase().trim()).filter(Boolean) : [],
            durationS: Math.round(durationS * 100) / 100,
            bytes, contentType,
            storageKey: `${LIBRARY_PREFIX}/${digest}${ext}`,
            licence: lic,
        });
    }

    for (const t of ready) {
        const mins = Math.floor(t.durationS / 60), secs = Math.round(t.durationS % 60);
        console.log(`  ✓ ${t.title} — ${t.artist}  (${mins}:${String(secs).padStart(2, '0')}, ${t.tags.join('/') || 'no tags'})`);
    }
    if (problems.length) {
        console.log('');
        for (const p of problems) console.log(`  ✗ ${p}`);
        fail(`${problems.length} track${problems.length === 1 ? '' : 's'} cannot be ingested. Nothing was uploaded or written.`);
    }

    if (!apply) {
        console.log(`\n  DRY RUN — nothing uploaded, nothing written. Re-run with --apply to ingest ${ready.length}.\n`);
        return;
    }

    const { getDb } = await import('../db/client');
    const { musicTracks } = await import('../db/schema');
    const db = getDb();

    let written = 0;
    for (const t of ready) {
        try {
            // ⚠️ Upload BEFORE the row. A row pointing at bytes that are not there renders silence
            // and looks like a working track; an object with no row is invisible and harmless.
            await uploadObject(t.storageKey, t.bytes, t.contentType);
            await db.insert(musicTracks).values({
                title: t.title,
                artist: t.artist,
                storageKey: t.storageKey,
                durationS: t.durationS,
                tags: t.tags,
                licenceName: t.licence.name,
                licenceTermsUrl: t.licence.termsUrl ?? null,
                attributionRequired: t.licence.attributionRequired === true,
                attributionText: t.licence.attributionText ?? null,
                licenceExpiresAt: t.licence.expiresAt ?? null,
                source: t.licence.source ?? null,
                sourceReference: t.licence.sourceReference ?? null,
            }).onConflictDoNothing();
            written++;
            console.log(`  uploaded + recorded: ${t.title}`);
        } catch (e: any) {
            console.error(`  ✗ ${t.title}: ${e.message}`);
        }
    }
    console.log(`\n  ${written} of ${ready.length} track${ready.length === 1 ? '' : 's'} in the library.\n`);

    /**
     * Straight to R2 under the shared library prefix.
     *
     * ⚠️ Deliberately NOT persistBufferToR2: that writes to `content/org-{id}/…`, and a library track
     * belongs to no organisation. One object, licensed once, referenced by every workspace through
     * its own content_assets row — copying the bytes per tenant would multiply storage by the number
     * of customers for no gain.
     */
    async function uploadObject(key: string, bytes: Buffer, contentType: string) {
        const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
        const endpoint = process.env.R2_ENDPOINT;
        const bucket = process.env.R2_BUCKET_NAME;
        const accessKeyId = process.env.R2_ACCESS_KEY_ID;
        const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
        if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
            throw new Error('R2 is not configured in this environment (R2_ENDPOINT / R2_BUCKET_NAME / keys).');
        }
        const s3 = new S3Client({ region: 'auto', endpoint, credentials: { accessKeyId, secretAccessKey } });
        await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentType: contentType }));
    }
}

main().catch((err) => { console.error(err); process.exit(1); });
