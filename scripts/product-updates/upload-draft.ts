// scripts/product-updates/upload-draft.ts
//
// The weekly "What's new" task's hand-off to the server (docs/weekly-product-update.md).
//
//   npx tsx scripts/product-updates/upload-draft.ts --last
//   npx tsx scripts/product-updates/upload-draft.ts --pending            has the admin pressed "Draft now"? exit 0 = yes, 3 = no
//   npx tsx scripts/product-updates/upload-draft.ts --claim              take that request before drafting
//   npx tsx scripts/product-updates/upload-draft.ts --done <uploaded|nothing|failed|waiting_for_review> [--note "…"]
//       → where last week's email stopped: { commitTo, periodEnd }. Start this week's window there.
//
//   npx tsx scripts/product-updates/upload-draft.ts --preview <draft.json> [--out <file.html>]
//       → renders the email LOCALLY with the screenshots inlined, so the task can check it. Sends
//         nothing and needs no token.
//
//   npx tsx scripts/product-updates/upload-draft.ts --upload <draft.json> [--replace]
//       → uploads the draft. The server saves it as "waiting for review" and emails the reminder to
//         hello@bemoreswan.com. It NEVER emails customers — only an admin's Approve does that.
//         --replace discards a draft that is still waiting (otherwise the server refuses with 409).
//
// draft.json:
//   {
//     "subject": "...", "preheader": "...", "intro": "...",
//     "commitFrom": "<sha>", "commitTo": "<sha>", "periodStart": "YYYY-MM-DD", "periodEnd": "YYYY-MM-DD",
//     "items": [ { "heading": "...", "body": "...", "image": "relative/or/absolute/path.jpg" }, ... ]
//   }
//   Image paths are resolved relative to the draft file. An item may omit "image".
//
// Credentials: PRODUCT_UPDATES_INGEST_TOKEN from the environment or the repo's .env. It is never
// printed. --base-url defaults to https://bemoreswan.com (the token only works where it is set).

import { config } from 'dotenv';
import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { normaliseDraft, renderProductUpdateEmail, DraftError, type DraftInput } from '../../src/utils/product-update-email';

config({ path: path.resolve(__dirname, '../../.env') });

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
};
const baseUrl = (value('base-url') || 'https://bemoreswan.com').replace(/\/$/, '');

const MIME: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

type FileDraft = Omit<DraftInput, 'items'> & { items: { heading: string; body: string; image?: string | null }[] };

/** draft.json with each image path replaced by { mime, dataB64 }. */
function loadDraft(file: string): DraftInput {
    const abs = path.resolve(file);
    const raw = JSON.parse(readFileSync(abs, 'utf8')) as FileDraft;
    return {
        ...raw,
        items: (raw.items || []).map((it, i) => {
            if (!it.image) return { heading: it.heading, body: it.body, image: null };
            const imgPath = path.resolve(path.dirname(abs), it.image);
            const mime = MIME[path.extname(imgPath).toLowerCase()];
            if (!mime) throw new DraftError(`items[${i}].image: ${it.image} is not a .jpg, .png or .webp file.`);
            return { heading: it.heading, body: it.body, image: { mime, dataB64: readFileSync(imgPath).toString('base64') } };
        }),
    };
}

function token(): string {
    const t = process.env.PRODUCT_UPDATES_INGEST_TOKEN;
    if (!t) {
        console.error('PRODUCT_UPDATES_INGEST_TOKEN is not set (environment or .env). See docs/weekly-product-update.md → One-off setup.');
        process.exit(2);
    }
    return t;
}

async function call(method: string, query: string, body?: unknown) {
    const res = await fetch(`${baseUrl}/.netlify/functions/product-updates?${query}`, {
        method,
        headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data: unknown = text;
    try { data = JSON.parse(text); } catch { /* not JSON — print as-is */ }
    return { status: res.status, data };
}

async function main() {
    // "Draft this week's email now" on Admin ▸ What's New (src/utils/product-update-draft-request.ts).
    if (flag('pending')) {
        const r = await call('GET', 'resource=draft-request-poll');
        console.log(JSON.stringify(r.data, null, 2));
        if (r.status !== 200) process.exit(1);
        process.exit((r.data as { hasWork?: boolean })?.hasWork ? 0 : 3);
    }
    if (flag('claim')) {
        const r = await call('POST', 'resource=draft-request-claim', {});
        console.log(JSON.stringify(r.data, null, 2));
        process.exit(r.status === 200 ? 0 : 1);
    }
    const doneOutcome = value('done');
    if (doneOutcome) {
        const r = await call('POST', 'resource=draft-request-done', { outcome: doneOutcome, note: value('note') || null });
        console.log(JSON.stringify(r.data, null, 2));
        process.exit(r.status === 200 ? 0 : 1);
    }

    if (flag('last')) {
        const r = await call('GET', 'resource=last');
        console.log(JSON.stringify(r.data, null, 2));
        process.exit(r.status === 200 ? 0 : 1);
    }

    const previewFile = value('preview');
    if (previewFile) {
        const draft = normaliseDraft(loadDraft(previewFile));
        // Give each screenshot a fake id, render, then swap the signed URLs for inline data URIs.
        const items = draft.items.map((it, i) => ({ heading: it.heading, body: it.body, imageId: it.image ? i + 1 : null }));
        let { html, subject } = renderProductUpdateEmail({ ...draft, items }, { baseUrl, firstName: 'there', secret: 'local-preview' });
        draft.items.forEach((it, i) => {
            if (!it.image) return;
            html = html.replace(new RegExp(`${baseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/api/product-updates/image\\?i=${i + 1}&amp;s=[0-9a-f]+`),
                `data:${it.image.mime};base64,${it.image.dataB64}`);
        });
        const out = value('out') || path.join(path.dirname(path.resolve(previewFile)), 'preview.html');
        writeFileSync(out, html);
        console.log(JSON.stringify({ subject, items: draft.items.length, preview: out }, null, 2));
        return;
    }

    const uploadFile = value('upload');
    if (uploadFile) {
        const draft = loadDraft(uploadFile);
        normaliseDraft(draft); // fail here, with the same message, before sending megabytes
        const r = await call('POST', `resource=ingest${flag('replace') ? '&replace=1' : ''}`, draft);
        console.log(JSON.stringify({ status: r.status, ...(typeof r.data === 'object' ? r.data as object : { body: r.data }) }, null, 2));
        process.exit(r.status === 201 ? 0 : 1);
    }

    console.error('Usage: --pending | --claim | --done <outcome> [--note "…"] | --last | --preview <draft.json> [--out file.html] | --upload <draft.json> [--replace]   [--base-url URL]');
    process.exit(2);
}

main().catch((err) => {
    console.error(err instanceof DraftError ? `Draft problem: ${err.message}` : err);
    process.exit(1);
});
