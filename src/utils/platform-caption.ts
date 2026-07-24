// src/utils/platform-caption.ts
// Fit one generated idea to a specific platform.
//
// The autopilot fan-out generates ONE caption/idea and ships it to every target platform. LinkedIn,
// Facebook and Instagram tolerate a long-form essay; X (280 chars) and Threads (500) do not — a
// LinkedIn-length post pasted to X is truncated/rejected, and a 10-hashtag block reads as spam there.
// This turns the single generated idea into a post that fits the platform:
//   • short-form platforms get the model's short caption variant (or a derived trim), hard-clamped so
//     caption + disclosure footer + hashtags stays under the platform limit — the footer (a legal
//     requirement) is NEVER dropped or truncated;
//   • hashtags are de-duplicated, acronym-cased, and capped to a platform-appropriate count.

import { appendFooter } from './disclosure-footer';

export const SHORT_FORM_PLATFORMS = new Set(['x', 'threads']);
export function isShortForm(platform: string | null | undefined): boolean {
    return SHORT_FORM_PLATFORMS.has((platform || '').toLowerCase());
}

// Hard character ceilings. The publisher joins caption + hashtags with a blank line and BOTH count
// toward the platform limit, so these are the budget for the whole assembled post. Long-form
// platforms are generous enough that we don't actively trim them.
const TEXT_LIMIT: Record<string, number> = { x: 280, threads: 500 };
export function platformTextLimit(platform: string | null | undefined): number {
    return TEXT_LIMIT[(platform || '').toLowerCase()] ?? 3000;
}

// Hashtag count cap per platform. Short-form platforms want 1–2; long-form can carry a fuller set.
function hashtagCap(platform: string | null | undefined): number {
    return isShortForm(platform) ? 2 : 10;
}

// Whole-tag acronym casing so a free-generated "#ai"/"#seo"/"#saas" lands as the brand-correct form.
// Only applied when the ENTIRE tag is the acronym — never mangles embedded text (e.g. "#SaasFatigue"
// is left alone rather than risk a wrong edit).
const ACRONYM_CASE: Record<string, string> = {
    ai: 'AI', seo: 'SEO', saas: 'SaaS', b2b: 'B2B', b2c: 'B2C', d2c: 'D2C', roi: 'ROI',
    crm: 'CRM', sme: 'SME', smes: 'SMEs', kpi: 'KPI', ceo: 'CEO', ux: 'UX', ui: 'UI',
    diy: 'DIY', faq: 'FAQ', uk: 'UK', usa: 'USA', us: 'US',
};

