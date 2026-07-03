// netlify/functions/translate.ts (#1 runtime UI auto-translation)
//
// POST { lang, strings: string[] } → { translations: string[] }  (same length/order)
//
// Translates UI microcopy via the AI gateway, with a shared DB cache (ui_translations):
// each unique (lang, source) is translated once and reused for every user. English (or an
// unsupported lang) returns the strings unchanged. Fails OPEN — on any model/parse error the
// affected strings come back as the original English, so the UI never shows blanks.

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { uiTranslations } from '../../db/schema';
import { gatewayGenerate } from '../../src/lib/ai-gateway';

const jwtSecret = process.env.JWT_SECRET;

// Keep in sync with the language selector in user-settings.html.
const LANG_NAMES: Record<string, string> = { fr: 'French', de: 'German', es: 'Spanish', pt: 'Portuguese' };

const MAX_STRINGS = 200;     // per request
const MAX_LEN = 800;         // per string — longer strings are passed through untranslated

function getAuth(event: any): number | null {
    if (!jwtSecret) return null;
    const m = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!m) return null;
    try { return (jwt.verify(m[1], jwtSecret) as { userId: number }).userId; } catch { return null; }
}

const hash = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
    if (!getAuth(event)) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };

    let body: { lang?: string; strings?: unknown };
    try { body = JSON.parse(event.body || '{}'); }
    catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON.' }) }; }

    const lang = String(body.lang || '').toLowerCase();
    const strings = Array.isArray(body.strings) ? body.strings.map(s => String(s ?? '')) : [];
    if (!strings.length) return json({ translations: [] });

    // English or unknown language → identity (no model call).
    const langName = LANG_NAMES[lang];
    if (!langName) return json({ translations: strings });

    const capped = strings.slice(0, MAX_STRINGS);
    const db = getDb();

    // 1. Which unique source strings are eligible (non-empty, not too long, has letters)?
    const translatable = (s: string) => s.trim().length > 0 && s.length <= MAX_LEN && /\p{L}/u.test(s);
    const uniqueSources = Array.from(new Set(capped.filter(translatable)));
    const hashOf = new Map(uniqueSources.map(s => [s, hash(s)]));

    // 2. Cache lookup.
    const cache = new Map<string, string>(); // sourceText → translatedText
    if (uniqueSources.length) {
        try {
            const hashes = uniqueSources.map(s => hashOf.get(s)!);
            const rows = await db.select({ sourceText: uiTranslations.sourceText, translatedText: uiTranslations.translatedText })
                .from(uiTranslations)
                .where(and(eq(uiTranslations.lang, lang), inArray(uiTranslations.sourceHash, hashes)));
            for (const r of rows) cache.set(r.sourceText, r.translatedText);
        } catch (err) {
            // Table not migrated yet → degrade to model-only (still works, just uncached).
            console.warn('[translate] cache read failed (continuing):', (err as Error)?.message);
        }
    }

    // 3. Translate the misses in one model call.
    const misses = uniqueSources.filter(s => !cache.has(s));
    if (misses.length) {
        try {
            const sys = `You are a professional UI localiser for a SaaS web app. Translate each English UI string into ${langName}.
Rules:
- Return ONLY a JSON array of strings, same length and order as the input array, no commentary.
- Keep translations concise and natural for buttons, labels, and short messages.
- NEVER translate the brand name "Be More Swan"; leave URLs, email addresses, code, and numbers unchanged.
- Preserve leading/trailing whitespace, punctuation, and any emoji.`;
            const res = await gatewayGenerate({
                system: sys,
                messages: [{ role: 'user', content: JSON.stringify(misses) }],
                maxTokens: 4096,
            });
            const parsed = JSON.parse(stripFence(res.text));
            if (Array.isArray(parsed) && parsed.length === misses.length) {
                const toInsert: { lang: string; sourceHash: string; sourceText: string; translatedText: string }[] = [];
                misses.forEach((src, i) => {
                    const t = typeof parsed[i] === 'string' ? parsed[i] : src;
                    cache.set(src, t);
                    toInsert.push({ lang, sourceHash: hashOf.get(src)!, sourceText: src, translatedText: t });
                });
                // Persist (best-effort; ignore conflicts from concurrent writers / un-migrated table).
                // Awaited so the serverless container doesn't freeze before the cache write lands.
                try { await db.insert(uiTranslations).values(toInsert).onConflictDoNothing(); } catch { /* un-migrated / race — fine */ }
            }
        } catch (err) {
            console.warn('[translate] model translation failed, returning source:', (err as Error)?.message);
        }
    }

    // 4. Map every requested string back (cache hit → translation, else original).
    const translations = capped.map(s => cache.get(s) ?? s);
    return json({ translations });
};

// Models occasionally wrap JSON in ```json fences — strip them before parse.
function stripFence(s: string): string {
    return s.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

function json(body: unknown) {
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
