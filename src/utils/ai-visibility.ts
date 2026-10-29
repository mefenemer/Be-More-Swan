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
    { key: 'gemini', label: 'Google Gemini', auto: false, openUrl: (_q: string) => 'https://gemini.google.com/app' },
    { key: 'claude', label: 'Claude', auto: true, openUrl: (q: string) => `https://claude.ai/new?q=${encodeURIComponent(q)}` },
    { key: 'google_ai_overview', label: 'Google AI Overview', auto: false, openUrl: (q: string) => `https://www.google.co.uk/search?q=${encodeURIComponent(q)}` },
] as const;
export type AssistantKey = typeof ASSISTANTS[number]['key'];
export const ASSISTANT_KEYS = ASSISTANTS.map((a) => a.key) as readonly string[];
/** The two assistants whose answers can be fetched through an API. */
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

/** Lines that read as items of a list: "1. X", "2) X", "- X", "* X", "• X", or a markdown heading. */
const LIST_LINE_RE = /^\s*(?:\d{1,2}[.)]|[-*•]|#{2,4})\s+\S/;

/**
 * What can be read off an answer without judgement: was Be More Swan named, where in the list of
 * tools, and did a link point at our site. Accuracy is deliberately NOT guessed — that needs a person
 * who knows the facts.
 *
 * position: the 1-based index, among the answer's list lines, of the first one naming us. Null when
 * we are not named, or are named only in running prose (not a ranked recommendation).
 */
export function detectMention(answerText: string, citedUrls: string[] = []): {
    mentioned: boolean; position: number | null; link: 'our_site' | 'no_link' | null;
} {
    const text = String(answerText || '');
    const mentioned = BRAND_RE.test(text) || citedUrls.some((u) => isOurUrl(u));
    let position: number | null = null;
    if (mentioned) {
        const items = text.split(/\r?\n/).filter((l) => LIST_LINE_RE.test(l));
        const idx = items.findIndex((l) => BRAND_RE.test(l));
        if (idx >= 0) position = idx + 1;
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
