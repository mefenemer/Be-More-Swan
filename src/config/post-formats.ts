// src/config/post-formats.ts
// The catalogue of POST FORMATS per platform — the shape of the thing being published, as distinct
// from src/config/platform-formats.ts, which describes a platform's *default* feed post.
//
// Why this exists separately: "Instagram" is not one format. A feed post, a Reel, a Story and a
// carousel have different aspect ratios, different media kinds, different item counts and different
// API calls. The editor cannot lay itself out correctly — or validate anything — from the platform
// alone.
//
// ── availability is the load-bearing field ──────────────────────────────────────────────────────
// Offering a format the publisher cannot send produces a post that is approved, scheduled, and then
// fails — the exact defect that made approve-post reject Instagram videos the publisher could
// happily have sent. So every format declares what we can actually do with it TODAY:
//
//   'live'            a publisher sends this now. Safe to schedule.
//   'planned'         a real schedulable format we have not built the publish path for. Shown in the
//                     UI so the roadmap is visible, but never schedulable — see formatSchedulable().
//   'not_schedulable' not a scheduled post at all: real-time broadcast (Live, Spaces, Audio Events),
//                     direct messaging (Broadcast Channels), or another product's surface entirely
//                     (LinkedIn Articles/Newsletters — that is the Blog Writer's job). These can
//                     never become a scheduled_posts row, however much publishing work we do.
//
// Keep in step with the live publishers: publish-instagram.ts, publish-facebook.ts,
// publish-social-posts.ts (LinkedIn/X/Threads/YouTube), publish-youtube-background.ts.

import type { SocialPlatform } from './platform-formats';

export type FormatAvailability = 'live' | 'planned' | 'not_schedulable';

/** What the format carries. 'mixed' = images and video in one swipeable set. */
export type FormatMedia = 'none' | 'image' | 'video' | 'mixed' | 'audio' | 'document';

export interface PostFormatSpec {
    key: string;
    platform: SocialPlatform;
    label: string;
    /** One line for the picker — what the format IS, not what we support. */
    blurb: string;
    media: FormatMedia;
    /** Cannot publish without media of the declared kind. */
    mediaMandatory: boolean;
    /** Attachment count bounds. maxItems > 1 means a carousel/grid. */
    minItems: number;
    maxItems: number;
    /** Ratios the format accepts, first being the native/preferred one. Empty = no constraint. */
    aspectRatios: string[];
    /** Caption/body character cap. */
    charLimit: number;
    /** Disappears on its own (Stories) — worth saying, since scheduling one is a different promise. */
    ephemeral?: boolean;
    availability: FormatAvailability;
    /** Required unless availability is 'live'. Shown to the user, so write it for them. */
    unavailableReason?: string;
}

