// src/lib/market-enumerability.ts
// Is this a market you can LIST, or only one you can SAMPLE?
//
// ── The question the product never asked ─────────────────────────────────────
// Discovery is a sampler: it writes search queries and reads what ranks. For a fuzzy market with no
// registry — boutique hotels, retreat venues, creative agencies — that is exactly the right
// instrument, and it works well. For a regulated market with a statutory register — schools, care
// homes, GP practices, solicitors, nurseries — it is the wrong one, and no amount of raising caps
// makes it right: 4,500 South East schools are all listed, by name, in a file anyone can download.
//
// The product could not tell those two cases apart and never said which it was in. That is the
// actual defect behind "why did it only find 175 schools", and it is answerable at brief time from
// the campaign's own idea text.
//
// ── Why a model, and what it is NOT asked ────────────────────────────────────
// "Does an official register exist for this sector?" is a factual recall question models handle
// well. "How many of them are there?" is not — a plausible invented headcount presented next to
// exact arithmetic (src/config/plan-reach.ts) would be the most dangerous number on the screen. So
// a COUNT IS NEVER REQUESTED, and the register name is offered as something to check rather than
// asserted as fact.
//
// ── Fails soft, always ───────────────────────────────────────────────────────
// This runs while a user waits on the brief screen, and it is advice, not a gate. Every failure
// path — no key, a timeout, bad JSON, an unparseable shape — returns null and the screen simply
// omits the advisory. It must never block a plan the user could otherwise approve.

import Anthropic from '@anthropic-ai/sdk';
import { parseModelJson } from '../utils/model-json';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-haiku-4-5-20251001';

export interface MarketAdvice {
    /** True when the target market is one with a public, reasonably complete listing. */
    enumerable: boolean;
    /** What that listing is called, e.g. "Get Information About Schools (GIAS)". Null when unsure. */
    registerName: string | null;
    /** One short sentence naming the sector as understood. Never a count. */
    sector: string | null;
}

const SYSTEM =
`You advise on B2B prospecting strategy. Given a description of who a business wants to find, decide ONE thing: whether that target market has an official, public, reasonably complete register or directory that someone could download or browse to get a near-complete list.

ENUMERABLE means a regulated or officially-registered sector where a public list exists and is close to complete — state schools, care homes, GP practices, dentists, solicitors, charities, licensed premises, registered nurseries, universities, NHS trusts.

NOT ENUMERABLE means a market defined by taste, style, size or behaviour rather than registration — "boutique hotels", "creative agencies", "independent skincare brands", "companies without a booking system". No list of these exists because nobody registers as one.

⚠️ Only name a register you are genuinely confident exists and is public. If you are not sure, set registerName to null — a made-up register name sends someone hunting for a file that does not exist, which is worse than saying nothing. NEVER estimate how many organisations there are; you are not asked and a guess would be presented next to exact figures.

Return STRICT JSON only:
{ "enumerable": true|false, "registerName": "<name of the public register, or null>", "sector": "<the market in 2-5 words>" }`;

/**
 * Never throws, never blocks. Returns null when there is nothing dependable to say.
 */
export async function assessMarket(idea: string, icp?: Record<string, unknown> | null): Promise<MarketAdvice | null> {
    const text = String(idea ?? '').trim();
    if (!text || !process.env.ANTHROPIC_API_KEY) return null;

    try {
        const resp = await anthropic.messages.create({
            model: MODEL,
            max_tokens: 200,
            system: SYSTEM,
            messages: [{
                role: 'user',
                content: `Who they want to find:\n${text.slice(0, 1000)}`
                    + (icp ? `\n\nIdeal customer profile:\n${JSON.stringify(icp).slice(0, 600)}` : ''),
            }],
        });
        const raw = resp.content[0]?.type === 'text' ? resp.content[0].text : '';
        const parsed = parseModelJson<Record<string, unknown>>(raw);
        if (!parsed || typeof parsed.enumerable !== 'boolean') return null;

        const name = typeof parsed.registerName === 'string' ? parsed.registerName.trim().slice(0, 120) : '';
        const sector = typeof parsed.sector === 'string' ? parsed.sector.trim().slice(0, 80) : '';
        return {
            enumerable: parsed.enumerable,
            // A register name only means anything alongside an enumerable verdict; carrying one
            // through on a "not enumerable" answer would contradict the advice beside it.
            registerName: parsed.enumerable && name ? name : null,
            sector: sector || null,
        };
    } catch (err) {
        console.error('[market-enumerability] assessment failed (non-fatal):', err);
        return null;
    }
}
