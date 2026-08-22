// src/utils/swan-index/safety.ts
// The Swan Index — the editorial safety screen an editor sees before they approve a piece.
//
// ── What this is for ───────────────────────────────────────────────────────────────────────────
// Approving a submission publishes someone else's writing, and someone else's images, on a domain
// we own, under a masthead that carries our reputation and their name. The editor doing it has a
// queue and thirty seconds. This turns the checks they would otherwise do by eye — or, honestly,
// skip — into a fixed list with a verdict against each one, so "approve" is a decision made on
// evidence rather than on the headline looking fine.
//
// ── The one rule this module is built around ───────────────────────────────────────────────────
// A check that could not run reports 'unchecked', NEVER 'pass', and one unchecked item is enough to
// stop the whole report saying it is confirmed. The moderation API is fail-open by design elsewhere
// in this codebase (src/utils/moderation.ts) because blocking a customer's work on an unconfigured
// key would be worse than letting it through. Here the cost is reversed: an editor told "all clear"
// by a screen that never ran is worse than one told nothing at all, because they stop looking.
// `confirmed` is therefore true only when every single check returned 'pass'.
//
// ── Where it runs ──────────────────────────────────────────────────────────────────────────────
// Lazily, the first time an editor opens a piece in the review drawer, and the result is stored on
// the row. Not at submit time: that would put a third-party API call inside publishBlogPost()'s
// syndication path, where a slow response costs the AUTHOR their publish, and most submissions are
// read long after they arrive. Stored rather than recomputed so the report is also a record of what
// was true when the decision was made.

export type SafetyStatus = 'pass' | 'warn' | 'fail' | 'unchecked';

export interface SafetyCheck {
    id: string;
    label: string;
    status: SafetyStatus;
    /** One line an editor can act on. Never empty. */
    detail: string;
}

export interface SafetyReport {
    /** True only when EVERY check passed. See the module note. */
    confirmed: boolean;
    checks: SafetyCheck[];
    ranAt: string;
    /** Bumped when the check LIST changes, so a stored report from an older set is re-run. */
    version: number;
}

/** Bump when checks are added, removed or materially changed. */
export const SAFETY_VERSION = 1;

// ── the moderation call ────────────────────────────────────────────────────────────────────────

/**
 * Categories that make a piece unpublishable here rather than merely worth a second look.
 *
 * Narrower than a general-purpose blocklist on purpose: this is a business magazine, and a piece
 * about laying people off, a fraud that nearly killed a company, or a founder's breakdown is
 * exactly the writing it exists to publish. Flagging those as failures would train editors to
 * override the screen, which costs more than the screen buys.
 */
const SEVERE = new Set([
    'sexual', 'sexual/minors',
    'hate', 'hate/threatening',
    'harassment/threatening',
    'violence/graphic',
    'self-harm', 'self-harm/intent', 'self-harm/instructions',
    'illicit', 'illicit/violent',
]);

export interface ModerationInput { text?: string; imageUrls?: string[] }
export interface ModerationOutcome { ran: boolean; flagged: string[]; severe: string[]; error?: string }

/**
 * Why text and images are moderated in SEPARATE calls.
 *
 * They were one call — cheaper, and the API takes both in a single `input` array. But the endpoint
 * fetches every image URL itself, and if it cannot reach even one it fails the WHOLE request with
 * `image_url_unavailable`. Measured against the live API 2026-08-22: one unreachable image turned
 * the combined call into a 400, which this module reported as "not checked" for the text as well —
 * so a single expired presigned URL silently disabled the text moderation on that piece. The text
 * was always checkable; losing it to an unrelated image failure is the exact false-negative this
 * screen exists to prevent. Two calls, two verdicts, each failing on its own.
 */

/**
 * One call to the OpenAI moderation endpoint, text and images together.
 *
 * `omni-moderation-latest` is the multimodal model — the older text-only one silently ignores image
 * parts, which would have produced a confident "images checked" over an image nobody looked at.
 */
