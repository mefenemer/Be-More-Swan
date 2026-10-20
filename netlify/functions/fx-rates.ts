// netlify/functions/fx-rates.ts
// Public: today's exchange rates FROM pounds, for the pricing page's currency picker (owner,
// 2026-10-20 — "the currency pick list should link to a live currency conversion").
//
//  GET → { base: 'GBP', date: 'YYYY-MM-DD', rates: { USD, EUR, AUD, CAD }, source }
//
// DISPLAY ONLY. Checkout charges in pounds and nothing else: the picker shows an approximate
// local figure next to the real £ price, never instead of it. That is why the old hand-set
// US$/€/A$/C$ prices were removed on 2026-10-19 — they advertised prices nobody could pay.
//
// Source: European Central Bank reference rates via Frankfurter (no key, updated each working day
// ~16:00 CET). Cached per function instance for an hour; on any failure the endpoint says so and
// the page simply offers pounds only — it never shows a stale-forever or invented rate.

import { withLambda } from '@netlify/aws-lambda-compat';

const FX_CURRENCIES = ['USD', 'EUR', 'AUD', 'CAD'] as const;
const SOURCE_URL = `https://api.frankfurter.dev/v1/latest?base=GBP&symbols=${FX_CURRENCIES.join(',')}`;
const TTL_MS = 60 * 60 * 1000;

type Rates = { base: 'GBP'; date: string; rates: Record<string, number>; source: string };
let cache: { at: number; value: Rates } | null = null;

const HEADERS = {
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=3600',
};

async function fetchRates(): Promise<Rates | null> {
    const res = await fetch(SOURCE_URL, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const j = await res.json() as { base?: string; date?: string; rates?: Record<string, unknown> };
    if (j.base !== 'GBP' || typeof j.date !== 'string' || !j.rates) return null;
    const rates: Record<string, number> = {};
    for (const c of FX_CURRENCIES) {
        const r = Number(j.rates[c]);
        if (Number.isFinite(r) && r > 0) rates[c] = r;
    }
    if (!Object.keys(rates).length) return null;
    return { base: 'GBP', date: j.date, rates, source: 'European Central Bank reference rates' };
}

export default withLambda(async (event) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, headers: HEADERS, body: 'Method Not Allowed' };

    if (cache && Date.now() - cache.at < TTL_MS) {
        return { statusCode: 200, headers: HEADERS, body: JSON.stringify(cache.value) };
    }
    try {
        const value = await fetchRates();
        if (value) {
            cache = { at: Date.now(), value };
            return { statusCode: 200, headers: HEADERS, body: JSON.stringify(value) };
        }
    } catch (err) {
        console.warn('[fx-rates] fetch failed:', (err as Error)?.message);
    }
    // A rate up to a day old is still a fair "approximately"; older than that, offer pounds only.
    if (cache && Date.now() - cache.at < 24 * TTL_MS) {
        return { statusCode: 200, headers: HEADERS, body: JSON.stringify(cache.value) };
    }
    return { statusCode: 503, headers: { ...HEADERS, 'Cache-Control': 'no-store' }, body: JSON.stringify({ error: 'Rates unavailable' }) };
});
