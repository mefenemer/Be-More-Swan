#!/usr/bin/env node
// Static file server for the Playwright smoke tests (e2e/). Netlify publishes the repo root, so this
// serves the repo root the same way: /workspace → workspace.html, / → index.html.
//
// It deliberately has NO functions. Every /.netlify/functions/* call answers 501 here, and each spec
// stubs the ones its page needs with page.route() (e2e/fixtures.ts). So the tests never touch a
// database, an AI provider or Stripe, and a call nobody stubbed shows up as a failed request rather
// than quietly reaching staging. `netlify dev` is not used: it refuses to start on Node 26.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.E2E_PORT || 4173);

const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.mp3': 'audio/mpeg',
    '.mp4': 'video/mp4',
    '.webmanifest': 'application/manifest+json',
    '.txt': 'text/plain; charset=utf-8',
};

async function resolveFile(pathname) {
    const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
    const base = join(root, rel);
    if (!base.startsWith(root)) return null;
    const candidates = rel.endsWith('/') ? [join(base, 'index.html')] : [base, `${base}.html`, join(base, 'index.html')];
    for (const file of candidates) {
        try {
            if ((await stat(file)).isFile()) return file;
        } catch { /* try the next form */ }
    }
    return null;
}

createServer(async (req, res) => {
    const { pathname } = new URL(req.url || '/', 'http://localhost');
    if (pathname.startsWith('/.netlify/functions/')) {
        res.writeHead(501, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `not stubbed in e2e: ${pathname}` }));
        return;
    }
    const file = await resolveFile(pathname);
    if (!file) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        return;
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(await readFile(file));
}).listen(port, '127.0.0.1', () => {
    console.log(`e2e static server on http://127.0.0.1:${port}`);
});