// The model is asked to keep hashtags in the separate "hashtags" field, but it intermittently
// appends a block of them to the END of the caption anyway — sometimes misspelled (e.g. "#BeMorSwan").
// Left in place they duplicate the hashtags field, push our disclosure footer out of last position,
// and bypass normalizeHashtags entirely (so a brand typo ships). Strip a trailing run of hashtags
// (and surrounding whitespace) from the body before the footer is appended. Only a TRAILING block is
// removed, so a hashtag used mid-sentence is left untouched.
const TRAILING_HASHTAGS_RE = /(?:\s*#[\p{L}\p{N}_]+)+\s*$/u;
export function stripTrailingHashtags(caption: string | null | undefined): string {
    return String(caption ?? '').replace(TRAILING_HASHTAGS_RE, '').replace(/\s+$/, '');
}

/** The trailing hashtag block the model leaked into a caption (or '' if none). Used only as a
 *  fallback source of tags when the dedicated hashtags field came back empty. */
export function trailingHashtagBlock(caption: string | null | undefined): string {
    const m = String(caption ?? '').match(TRAILING_HASHTAGS_RE);
    return m ? m[0].trim() : '';
}

// The same leak, one field over. The blueprint's COMPLIANCE section used to be dumped into the
// system prompt verbatim, disclosure strings and all, so the model wrote its own copy of the
// workspace footer (and the per-assistant disclosure) into the caption body — and then the code
// appended the real one, producing up to three disclosures on a single post, each worded slightly
// differently. process-content-jobs now withholds those keys from the prompt, but that alone is
// not enough: blueprints compiled BEFORE that change still carry the text, and a model steeped in
// this phrasing will occasionally produce a near-miss on its own.
//
// So the body is also cleaned. Matching is deliberately SHAPE-based rather than exact-text: the
// echoes are never verbatim (that is the whole problem — "Digital Employee" vs "Digital Assistant"),
// so an equality check would catch none of them. Only TRAILING lines are considered, and only ones
// that read unmistakably as an AI disclosure, so a post that legitimately talks about AI in its body
// is untouched.
// Disclosures are short standalone lines, so anything longer is prose that happens to mention AI.
const MAX_DISCLOSURE_LINE = 160;
const FURNITURE = '^\\s*[*_>\\s]*';                            // markdown emphasis / quote markers
const TAIL = '[\\s*_.!]*$';

// STRONG — phrasings distinctive enough to match as a PREFIX, because they reliably continue into
// the rest of the disclosure ("Composed with Marvin, my Be More Swan AI Digital Assistant…").
const DISCLOSURE_STRONG_RE = new RegExp(
    FURNITURE +
    '(?:' +
        'composed\\s+with\\b' +
        '|(?:some\\s+)?content\\s+on\\s+this\\s+account\\b' +
        '|(?:this|the)\\s+(?:post|message|content|caption)\\s+(?:was|is)\\s+(?:\\w+\\s+){0,3}?(?:with|using|by)\\s+ai\\b' +
    ')',
    'i',
);

// WEAK — phrasings that are ALSO ordinary English, so the whole line must be the disclosure and
// nothing else. "AI-generated content." is a label; "AI-generated images are banned in our brand
// guidelines — here is why." is a post, and an earlier prefix-match ate its last line.
const DISCLOSURE_WEAK_RE = new RegExp(
    FURNITURE +
    '(?:' +
        'ai[-\\s]?(?:generated|assisted)(?:\\s+content)?' +
        '|(?:written|created|drafted|generated|made|produced)\\s+(?:with|using|by)\\s+(?:the\\s+help\\s+of\\s+)?ai(?:\\s+assistance)?' +
    ')' +
    TAIL,
    'i',
);

function isDisclosureLine(line: string): boolean {
    if (line.length > MAX_DISCLOSURE_LINE) return false;
    return DISCLOSURE_STRONG_RE.test(line) || DISCLOSURE_WEAK_RE.test(line);
}

/**
 * Remove model-echoed AI-disclosure lines from the END of a caption body.
 *
 * Runs before the canonical footer is appended, so the post ends with exactly one disclosure — the
 * legally-controlled one the workspace configured. Stops at the first trailing line that is NOT a
 * disclosure, so only the tail is ever touched.
 */
export function stripDisclosureEchoes(caption: string | null | undefined): string {
    const lines = String(caption ?? '').split('\n');
    while (lines.length) {
        const last = lines[lines.length - 1];
        if (!last.trim()) { lines.pop(); continue; }            // trailing blank
        if (!isDisclosureLine(last)) break;                     // real content — stop here
        lines.pop();
    }
    return lines.join('\n').replace(/\s+$/, '');
}

/**
 * Clean the tail of a generated body: leaked hashtag blocks and echoed disclosures, in whatever
 * order the model emitted them.
 *
 * Alternating to a fixed point rather than running each once, because the two interleave — a model
 * that writes "…body / #Tags / Composed with Marvin…" hides the hashtags behind the disclosure, and
 * a single pass of each would leave one of them stranded in the caption.
 */
export function cleanGeneratedBody(caption: string | null | undefined): string {
    let out = String(caption ?? '');
    for (let i = 0; i < 4; i++) {                               // bounded; converges in 1–2 in practice
        const next = stripDisclosureEchoes(stripTrailingHashtags(out));
        if (next === out) break;
        out = next;
    }
    return out;
}

// Per-brand hashtag governance (stored on the assistant). `canonical` tags are always included and
// spelled exactly as given; `aliases` map a lowercased variant to its canonical spelling so the
// account's own tags stop drifting between posts (e.g. #HireDontLearn → #HireNotLearn,
// #SaasFatigue → #SaaSFatigue). Both optional — with neither, normalization is generic hygiene only.
export interface BrandHashtags {
    canonical?: string[];
    aliases?: Record<string, string>;
}

const bareTag = (t: string) => t.replace(/^#+/, '').trim();

/**
 * De-dupe (case-insensitive), acronym-case, cap per platform, and — when a brand config is supplied —
 * force the brand's canonical tags in first (correctly spelled) and rewrite known variants to their
 * canonical form. Generic (no brand) behaviour is unchanged.
 */
export function normalizeHashtags(
    raw: string | null | undefined,
    platform: string | null | undefined,
    brand?: BrandHashtags,
): string {
    const canonical = (brand?.canonical ?? []).map(bareTag).filter(Boolean);
    const canonByKey = new Map(canonical.map(c => [c.toLowerCase(), c]));
    const aliasByKey = new Map(
        Object.entries(brand?.aliases ?? {}).map(([k, v]) => [bareTag(k).toLowerCase(), bareTag(v)]),
    );
    const resolve = (tag: string): string => {
        const key = tag.toLowerCase();
        return aliasByKey.get(key) ?? canonByKey.get(key) ?? ACRONYM_CASE[key] ?? tag;
    };

    const seen = new Set<string>();
    const out: string[] = [];
    const push = (token: string) => {
        const tag = bareTag(token);
        if (!tag) return;
        const resolved = resolve(tag);
        const key = resolved.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        out.push('#' + resolved);
    };

    // Brand tags first (always present + canonical spelling), then the model's own tags.
    for (const c of canonical) push(c);
    for (const token of String(raw ?? '').split(/[\s,]+/)) push(token);

    return out.slice(0, hashtagCap(platform)).join(' ');
}

// Fallback when the model didn't return a short variant: take the opening of the long caption up to a
// sentence/word boundary, and re-attach any URL it contained (the CTA link must survive the trim).
function deriveShort(longCaption: string, budget: number): string {
    const url = (longCaption.match(/https?:\/\/\S+|\bwww\.\S+|\b[a-z0-9-]+\.(?:com|co|io|ai|app)\b\S*/i) || [])[0] || '';
    const urlTail = url ? ` ${url}` : '';
    const room = Math.max(0, budget - urlTail.length);
    let body = longCaption.replace(/\s+/g, ' ').trim();
    if (body.length > room) {
        body = body.slice(0, room);
        // Prefer to end on a sentence, else a word boundary — never mid-word.
        const lastStop = Math.max(body.lastIndexOf('. '), body.lastIndexOf('! '), body.lastIndexOf('? '));
        body = lastStop > room * 0.5 ? body.slice(0, lastStop + 1) : body.replace(/\s+\S*$/, '');
    }
    return (body + urlTail).trim();
}

// Trim a body so that `body + footer + credit` fits `limit`, preserving the footer and credit in full.
function clampBodyPreservingFooter(body: string, footer: string | null, credit: string, limit: number): string {
    const reserved = (footer ? footer.length + 2 : 0) + credit.length; // +2 for the "\n\n" separator
    const room = Math.max(0, limit - reserved);
    let b = body.trim();
    if (b.length > room) b = b.slice(0, room).replace(/\s+\S*$/, '').trim();
    return appendFooter(b, footer) + credit;
}

export interface FitInput {
    platform: string;
    longCaption: string;              // full caption body, WITHOUT footer
    shortCaption?: string | null;     // model's short variant, WITHOUT footer (may be absent)
    hashtagsRaw?: string | null;
    footer: string | null;            // disclosure footer — legal, never dropped
    creditSuffix?: string;            // e.g. Pexels photographer credit, appended after the footer
    brand?: BrandHashtags;            // per-assistant canonical hashtags / aliases (optional)
}

/**
 * Assemble a platform-fit `{ caption, hashtags }` from one generated idea. Long-form platforms get the
 * full caption; short-form platforms get the short variant (or a derived trim), guaranteed to fit the
 * platform's character limit with the footer intact.
 */
export function fitForPlatform(input: FitInput): { caption: string; hashtags: string } {
    const { platform, footer } = input;
    const credit = input.creditSuffix ?? '';
    // Pull any trailing hashtag block the model leaked into the caption body — hashtags belong only in
    // the separate field (normalized below), and leaving them in the body strands the footer and ships
    // typos. Fall back to those leaked tags for the hashtags field only if the field itself is empty.
    // …and any AI-disclosure line the model echoed out of its own prompt: the real footer is
    // appended below, and shipping both is the "three disclosures on one post" bug.
    const longCaption = cleanGeneratedBody(input.longCaption);
    const hashtags = normalizeHashtags(input.hashtagsRaw || trailingHashtagBlock(input.longCaption), platform, input.brand);

    if (!isShortForm(platform)) {
        return { caption: appendFooter(longCaption, footer) + credit, hashtags };
    }

    const limit = platformTextLimit(platform);
    // Budget the body: leave room for footer, credit, and the hashtag line the publisher appends.
    const footerLen = footer ? footer.length + 2 : 0;
    const tagLen = hashtags ? hashtags.length + 2 : 0;
    const bodyBudget = Math.max(40, limit - footerLen - credit.length - tagLen);

    let body = cleanGeneratedBody(input.shortCaption?.trim() || deriveShort(longCaption, bodyBudget));
    if (body.length > bodyBudget) body = deriveShort(body, bodyBudget);

    let caption = appendFooter(body, footer) + credit;
    let tags = hashtags;

    // Defensive final clamp (the model can overrun its instructed length): shed hashtags first, then
    // trim the body — the footer and credit always survive.
    const combined = (c: string, h: string) => (h ? `${c}\n\n${h}`.length : c.length);
    if (combined(caption, tags) > limit) {
        tags = '';
        if (caption.length > limit) caption = clampBodyPreservingFooter(body, footer, credit, limit);
    }
    return { caption, hashtags: tags };
}