export const POST_FORMATS: PostFormatSpec[] = [
    // ── Instagram ───────────────────────────────────────────────────────────────────────────────
    { key: 'ig_feed', platform: 'instagram', label: 'Feed post', blurb: 'A single image in the main feed.',
      media: 'image', mediaMandatory: true, minItems: 1, maxItems: 1, aspectRatios: ['4:5', '1:1'], charLimit: 2200,
      availability: 'live' },
    { key: 'ig_reel', platform: 'instagram', label: 'Reel', blurb: 'Full-screen vertical video, pushed by the algorithm.',
      media: 'video', mediaMandatory: true, minItems: 1, maxItems: 1, aspectRatios: ['9:16'], charLimit: 2200,
      availability: 'live' },
    { key: 'ig_carousel', platform: 'instagram', label: 'Carousel', blurb: 'Up to 20 swipeable slides, images and video mixed.',
      media: 'mixed', mediaMandatory: true, minItems: 2, maxItems: 20, aspectRatios: ['4:5', '1:1'], charLimit: 2200,
      availability: 'planned', unavailableReason: 'Carousels need multi-image publishing, which we haven’t built yet — every publisher currently sends a single attachment.' },
    { key: 'ig_story', platform: 'instagram', label: 'Story', blurb: 'Vertical, disappears after 24 hours.',
      media: 'mixed', mediaMandatory: true, minItems: 1, maxItems: 1, aspectRatios: ['9:16'], charLimit: 0, ephemeral: true,
      availability: 'planned', unavailableReason: 'Stories publish through a different Instagram endpoint we haven’t connected yet.' },
    { key: 'ig_broadcast', platform: 'instagram', label: 'Broadcast channel', blurb: 'One-to-many message straight into follower DMs.',
      media: 'none', mediaMandatory: false, minItems: 0, maxItems: 1, aspectRatios: [], charLimit: 2200,
      availability: 'not_schedulable', unavailableReason: 'Broadcast channels are direct messaging, not feed posts — they can’t be scheduled as a post.' },
    { key: 'ig_live', platform: 'instagram', label: 'Live', blurb: 'Real-time video broadcast.',
      media: 'none', mediaMandatory: false, minItems: 0, maxItems: 0, aspectRatios: ['9:16'], charLimit: 0,
      availability: 'not_schedulable', unavailableReason: 'Going live happens in the moment — there is nothing to draft or schedule here.' },

    // ── Facebook ────────────────────────────────────────────────────────────────────────────────
    { key: 'fb_feed', platform: 'facebook', label: 'Feed post', blurb: 'Text, a link, an image or a video.',
      media: 'image', mediaMandatory: false, minItems: 0, maxItems: 1, aspectRatios: ['1:1', '4:5', '16:9'], charLimit: 63206,
      availability: 'live' },
    { key: 'fb_reel', platform: 'facebook', label: 'Reel', blurb: 'Vertical short-form video, often shared from Instagram.',
      media: 'video', mediaMandatory: true, minItems: 1, maxItems: 1, aspectRatios: ['9:16'], charLimit: 63206,
      availability: 'planned', unavailableReason: 'Facebook Reels use a separate video endpoint from feed posts, which we haven’t connected yet.' },
    { key: 'fb_story', platform: 'facebook', label: 'Story', blurb: 'Vertical, disappears after 24 hours.',
      media: 'mixed', mediaMandatory: true, minItems: 1, maxItems: 1, aspectRatios: ['9:16'], charLimit: 0, ephemeral: true,
      availability: 'planned', unavailableReason: 'Stories publish through a different Facebook endpoint we haven’t connected yet.' },
    { key: 'fb_group', platform: 'facebook', label: 'Group post', blurb: 'Posted into a community group feed.',
      media: 'image', mediaMandatory: false, minItems: 0, maxItems: 1, aspectRatios: ['1:1', '16:9'], charLimit: 63206,
      availability: 'planned', unavailableReason: 'Posting to a group needs group selection and its own permissions, which the Facebook connection doesn’t request yet.' },
    { key: 'fb_live', platform: 'facebook', label: 'Live', blurb: 'Real-time video broadcast.',
      media: 'none', mediaMandatory: false, minItems: 0, maxItems: 0, aspectRatios: [], charLimit: 0,
      availability: 'not_schedulable', unavailableReason: 'Going live happens in the moment — there is nothing to draft or schedule here.' },

    // ── Threads ─────────────────────────────────────────────────────────────────────────────────
    { key: 'th_text', platform: 'threads', label: 'Text post', blurb: 'Short conversational update.',
      media: 'image', mediaMandatory: false, minItems: 0, maxItems: 1, aspectRatios: ['1:1', '4:5'], charLimit: 500,
      availability: 'live' },
    { key: 'th_carousel', platform: 'threads', label: 'Carousel', blurb: 'Up to 20 swipeable items, images and video mixed.',
      media: 'mixed', mediaMandatory: true, minItems: 2, maxItems: 20, aspectRatios: ['1:1', '4:5'], charLimit: 500,
      availability: 'planned', unavailableReason: 'Carousels need multi-image publishing, which we haven’t built yet.' },
    { key: 'th_voice', platform: 'threads', label: 'Voice note', blurb: 'A playable audio recording in the feed.',
      media: 'audio', mediaMandatory: true, minItems: 1, maxItems: 1, aspectRatios: [], charLimit: 500,
      availability: 'planned', unavailableReason: 'We have no audio recording or upload path yet — the content library only handles images and video.' },
    { key: 'th_poll', platform: 'threads', label: 'Poll', blurb: 'Interactive vote with up to four options.',
      media: 'none', mediaMandatory: false, minItems: 0, maxItems: 0, aspectRatios: [], charLimit: 500,
      availability: 'planned', unavailableReason: 'Polls need their own options editor and a different API call — not built yet.' },

    // ── LinkedIn ────────────────────────────────────────────────────────────────────────────────
    { key: 'li_feed', platform: 'linkedin', label: 'Feed post', blurb: 'Text, an image, or an outbound link.',
      media: 'image', mediaMandatory: false, minItems: 0, maxItems: 1, aspectRatios: ['1:1', '4:5', '16:9'], charLimit: 3000,
      availability: 'live' },
    { key: 'li_video', platform: 'linkedin', label: 'Native video', blurb: 'Video uploaded straight to the feed.',
      media: 'video', mediaMandatory: true, minItems: 1, maxItems: 1, aspectRatios: ['16:9', '9:16', '1:1'], charLimit: 3000,
      availability: 'live' },
    { key: 'li_document', platform: 'linkedin', label: 'Document carousel', blurb: 'A PDF that reads as swipeable slides — LinkedIn’s strongest format.',
      media: 'document', mediaMandatory: true, minItems: 1, maxItems: 1, aspectRatios: [], charLimit: 3000,
      availability: 'planned', unavailableReason: 'Needs PDF upload and LinkedIn’s document endpoint; the content library doesn’t accept documents yet.' },
    { key: 'li_article', platform: 'linkedin', label: 'Article / newsletter', blurb: 'Long-form writing with subscribers.',
      media: 'none', mediaMandatory: false, minItems: 0, maxItems: 1, aspectRatios: [], charLimit: 110000,
      availability: 'not_schedulable', unavailableReason: 'Long-form belongs to the Blog Writer, not the social post editor — draft it there and publish to LinkedIn from its destinations.' },
    { key: 'li_audio', platform: 'linkedin', label: 'Audio event / Live', blurb: 'Drop-in audio room or live stream.',
      media: 'none', mediaMandatory: false, minItems: 0, maxItems: 0, aspectRatios: [], charLimit: 0,
      availability: 'not_schedulable', unavailableReason: 'A live event is not a post — it can’t be drafted and queued like one.' },

    // ── X ───────────────────────────────────────────────────────────────────────────────────────
    { key: 'x_text', platform: 'x', label: 'Post', blurb: 'Short-form text, and the start of a thread.',
      media: 'image', mediaMandatory: false, minItems: 0, maxItems: 1, aspectRatios: ['16:9', '1:1'], charLimit: 280,
      availability: 'live' },
    { key: 'x_video', platform: 'x', label: 'Native video', blurb: 'Video uploaded straight into the feed.',
      media: 'video', mediaMandatory: true, minItems: 1, maxItems: 1, aspectRatios: ['16:9', '9:16', '1:1'], charLimit: 280,
      availability: 'live' },
    { key: 'x_images', platform: 'x', label: 'Image grid', blurb: 'Up to four images in one cropped grid.',
      media: 'image', mediaMandatory: true, minItems: 2, maxItems: 4, aspectRatios: ['16:9', '1:1'], charLimit: 280,
      availability: 'planned', unavailableReason: 'The grid needs multi-image publishing, which we haven’t built yet.' },
    { key: 'x_poll', platform: 'x', label: 'Poll', blurb: 'Interactive vote with up to four options.',
      media: 'none', mediaMandatory: false, minItems: 0, maxItems: 0, aspectRatios: [], charLimit: 280,
      availability: 'planned', unavailableReason: 'Polls need their own options editor and a different API call — not built yet.' },
    { key: 'x_space', platform: 'x', label: 'Space', blurb: 'Live drop-in audio broadcast.',
      media: 'none', mediaMandatory: false, minItems: 0, maxItems: 0, aspectRatios: [], charLimit: 0,
      availability: 'not_schedulable', unavailableReason: 'A Space is a live event, not a post — there is nothing to draft or queue.' },

    // ── YouTube ─────────────────────────────────────────────────────────────────────────────────
    { key: 'yt_vod', platform: 'youtube', label: 'Video', blurb: 'Standard horizontal video, found through search.',
      media: 'video', mediaMandatory: true, minItems: 1, maxItems: 1, aspectRatios: ['16:9'], charLimit: 5000,
      availability: 'live' },
    { key: 'yt_short', platform: 'youtube', label: 'Short', blurb: 'Vertical short-form video, under 60 seconds.',
      media: 'video', mediaMandatory: true, minItems: 1, maxItems: 1, aspectRatios: ['9:16'], charLimit: 5000,
      availability: 'live' },
    { key: 'yt_community', platform: 'youtube', label: 'Community post', blurb: 'Text, image or poll for subscribers between uploads.',
      media: 'image', mediaMandatory: false, minItems: 0, maxItems: 1, aspectRatios: ['1:1', '16:9'], charLimit: 5000,
      availability: 'planned', unavailableReason: 'The Community tab is a separate YouTube API surface we haven’t connected yet.' },
    { key: 'yt_live', platform: 'youtube', label: 'Live', blurb: 'Real-time stream.',
      media: 'none', mediaMandatory: false, minItems: 0, maxItems: 0, aspectRatios: [], charLimit: 0,
      availability: 'not_schedulable', unavailableReason: 'Streaming happens in the moment — there is nothing to draft or schedule here.' },
];