export async function moderateForReview(input: ModerationInput): Promise<ModerationOutcome> {
    const key = process.env.OPENAI_API_KEY;
    if (!key) return { ran: false, flagged: [], severe: [], error: 'OPENAI_API_KEY is not set on this environment.' };

    const parts: unknown[] = [];
    if (input.text?.trim()) parts.push({ type: 'text', text: input.text.slice(0, 40_000) });
    for (const url of (input.imageUrls || []).slice(0, 10)) parts.push({ type: 'image_url', image_url: { url } });
    if (!parts.length) return { ran: true, flagged: [], severe: [] };

    try {
        const res = await fetch('https://api.openai.com/v1/moderations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
            body: JSON.stringify({ model: 'omni-moderation-latest', input: parts }),
            signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) {
            // The body carries the actual reason (`image_url_unavailable`, a bad model name, an
            // auth failure). Discarding it left every failure looking identical to the editor.
            const detail = await res.text().catch(() => '');
            const code = detail.match(/"code":\s*"([^"]+)"/)?.[1] || detail.match(/"message":\s*"([^"]+)"/)?.[1];
            return { ran: false, flagged: [], severe: [], error: `Moderation API returned ${res.status}${code ? ` (${code})` : ''}.` };
        }
        const data = await res.json() as { results?: Array<{ categories?: Record<string, boolean> }> };
        const flagged = new Set<string>();
        for (const result of data.results || []) {
            for (const [name, hit] of Object.entries(result.categories || {})) if (hit) flagged.add(name);
        }
        return {
            ran: true,
            flagged: [...flagged],
            severe: [...flagged].filter((c) => SEVERE.has(c)),
        };
    } catch (err) {
        return { ran: false, flagged: [], severe: [], error: err instanceof Error ? err.message : 'Moderation call failed.' };
    }
}

// ── the deterministic checks ───────────────────────────────────────────────────────────────────

