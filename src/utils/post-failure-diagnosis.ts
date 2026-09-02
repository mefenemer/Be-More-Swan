// src/utils/post-failure-diagnosis.ts
// Turns a scheduled_posts.failure_reason blob into something a human can act on.
//
// ── Why this exists ─────────────────────────────────────────────────────────────────────────────
// Every publisher (publish-social-posts, publish-facebook, publish-instagram,
// publish-youtube-background) stores the same shape when it gives up on a post:
//
//     { httpStatus, errorCode?, errorSubcode?, errorMessage, isRetryable }
//
// That is the PLATFORM's words — "(#100) Invalid parameter", "Error validating access token",
// "(#1363037) media upload failed". The Review Queue used to show it raw, or not at all, which left
// the reviewer with a red chip, a sentence written for a developer, and nothing to press. This
// module answers the two questions the reviewer actually has: what went wrong, and what do I do
// about it.
//
// The classification is deliberately COARSE. There are hundreds of Graph error codes and the exact
// one rarely changes the remedy: whatever the subcode, an expired token means reconnect, a rejected
// picture means swap the media, and a 500 means try again. `kind` is what the UI branches on — the
// buttons it offers come from the kind, not from the code — so a new platform error that lands in
// 'unknown' still gets Try again / Reschedule / Fix / Reject rather than a dead end.
//
// Server-side on purpose: the Review Queue, the Data Hub's Content Library and the failure
// notification should never disagree about why a post died.

import { isMetaAppBlocked } from './meta-app-block';

/** The raw jsonb a publisher writes. Older/foreign rows may hold a bare string instead. */
export type StoredFailureReason =
    | string
    | {
          httpStatus?: number | null;
          errorCode?: number | null;
          errorSubcode?: number | null;
          errorMessage?: string | null;
          isRetryable?: boolean | null;
      }
    | null
    | undefined;

/**
 * What class of problem this was — and therefore which way out the UI should offer.
 *
 *   connection  the account link is broken/expired. Retrying changes nothing until it is reconnected.
 *   account     the platform has restricted or suspended the account. Nothing here can fix it.
 *   media       the picture or video was the problem (missing, wrong format, too big, rejected).
 *   content     the words were the problem (policy, length, a banned link).
 *   rate_limit  the platform is throttling. The same post will work later.
 *   platform    the platform broke (5xx, timeout). Not our post's fault.
 *   unknown     nothing matched. Show the platform's own words and offer everything.
 */
export type FailureKind = 'connection' | 'account' | 'media' | 'content' | 'rate_limit' | 'platform' | 'unknown';

export interface FailureDiagnosis {
    kind: FailureKind;
    /** One line, no jargon: what happened. */
    title: string;
    /** What to do about it, in the second person. */
    remedy: string;
    /** The platform's own message, kept verbatim so support can read it. Null when we never got one. */
    raw: string | null;
    /** Would trying the identical post again plausibly work? Drives whether "Try again now" leads. */
    retryable: boolean;
    /** True when the fix is outside this product (reconnect, or sort it out on the platform). */
    needsReconnect: boolean;
}

/** Meta/Graph auth codes. 190 = token invalid; 102 = session; 10/200/203 = permission lost. */
const AUTH_CODES = new Set([10, 102, 190, 200, 203]);
/** Meta throttle codes — see META_THROTTLE_CODES in publish-instagram.ts. */
const THROTTLE_CODES = new Set([4, 17, 32, 613]);

function has(haystack: string, ...needles: string[]): boolean {
    return needles.some(n => haystack.includes(n));
}

/**
 * Normalise whatever is in the column into the object shape, so callers never branch on it.
 * A bare string is treated as the platform's message with no status — that is exactly what the
 * pre-jsonb rows hold.
 */
