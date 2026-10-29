// src/utils/ai-visibility.ts
// Admin → Platform → AI Visibility: the rules shared by the admin function, the background fetcher
// and the tests. Pure — no database, no network.
//
// The question the page answers: when a prospect asks an AI assistant for help, does Be More Swan
// come up, where, and is what it says true? Asked monthly, so the trend is the point; one run on its
// own says little.

export const ASSISTANTS = [
    { key: 'chatgpt', label: 'ChatGPT', auto: true, openUrl: (q: string) => `https://chatgpt.com/?q=${encodeURIComponent(q)}&hints=search` },
    { key: 'copilot', label: 'Microsoft Copilot', auto: false, openUrl: (q: string) => `https://copilot.microsoft.com/?q=${encodeURIComponent(q)}` },
    { key: 'gemini', label: 'Google Gemini', auto: true, openUrl: (_q: string) => 'https://gemini.google.com/app' },
    { key: 'claude', label: 'Claude', auto: true, openUrl: (q: string) => `https://claude.ai/new?q=${encodeURIComponent(q)}` },
    { key: 'google_ai_overview', label: 'Google AI Overview', auto: false, openUrl: (q: string) => `https://www.google.co.uk/search?q=${encodeURIComponent(q)}` },
] as const;
export type AssistantKey = typeof ASSISTANTS[number]['key'];
export const ASSISTANT_KEYS = ASSISTANTS.map((a) => a.key) as readonly string[];
/** The assistants whose answers can be fetched through an API (Gemini since 2026-10-29). */
export const AUTO_ASSISTANTS = ASSISTANTS.filter((a) => a.auto).map((a) => a.key) as AssistantKey[];

export const CATEGORIES = [
    { key: 'category', label: 'General (no brand)' },
    { key: 'industry', label: 'Industry' },
    { key: 'comparison', label: 'Comparison' },
    { key: 'brand', label: 'Names Be More Swan' },
] as const;
export const CATEGORY_KEYS = CATEGORIES.map((c) => c.key) as readonly string[];

export const LINK_VALUES = ['our_site', 'other_site', 'no_link'] as const;
export const ACCURATE_VALUES = ['yes', 'partly', 'no'] as const;

const BRAND_RE = /be\s*more\s*swan|bemoreswan/i;
const OUR_HOST_RE = /(^|\.)bemoreswan\.com$/i;

/**
 * Tools an answer is likely to recommend instead of us. Matched as whole words and CASE-SENSITIVE —
 * several are ordinary words in lower case ("explain later", "a buffer", "starter kit"), and an
 * answer writes a product's name with its capitals — so the competitor tally can fill itself on an
 * API answer. An admin can always edit the list on a
 * cell; anything named that is not here is simply not counted automatically.
 */