/** Visible text from the rendered body. Crude by design — moderation reads prose, not markup. */
export function textOf(html: string): string {
    return String(html || '')
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&(nbsp|amp|lt|gt|quot|#39);/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

export interface ImgTag { src: string; alt: string | null }

/** Every <img> in the body, with whatever alt it carries (null when the attribute is absent). */
export function imagesOf(html: string): ImgTag[] {
    const out: ImgTag[] = [];
    for (const tag of String(html || '').match(/<img\b[^>]*>/gi) || []) {
        const src = tag.match(/\bsrc\s*=\s*["']([^"']*)["']/i)?.[1] || '';
        const altAttr = tag.match(/\balt\s*=\s*["']([^"']*)["']/i);
        if (src) out.push({ src, alt: altAttr ? altAttr[1] : null });
    }
    return out;
}

/** Every href in the body. */
export function linksOf(html: string): string[] {
    return (String(html || '').match(/<a\b[^>]*\bhref\s*=\s*["']([^"']*)["']/gi) || [])
        .map((tag) => tag.match(/\bhref\s*=\s*["']([^"']*)["']/i)?.[1] || '')
        .filter(Boolean);
}

function hostOf(url: string): string | null {
    try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
}

// ── the screen ─────────────────────────────────────────────────────────────────────────────────

export interface SafetyInput {
    title: string;
    dek?: string | null;
    /** Media-resolved article body, exactly as the editor is about to read it. */
    bodyHtml: string;
    /** Resolved feature image URL, if the piece has one. */
    featureImageUrl?: string | null;
    /** payload.featureImage.alt — the hero's alt text. */
    featureImageAlt?: string | null;
    /** blog_posts.canonical_url as copied onto the submission. */
    authorCanonicalUrl?: string | null;
    /** The publication's own origin, so a "canonical" pointing back at us can be caught. */
    publicationOrigin: string;
    aiAssisted: boolean;
    profileStatus: string;
    monthlyPostCap: number | null;
    monthlyPostCount: number;
}

/** Injectable for tests: the real one calls OpenAI, so the failure paths are otherwise unreachable. */
export type Moderator = (input: ModerationInput) => Promise<ModerationOutcome>;

/**
 * Run the whole benchmark. Text and images are moderated separately — see the note above.
 *
 * Never throws: an editor opening the drawer must always get a report, and a screen that 500s the
 * page it is meant to help is worse than one that reports its own failure.
 */
export async function runSafetyScreen(input: SafetyInput, moderate: Moderator = moderateForReview): Promise<SafetyReport> {
    const checks: SafetyCheck[] = [];

    const bodyText = textOf(input.bodyHtml);
    const images = imagesOf(input.bodyHtml);
    const imageUrls = [
        ...(input.featureImageUrl ? [input.featureImageUrl] : []),
        ...images.map((i) => i.src),
    ].filter((u) => /^https?:\/\//i.test(u));

    // 1 — the text. Always checkable, so it is never held hostage to an image (see the note above).
    const textMod = await moderate({
        text: [input.title, input.dek || '', bodyText].filter(Boolean).join('\n\n'),
    });
    checks.push({
        id: 'text-safety',
        label: 'Text passes the Safe Content Benchmark',
        status: !textMod.ran ? 'unchecked'
            : textMod.severe.length ? 'fail'
                : textMod.flagged.length ? 'warn' : 'pass',
        detail: !textMod.ran
            ? `Not checked — ${textMod.error || 'the moderation service did not respond.'}`
            : textMod.severe.length
                ? `Flagged: ${textMod.severe.join(', ')}. Read before deciding.`
                : textMod.flagged.length
                    ? `Non-severe flags: ${textMod.flagged.join(', ')}. Usually the subject matter, not a problem.`
                    : `No flags across ${bodyText.split(' ').length} words.`,
    });

    // 2 — the images, one call of their own.
    const imageMod = imageUrls.length ? await moderate({ imageUrls }) : null;
    checks.push({
        id: 'image-safety',
        label: 'Images pass the Safe Content Benchmark',
        status: !imageMod ? 'pass'
            : !imageMod.ran ? 'unchecked'
                : imageMod.severe.length ? 'fail'
                    : imageMod.flagged.length ? 'warn' : 'pass',
        detail: !imageMod
            ? 'No images on this piece.'
            : !imageMod.ran
                // `image_url_unavailable` means the endpoint could not FETCH the picture — a
                // presigned URL that expired between publish and review, most likely. Named
                // explicitly because "not checked" alone sends an editor looking for a safety
                // problem when the answer is to re-run the screen.
                ? /image_url_unavailable|Could not download/i.test(imageMod.error || '')
                    ? `Not checked — the moderation service could not download ${imageUrls.length === 1 ? 'the image' : 'one of the images'}. Usually an expired media link; re-run the screen.`
                    : `Not checked — ${imageMod.error || 'the moderation service did not respond.'}`
                : imageMod.severe.length
                    ? `Flagged: ${imageMod.severe.join(', ')} across ${imageUrls.length} image(s).`
                    : imageMod.flagged.length
                        ? `Non-severe flags: ${imageMod.flagged.join(', ')}. Check by eye.`
                        : `${imageUrls.length} image(s) checked, nothing flagged.`,
    });

    // 3 — alt text. Accessibility, and the one content defect that is genuinely invisible in a
    // review drawer: the editor is looking at the picture, so nothing tells them it has no label.
    const missingAlt = images.filter((i) => !i.alt || !i.alt.trim()).length
        + (input.featureImageUrl && !input.featureImageAlt?.trim() ? 1 : 0);
    const totalImages = images.length + (input.featureImageUrl ? 1 : 0);
    checks.push({
        id: 'image-alt-text',
        label: 'Every image has alt text',
        status: !totalImages ? 'pass' : missingAlt ? 'warn' : 'pass',
        detail: !totalImages ? 'No images on this piece.'
            : missingAlt ? `${missingAlt} of ${totalImages} image(s) have no alt text.`
                : `All ${totalImages} image(s) labelled.`,
    });

    // 4 — the canonical credit. THE promise the whole network is built on: a syndicated copy that
    // does not point home is the thing this publication tells contributors it will never do.
    const canonicalHost = hostOf(input.authorCanonicalUrl || '');
    const ownHost = hostOf(input.publicationOrigin);
    checks.push({
        id: 'author-credit',
        label: 'Points back at the author’s original',
        status: !canonicalHost ? 'fail' : canonicalHost === ownHost ? 'fail' : 'pass',
        detail: !canonicalHost
            ? 'No canonical URL — this copy would compete with the author’s own page.'
            : canonicalHost === ownHost
                ? 'The canonical URL points at us, not at the author’s site.'
                : `Credited to ${canonicalHost}.`,
    });

    // 5 — links. A masthead that accepts third-party posts is a link-injection target, and a piece
    // that is mostly outbound links is the shape of paid placement rather than of writing.
    const links = linksOf(input.bodyHtml);
    const badScheme = links.filter((h) => /^\s*(javascript|data|vbscript):/i.test(h));
    const outbound = links.filter((h) => /^https?:\/\//i.test(h) && hostOf(h) !== ownHost);
    const words = bodyText ? bodyText.split(' ').length : 0;
    const linkHeavy = words > 0 && outbound.length >= 10 && outbound.length > words / 120;
    checks.push({
        id: 'link-integrity',
        label: 'Links are safe and proportionate',
        status: badScheme.length ? 'fail' : linkHeavy ? 'warn' : 'pass',
        detail: badScheme.length
            ? `${badScheme.length} script or data URL in the body.`
            : linkHeavy
                ? `${outbound.length} outbound links in ${words} words — read as placement, not prose.`
                : `${outbound.length} outbound link(s), ${words} words.`,
    });

    // 6 — the AI disclosure. Not a judgement, a confirmation: the editor should know which one the
    // published page will carry before they approve it (EU AI Act Art. 50).
    checks.push({
        id: 'ai-disclosure',
        label: 'AI disclosure matches the piece',
        status: 'pass',
        detail: input.aiAssisted
            ? 'Machine-drafted — the published page carries the AI notice.'
            : 'Hand-written — no AI notice, correctly.',
    });

    // 7 — the contributor. Cheap to check, and the two states that make an approval wrong for
    // reasons that have nothing to do with the writing.
    const overCap = input.monthlyPostCap != null && input.monthlyPostCount > input.monthlyPostCap;
    checks.push({
        id: 'contributor-standing',
        label: 'Contributor is in good standing',
        status: input.profileStatus !== 'active' ? 'fail' : overCap ? 'warn' : 'pass',
        detail: input.profileStatus !== 'active'
            ? `Profile is ${input.profileStatus} — approving would not make this piece visible.`
            : overCap
                ? `Over the monthly limit (${input.monthlyPostCount} of ${input.monthlyPostCap}).`
                : input.monthlyPostCap == null
                    ? 'Active, uncapped.'
                    : `Active, ${input.monthlyPostCount} of ${input.monthlyPostCap} this month.`,
    });

    return {
        confirmed: checks.every((c) => c.status === 'pass'),
        checks,
        ranAt: new Date().toISOString(),
        version: SAFETY_VERSION,
    };
}

/** Read a stored blob back, or null when it is absent or from an older check list. */
export function readSafetyReport(stored: unknown): SafetyReport | null {
    if (!stored || typeof stored !== 'object') return null;
    const r = stored as Partial<SafetyReport>;
    if (r.version !== SAFETY_VERSION || !Array.isArray(r.checks) || typeof r.ranAt !== 'string') return null;
    // `confirmed` is recomputed rather than trusted: it is the one field a stale or hand-edited row
    // could use to claim an all-clear the checks below it do not support.
    return { checks: r.checks, ranAt: r.ranAt, version: r.version, confirmed: r.checks.every((c) => c.status === 'pass') };
}

/** One line for the queue list and the audit log. */
export function summariseSafety(report: SafetyReport | null): string {
    if (!report) return 'Not screened yet';
    const passed = report.checks.filter((c) => c.status === 'pass').length;
    if (report.confirmed) return `Safe Content Benchmark confirmed — ${passed}/${report.checks.length}`;
    const worst = report.checks.find((c) => c.status === 'fail') || report.checks.find((c) => c.status === 'warn')
        || report.checks.find((c) => c.status === 'unchecked');
    return `${passed}/${report.checks.length} confirmed — ${worst?.label || 'needs review'}`;
}