function normalise(reason: StoredFailureReason): {
    httpStatus: number | null;
    errorCode: number | null;
    errorSubcode: number | null;
    message: string;
    isRetryable: boolean | null;
} {
    if (typeof reason === 'string') {
        return { httpStatus: null, errorCode: null, errorSubcode: null, message: reason, isRetryable: null };
    }
    const r = reason ?? {};
    return {
        httpStatus:  typeof r.httpStatus  === 'number' ? r.httpStatus  : null,
        errorCode:   typeof r.errorCode   === 'number' ? r.errorCode   : null,
        errorSubcode:typeof r.errorSubcode=== 'number' ? r.errorSubcode: null,
        message:     typeof r.errorMessage === 'string' ? r.errorMessage : '',
        isRetryable: typeof r.isRetryable === 'boolean' ? r.isRetryable : null,
    };
}

/**
 * Classify a failure and say what to do about it.
 *
 * `platformLabel` is the display name ("Instagram", "X") — it goes into the copy, because "Reconnect
 * your account" is useless on a workspace with five connections.
 */
export function diagnosePostFailure(reason: StoredFailureReason, platformLabel = 'the platform'): FailureDiagnosis {
    const { httpStatus, errorCode, errorSubcode, message, isRetryable } = normalise(reason);
    const m = message.toLowerCase();
    const raw = message.trim() || null;
    const P = platformLabel;

    // Nothing was recorded. This happens on rows that predate failure_reason and on the video-upload
    // timeout path, which writes a message but no status. Say so plainly rather than inventing a cause.
    if (!raw && httpStatus == null && errorCode == null) {
        return {
            kind: 'unknown',
            title: `${P} didn’t accept this post, and no reason was recorded.`,
            remedy: 'Try publishing it again. If it fails a second time, reject it and let your assistant draft a fresh one.',
            raw: null,
            retryable: true,
            needsReconnect: false,
        };
    }

    // ── The platform has blocked the whole app ──────────────────────────────────────────────────
    // Ahead of the connection branch, which would otherwise claim this: Meta sends "API access
    // blocked." under code 200, and 200 is in AUTH_CODES. That made every post in a platform-wide
    // outage tell its owner to reconnect — advice that cannot work (the OAuth dialog is refused
    // before consent) and that is actively risky, since a reconnect rebinds whichever Page Meta
    // returns first. See src/utils/meta-app-block.ts.
    if (isMetaAppBlocked(message)) {
        return {
            kind: 'platform',
            title: `${P} has temporarily blocked publishing for Be More Swan — this isn’t a problem with your account.`,
            remedy: `Your post is being held and will go out automatically once ${P} restores access. There is nothing to fix at your end, and reconnecting won’t help.`,
            raw,
            retryable: true,
            needsReconnect: false,
        };
    }

    // ── Connection ──────────────────────────────────────────────────────────────────────────────
    // Checked FIRST and ahead of the http status, because a broken link is the one failure where
    // "Try again now" is actively misleading: it will fail again, instantly, every time.
    if (
        httpStatus === 401 ||
        (errorCode != null && AUTH_CODES.has(errorCode)) ||
        has(m, 'access token', 'token expired', 'token_expired', 'session has expired', 'reconnect',
               'invalid_grant', 'oauthexception', 'not authorized', 'unauthorized', 'unauthorised',
               'no connection', 'revoked')
    ) {
        return {
            kind: 'connection',
            title: `Your ${P} connection has expired or been disconnected.`,
            remedy: `Reconnect ${P}, then publish this post again. Trying again before you reconnect will fail the same way.`,
            raw,
            retryable: false,
            needsReconnect: true,
        };
    }

    // ── Account restricted ──────────────────────────────────────────────────────────────────────
    // Before the generic 403, which would otherwise swallow it. Nothing in this product can fix a
    // suspension, so the honest remedy points at the platform.
    if (errorCode === 368 || has(m, 'suspended', 'restricted', 'account has been disabled', 'policy violation on your account')) {
        return {
            kind: 'account',
            title: `${P} has restricted your account, so it wouldn’t accept this post.`,
            remedy: `Resolve the restriction in ${P} itself. Once the account is active again, publish this post from here.`,
            raw,
            retryable: false,
            needsReconnect: false,
        };
    }

    // A 403 that isn't a suspension is a missing permission/scope on an otherwise live connection —
    // reconnecting is what re-grants it.
    if (httpStatus === 403) {
        return {
            kind: 'connection',
            title: `${P} refused the post — the connected account doesn’t have permission to publish it.`,
            remedy: `Reconnect ${P} and approve every permission it asks for, then publish this post again.`,
            raw,
            retryable: false,
            needsReconnect: true,
        };
    }

    // ── Media ───────────────────────────────────────────────────────────────────────────────────
    // The message from publish-social-posts' unresolvable-media path is matched explicitly ("could
    // not be loaded"): the picture is gone from storage, so the post has to be re-media'd, not retried.
    if (has(m, 'could not be loaded', 'media upload', 'media_upload', 'aspect ratio', 'resolution',
                'file size', 'too large', 'unsupported format', 'not supported by', 'image format',
                'video format', 'duration', 'codec', 'thumbnail', 'carousel')
        || errorSubcode === 352
        || has(m, 'format')) {
        const gone = has(m, 'could not be loaded');
        return {
            kind: 'media',
            title: gone
                ? 'The image or video attached to this post could not be loaded, so nothing was published.'
                : `${P} wouldn’t accept the image or video on this post.`,
            remedy: gone
                ? 'Open the post, attach the media again, then publish it.'
                : `Open the post and swap the media for something ${P} accepts, then publish it. Retrying with the same file will fail again.`,
            raw,
            retryable: false,
            needsReconnect: false,
        };
    }

    // ── Content ─────────────────────────────────────────────────────────────────────────────────
    if (has(m, 'content policy', 'community guidelines', 'spam', 'duplicate', 'too long',
                'character limit', 'blocked link', 'blacklisted', 'prohibited')
        || errorSubcode === 2207026) {
        return {
            kind: 'content',
            title: `${P} rejected the wording of this post.`,
            remedy: 'Open the post, edit the caption or remove the link that upset it, then publish it again.',
            raw,
            retryable: false,
            needsReconnect: false,
        };
    }

    // ── Rate limit ──────────────────────────────────────────────────────────────────────────────
    if (httpStatus === 429 || (errorCode != null && THROTTLE_CODES.has(errorCode)) || has(m, 'rate limit', 'too many requests')) {
        return {
            kind: 'rate_limit',
            title: `${P} is temporarily limiting how much you can post.`,
            remedy: 'Reschedule this post for a few hours’ time — the same post will go out fine once the limit resets.',
            raw,
            retryable: true,
            needsReconnect: false,
        };
    }

    // ── Platform-side ───────────────────────────────────────────────────────────────────────────
    if ((httpStatus != null && httpStatus >= 500) || has(m, 'timed out', 'timeout', 'temporarily unavailable', 'try again later')) {
        return {
            kind: 'platform',
            title: `${P} had a problem at its end and never took the post.`,
            remedy: 'Nothing is wrong with your post — publish it again now, or reschedule it for later.',
            raw,
            retryable: true,
            needsReconnect: false,
        };
    }

    // ── Anything else ───────────────────────────────────────────────────────────────────────────
    // A 400 usually means the post itself is malformed, so lead with editing; otherwise fall back on
    // whatever the publisher decided about retryability.
    const badRequest = httpStatus === 400;
    return {
        kind: 'unknown',
        title: `${P} didn’t accept this post.`,
        remedy: badRequest
            ? 'Open the post and check the caption and media, then publish it again. If it fails the same way, reject it and let your assistant draft a fresh one.'
            : 'Publish it again, or reschedule it for later. If it fails the same way, reject it and let your assistant draft a fresh one.',
        raw,
        retryable: isRetryable ?? !badRequest,
        needsReconnect: false,
    };
}