export const KNOWN_COMPETITORS = [
    'Buffer', 'Hootsuite', 'Sprout Social', 'Later', 'SocialBee', 'Metricool', 'Publer', 'Loomly', 'Planable',
    'Agorapulse', 'Sendible', 'Ocoya', 'Predis.ai', 'FeedHive', 'Lately', 'Jasper', 'Copy.ai', 'Writesonic',
    'Rytr', 'Anyword', 'Canva', 'Adobe Express', 'Simplified', 'HubSpot', 'Mailchimp', 'Brevo', 'Kit',
    'MailerLite', 'Klaviyo', 'ActiveCampaign', 'Wix', 'Squarespace', 'Durable', 'Hostinger', 'GoDaddy',
    'Shopify', 'Zapier', 'Semrush', 'Surfer', 'Apollo.io', 'Lemlist', 'Instantly', 'Clay', 'ChatGPT',
    'Gemini', 'Copilot', 'Claude', 'Perplexity', 'Notion AI', 'Grammarly', 'Vista Social', 'Sprinklr',
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const COMPETITOR_RES = KNOWN_COMPETITORS.map((name) => ({ name, re: new RegExp(`(^|[^A-Za-z0-9])${escapeRe(name)}([^A-Za-z0-9]|$)`) }));

/** Known competitors named in an answer, in the order of the list above, de-duplicated. */
export function detectCompetitors(text: string, self?: AssistantKey): string[] {
    const t = String(text || '');
    // An assistant naming ITSELF ("you could just use ChatGPT") is part of the answer, not a rival
    // it recommended over us — leave it out of that assistant's own tally.
    const selfName = self === 'chatgpt' ? 'ChatGPT' : self === 'claude' ? 'Claude' : self === 'gemini' ? 'Gemini' : self === 'copilot' ? 'Copilot' : null;
    return COMPETITOR_RES.filter(({ name, re }) => name !== selfName && re.test(t)).map(({ name }) => name);
}

// Our name at the START of a list entry, after any bold / link markup: "**Be More Swan** — …",
// "[Be More Swan](…)". An entry that merely mentions us mid-sentence is not us being recommended.
const LEAD = String.raw`(?:\*\*|__|\[)?\s*(?:be\s*more\s*swan|bemoreswan)`;
/** "3. **Be More Swan**", "**3.** Be More Swan", "3) Be More Swan" — captures the item's own number. */
const NUMBERED_LED_RE = new RegExp(String.raw`^\s*(?:\*\*)?(\d{1,2})[.)](?:\*\*)?\s+` + LEAD, 'i');
const BULLET_RE = /^\s*[-*•]\s+\S/;
const BULLET_LED_RE = new RegExp(String.raw`^\s*[-*•]\s+` + LEAD, 'i');

/**
 * What can be read off an answer without judgement: was Be More Swan named, where in the list of
 * tools, and did a link point at our site. Accuracy is deliberately NOT guessed — that needs a person
 * who knows the facts.
 *
 * position: our place in a list of recommended tools (1 = first) — the entry's own number in a
 * numbered list, or its place within a bullet list — counted only when the entry LEADS with our
 * name. Null when we are named only in prose, mid-sentence in a list item, or in a heading —
 * "## When Be More Swan makes more sense" is a section of a comparison, not a ranking. Headings were counted as list items until 2026-10-29, which scored a
 * "Be More Swan or Buffer" comparison as position 7 on the first production run.
 */
export function detectMention(answerText: string, citedUrls: string[] = []): {
    mentioned: boolean; position: number | null; link: 'our_site' | 'no_link' | null;
} {
    const text = String(answerText || '');
    const mentioned = BRAND_RE.test(text) || citedUrls.some((u) => isOurUrl(u));
    let position: number | null = null;
    if (mentioned) {
        const lines = text.split(/\r?\n/);
        // A numbered entry carries its own rank.
        for (const l of lines) {
            const m = NUMBERED_LED_RE.exec(l);
            if (m) { position = Number(m[1]); break; }
        }
        // Otherwise a bullet entry, counted within ITS list: the count restarts at any line that is
        // neither a bullet, blank, nor an indented continuation (a heading, a paragraph).
        if (position === null) {
            let n = 0;
            for (const l of lines) {
                if (BULLET_RE.test(l)) {
                    n++;
                    if (BULLET_LED_RE.test(l)) { position = n; break; }
                } else if (l.trim() && !/^\s/.test(l)) {
                    n = 0;
                }
            }
        }
    }
    const linkedUs = citedUrls.some((u) => isOurUrl(u)) || /https?:\/\/(?:www\.)?bemoreswan\.com/i.test(text);
    // 'other_site' (a review site or directory about us) is a judgement call — left to the admin.
    return { mentioned, position, link: linkedUs ? 'our_site' : mentioned ? 'no_link' : null };
}

export function isOurUrl(u: string): boolean {
    try { return OUR_HOST_RE.test(new URL(u).hostname); } catch { return false; }
}

export interface AnswerRow {
    questionId: number;
    assistant: string;
    mentioned: boolean | null;
    position: number | null;
    link: string | null;
    accurate: string | null;
    competitors: string[] | null;
}

interface Stat {
    answered: number; mentioned: number; mentionRate: number | null;
    avgPosition: number | null; linkedUs: number; accurate: number; accurateRate: number | null;
}

function stat(rows: AnswerRow[]): Stat {
    // Answered = a yes or a no was recorded. A fetched answer that failed (mentioned null) and an
    // untouched cell are both "not answered", so a skipped assistant never drags a rate down.
    const answered = rows.filter((r) => r.mentioned === true || r.mentioned === false);
    const mentioned = answered.filter((r) => r.mentioned === true);
    const positions = mentioned.map((r) => r.position).filter((p): p is number => typeof p === 'number' && p > 0);
    const accurate = mentioned.filter((r) => r.accurate === 'yes').length;
    return {
        answered: answered.length,
        mentioned: mentioned.length,
        mentionRate: answered.length ? mentioned.length / answered.length : null,
        avgPosition: positions.length ? positions.reduce((a, b) => a + b, 0) / positions.length : null,
        linkedUs: mentioned.filter((r) => r.link === 'our_site').length,
        accurate,
        accurateRate: mentioned.length ? accurate / mentioned.length : null,
    };
}

/** The run's summary: overall, per assistant, per question type, and who AI recommends instead. */
export function summarise(answers: AnswerRow[], questions: Array<{ id: number; category: string }>) {
    const catOf = new Map(questions.map((q) => [q.id, q.category]));
    const tally = new Map<string, number>();
    for (const a of answers) for (const c of a.competitors || []) {
        const name = String(c).trim();
        if (name) tally.set(name, (tally.get(name) || 0) + 1);
    }
    return {
        overall: stat(answers),
        byAssistant: ASSISTANTS.map((a) => ({ key: a.key, label: a.label, ...stat(answers.filter((r) => r.assistant === a.key)) })),
        byCategory: CATEGORIES.map((c) => ({ key: c.key, label: c.label, ...stat(answers.filter((r) => catOf.get(r.questionId) === c.key)) })),
        // Brand questions name us, so they are near-certain mentions; the number that moves is how
        // often we come up when nobody asked for us by name.
        unprompted: stat(answers.filter((r) => catOf.get(r.questionId) !== 'brand')),
        competitors: [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name, count]) => ({ name, count })),
    };
}

