// src/config/platform-formats.ts
// Single source of truth for per-platform post constraints used by the autonomous drafters
// (aspect ratio for AI image generation, caption char-limit, default media format, whether an
// image is mandatory). Consolidates values that were previously scattered:
//   • ASPECT='4:5' hardcoded in autonomous-media-suggestions.ts
//   • X_MAX=280 in publish-social-posts.ts
//   • _GPW_CHAR_LIMITS in workspace.html (composer)
//
// Keep this list in step with AUTONOMOUS_DRAFT_PLATFORMS (src/utils/publish-policy.ts) and the
// live publishers (publish-instagram.ts, publish-facebook.ts, publish-social-posts.ts).

import type { AspectRatio } from '../lib/fal-gateway';

export type SocialPlatform = 'instagram' | 'facebook' | 'linkedin' | 'x' | 'threads' | 'youtube';

export interface PlatformFormat {
    /** Aspect ratio requested when generating/sourcing an image for this platform's feed. */
    aspectRatio: AspectRatio;
    /** Max caption+hashtag characters. Mirrors _GPW_CHAR_LIMITS in the composer. */
    charLimit: number;
    /** Default scheduled_posts.post_format when media is attached. */
    defaultPostFormat: 'image' | 'text' | 'video';
    /** True when the platform cannot publish without media (Instagram: image; YouTube: video). */
    mediaMandatory: boolean;
    /**
     * The KIND of media this platform publishes. mediaMandatory alone is ambiguous — Instagram
     * requires an image and YouTube requires a video, and attaching the wrong one is a publish
     * failure, so the composer and the publisher both branch on this rather than assuming image.
     */
    mediaKind: 'image' | 'video';
    /** Human label for notifications / UI. */
    label: string;
}

export const PLATFORM_FORMATS: Record<SocialPlatform, PlatformFormat> = {
    instagram: { aspectRatio: '4:5',  charLimit: 2200,  defaultPostFormat: 'image', mediaMandatory: true,  mediaKind: 'image', label: 'Instagram' },
    facebook:  { aspectRatio: '1:1',  charLimit: 63206, defaultPostFormat: 'image', mediaMandatory: false, mediaKind: 'image', label: 'Facebook' },
    linkedin:  { aspectRatio: '1:1',  charLimit: 3000,  defaultPostFormat: 'image', mediaMandatory: false, mediaKind: 'image', label: 'LinkedIn' },
    x:         { aspectRatio: '16:9', charLimit: 280,   defaultPostFormat: 'image', mediaMandatory: false, mediaKind: 'image', label: 'X (Twitter)' },
    // Threads is text-first: an image is optional and the feed is conversational, so the drafter
    // should not assume media. 500 chars is the hard API limit (THREADS_TEXT_MAX in social-publish).
    threads:   { aspectRatio: '1:1',  charLimit: 500,   defaultPostFormat: 'text',  mediaMandatory: false, mediaKind: 'image', label: 'Threads' },
    // YouTube is video-only — there is no text-only post, so a draft without a video asset can
    // never publish. charLimit is the DESCRIPTION limit (5000); the title is derived from the
    // caption's first line and capped separately at YOUTUBE_TITLE_MAX. Deliberately absent from
    // AUTONOMOUS_DRAFT_PLATFORMS: every drafter produces stills, so autonomous YouTube drafts
    // would be unpublishable by construction.
    youtube:   { aspectRatio: '16:9', charLimit: 5000,  defaultPostFormat: 'video', mediaMandatory: true,  mediaKind: 'video', label: 'YouTube' },
};

/** Format for a platform, tolerating unknown/legacy keys (e.g. 'twitter' → 'x'). Falls back to Instagram. */
export function platformFormat(platform: string): PlatformFormat {
    const key = (platform === 'twitter' ? 'x' : platform) as SocialPlatform;
    return PLATFORM_FORMATS[key] ?? PLATFORM_FORMATS.instagram;
}

/**
 * Normalise a raw platform token from onboarding context (primary_platforms can hold short codes
 * 'fb'/'ig'/'li'/'x' or full names 'facebook'/'instagram'/…) to a canonical service name, or null
 * if it isn't one of the four social platforms we draft/publish for. Mirrors _platformCodes() in
 * assistants.js so server and UI agree on which platform a value refers to.
 */
export function normalizePlatform(raw: unknown): SocialPlatform | null {
    const p = String(raw ?? '').toLowerCase().trim();
    if (!p) return null;
    if (p === 'ig' || p.includes('instagram')) return 'instagram';
    if (p === 'fb' || p.includes('facebook')) return 'facebook';
    if (p === 'li' || p.includes('linkedin')) return 'linkedin';
    // Must precede the 'x' branch: its /(^|\W)x(\W|$)/ fallback is loose enough that any future
    // token containing a standalone "x" would be claimed by X before reaching a later check.
    if (p === 'th' || p.includes('threads')) return 'threads';
    if (p === 'yt' || p.includes('youtube')) return 'youtube';
    if (p === 'x' || p === 'twitter' || p.includes('twitter') || /(^|\W)x(\W|$)/.test(p)) return 'x';
    return null;
}