const BY_KEY: Record<string, PostFormatSpec> = Object.fromEntries(POST_FORMATS.map(f => [f.key, f]));

export function postFormatSpec(key: string | null | undefined): PostFormatSpec | null {
    return (key && BY_KEY[key]) || null;
}

export function formatsForPlatform(platform: string): PostFormatSpec[] {
    const key = platform === 'twitter' ? 'x' : platform;
    return POST_FORMATS.filter(f => f.platform === key);
}

/** The format a platform gets when nothing has been chosen — always its 'live' feed post. */
export function defaultFormatFor(platform: string): PostFormatSpec | null {
    const list = formatsForPlatform(platform);
    return list.find(f => f.availability === 'live') ?? list[0] ?? null;
}

/**
 * May a post in this format be approved and queued?
 *
 * The ONLY gate that matters — the picker deliberately shows unavailable formats so the user can
 * see what the platform offers and what is coming, but nothing unschedulable may ever reach the
 * publish queue. Server and client both call this; do not re-implement the rule anywhere.
 */
export function formatSchedulable(key: string | null | undefined): boolean {
    // No format recorded = a legacy post, which predates this catalogue and publishes as it always
    // has. Refusing those would strand every existing draft.
    if (!key) return true;
    const spec = BY_KEY[key];
    return !spec || spec.availability === 'live';
}

/** Why a format can't be scheduled, for the message shown to the user. Null when it can. */
export function formatBlockedReason(key: string | null | undefined): string | null {
    if (formatSchedulable(key)) return null;
    return BY_KEY[key!]?.unavailableReason ?? 'This format can’t be scheduled yet.';
}