/** "Jasper, buffer ,  Buffer" → ['Jasper', 'buffer'] — trimmed, de-duplicated case-insensitively, capped. */
export function cleanCompetitors(raw: unknown): string[] {
    const list = Array.isArray(raw) ? raw : String(raw ?? '').split(',');
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of list) {
        const name = String(item ?? '').trim().slice(0, 60);
        if (!name || seen.has(name.toLowerCase())) continue;
        seen.add(name.toLowerCase());
        out.push(name);
        if (out.length >= 25) break;
    }
    return out;
}

/** The system prompt for an API answer: as close to a plain chat in the consumer app as an API allows. */
export const AUTO_ANSWER_SYSTEM =
    // Location only, as the consumer apps infer it. Anything more ("they run a small business")
    // would steer the answer in a way a real prospect's chat is not steered.
    'You are a helpful AI assistant answering a member of the public who is in the United Kingdom. ' +
    'Answer their question the way you normally would in a chat, searching the web when that helps. ' +
    'When you recommend products or tools, name them.';

// ── Accuracy suggestions ─────────────────────────────────────────────────────────────────────────
// "Accurate?" was the slowest judgement on the page. Claude now SUGGESTS it, from the live facts
// (src/lib/ai-visibility-accuracy.ts), and the suggestion is stored apart from `accurate`: the summary
// counts only what an admin confirmed, so a model's guess never becomes a reported number unseen.

/** The judge's instructions. `facts` is the live fact sheet; the judge has no web search on purpose. */
export function accuracySystemPrompt(facts: string): string {
    return [
        'You check what an AI assistant told a member of the public about Be More Swan, against the facts below.',
        'The facts are generated from the live website and database, so they are current and they win over anything the answer says.',
        '',
        'Judge ONLY claims about Be More Swan itself (its price, plans, trial, assistants, features, integrations, who it is for, where it is based).',
        'Ignore what the answer says about other tools.',
        'A claim is WRONG when the facts contradict it: a different price, an assistant or feature that is not in the live list, an integration the facts list as coming soon or do not list as live, a free trial of a different length.',
        'A claim the facts neither confirm nor contradict is NOT wrong. Leave it out.',
        '',
        'verdict:',
        '- "yes": nothing it says about Be More Swan is contradicted by the facts.',
        '- "partly": the gist is right but at least one claim is wrong.',
        '- "no": the core is wrong: what Be More Swan does, or its prices, or most of the claims.',
        '',
        'Reply with JSON only, no prose: {"verdict":"yes"|"partly"|"no","wrong":["each wrong claim, short, with the truth, e.g. said plans start at £39; they start at £29"]}',
        '',
        '=== FACTS ===',
        facts,
    ].join('\n');
}

/** Parse the judge's reply. Null when it is not the JSON asked for — the cell is then simply left unsuggested. */
export function parseAccuracyVerdict(text: string): { accurate: 'yes' | 'partly' | 'no'; wrongFacts: string | null } | null {
    const m = String(text || '').match(/\{[\s\S]*\}/);
    if (!m) return null;
    let obj: any;
    try { obj = JSON.parse(m[0]); } catch { return null; }
    const verdict = String(obj?.verdict || '').toLowerCase();
    if (!(ACCURATE_VALUES as readonly string[]).includes(verdict)) return null;
    const wrong = (Array.isArray(obj.wrong) ? obj.wrong : [])
        .map((w: unknown) => String(w ?? '').trim()).filter(Boolean).slice(0, 10);
    // "yes" with wrong claims listed contradicts itself; trust the list.
    const accurate = (verdict === 'yes' && wrong.length ? 'partly' : verdict) as 'yes' | 'partly' | 'no';
    return { accurate, wrongFacts: wrong.length ? wrong.join('; ').slice(0, 4000) : null };
}

/** Plain text out of an HTML page, for the fact sheet (scripts, styles and tags removed). */
export function htmlToText(html: string): string {
    return String(html || '')
        .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&pound;/g, '£').replace(/&#39;|&rsquo;/g, "'")
        .replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{2,}/g, '\n').trim();
}

/** Text and source URLs out of a Gemini generateContent reply grounded with Google Search. */
export function readGeminiResponse(data: any): { text: string; urls: string[] } {
    const cand = Array.isArray(data?.candidates) ? data.candidates[0] : null;
    const parts = Array.isArray(cand?.content?.parts) ? cand.content.parts : [];
    const text = parts.map((p: any) => (typeof p?.text === 'string' && !p.thought ? p.text : '')).join('').trim();
    const urls: string[] = [];
    for (const c of Array.isArray(cand?.groundingMetadata?.groundingChunks) ? cand.groundingMetadata.groundingChunks : []) {
        const web = c?.web;
        if (!web) continue;
        // Gemini's chunk `uri` is a vertexaisearch redirect, so it never names the site; its `title`
        // is the site's domain. Store the domain as a URL so "linked to our site" can be read off it.
        const title = String(web.title || '').trim();
        if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(title)) urls.push(`https://${title.toLowerCase()}/`);
        else if (typeof web.uri === 'string') urls.push(web.uri);
    }
    return { text, urls: [...new Set(urls)] };
}
