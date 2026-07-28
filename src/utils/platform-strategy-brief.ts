// Single source of truth for turning the structured per-platform hashtag/algorithm strategy
// (captured at onboarding and editable in the Assistant Profile → context.platform_strategy)
// into human-readable brief directives. Previously a handful of these choices were compiled
// ad-hoc into the "strict rules" list at onboarding time (and most toggles — IG format, trending
// audio, LI carousels, X length/media — were silently dropped). Rendering the whole object here,
// consumed by compileServerSideBrief, keeps the structured object authoritative and complete.

export interface PlatformStrategy {
  fb?: { tags?: string; strategy?: string; groups?: boolean };
  ig?: { tags?: string; format?: string; audio?: boolean };
  li?: { tags?: string; links_first_comment?: boolean; sliders?: boolean };
  x?: { tags?: string; length?: string; media?: boolean };
  threads?: { conversational?: boolean };
  tiktok?: { tags?: string; hooks?: boolean };
  youtube?: { format?: string; seo?: boolean; repurpose?: boolean; hooks?: boolean; contentType?: string; cadence?: string };
}

// Map the platform names used on jobs/connections (full names) to the strategy object's keys, so a
// per-platform generation job can inject just the relevant directives.
export const PLATFORM_NAME_TO_STRATEGY_KEY: Record<string, keyof PlatformStrategy> = {
  facebook: 'fb', instagram: 'ig', linkedin: 'li', x: 'x', twitter: 'x',
  threads: 'threads', tiktok: 'tiktok', youtube: 'youtube',
};

// Narrow a platform strategy to only the given platforms (by full name, e.g. 'youtube'). Returns
// null when none apply, so a caller can skip the directive entirely.
export function platformStrategyFor(
  ps: PlatformStrategy | null | undefined,
  platforms: string[],
): PlatformStrategy | null {
  if (!ps || typeof ps !== 'object') return null;
  const out: PlatformStrategy = {};
  for (const p of platforms) {
    const key = PLATFORM_NAME_TO_STRATEGY_KEY[(p || '').toLowerCase()];
    if (key && ps[key]) (out as Record<string, unknown>)[key] = ps[key];
  }
  return Object.keys(out).length ? out : null;
}

// Only Facebook exposes a hashtag "strategy" selector; for the other platforms a provided tag
// list is treated as required. `sanitize` guards the user-supplied tag string against injection.
function hashtagDirective(
  strategy: string | undefined,
  tags: string,
  sanitize: (s: string) => string,
): string | null {
  const t = (tags || '').trim();
  switch (strategy) {
    case 'strict_custom':
      return t ? `Use ONLY these hashtags: ${sanitize(t)}.` : null;
    case 'hybrid':
      return t
        ? `Use these hashtags and add other relevant ones: ${sanitize(t)}.`
        : 'Add relevant hashtags as appropriate.';
    case 'ai_decide':
      return 'Choose the most effective hashtags automatically.';
    default:
      return t ? `Use these hashtags: ${sanitize(t)}.` : null;
  }
}

/**
 * Render the platform strategy object as a brief section. Returns null when nothing meaningful is
 * configured, so callers can fall back to their "not specified" placeholder.
 */
export function formatPlatformStrategyBrief(
  ps: PlatformStrategy | null | undefined,
  sanitize: (s: string) => string = (v) => v,
): string | null {
  if (!ps || typeof ps !== 'object') return null;
  const blocks: string[] = [];
  const block = (heading: string, lines: Array<string | null>) => {
    const clean = lines.filter((l): l is string => !!l);
    if (clean.length) blocks.push(`${heading}:\n${clean.map((l) => `- ${l}`).join('\n')}`);
  };

  if (ps.fb) {
    block('Facebook', [
      hashtagDirective(ps.fb.strategy, ps.fb.tags || '', sanitize),
      ps.fb.groups ? 'Also draft a version optimised for niche Facebook Groups.' : null,
    ]);
  }
  if (ps.ig) {
    block('Instagram', [
      hashtagDirective(undefined, ps.ig.tags || '', sanitize),
      ps.ig.format === 'reels'
        ? 'Prioritise Reels over other formats.'
        : ps.ig.format === 'mix'
          ? 'Mix Reels, carousels and static posts.'
          : null,
      ps.ig.audio ? 'Suggest trending audio concepts to pair with posts.' : null,
    ]);
  }
  if (ps.li) {
    block('LinkedIn', [
      hashtagDirective(undefined, ps.li.tags || '', sanitize),
      ps.li.links_first_comment
        ? 'Place any external URLs in the first comment, not the post body (anti-penalty).'
        : null,
      ps.li.sliders ? 'Produce PDF slider/carousel outlines where suitable.' : null,
    ]);
  }
  if (ps.x) {
    block('X (Twitter)', [
      hashtagDirective(undefined, ps.x.tags || '', sanitize),
      ps.x.length === 'threads'
        ? 'Prioritise threads over single posts.'
        : ps.x.length === 'single'
          ? 'Use single posts only, not threads.'
          : ps.x.length === 'mix'
            ? 'Mix threads and single posts.'
            : null,
      ps.x.media ? 'Include placeholders for media in each post.' : null,
    ]);
  }
  if (ps.threads) {
    block('Threads', [
      ps.threads.conversational
        ? 'Write in a conversational, discussion-starting tone and do NOT use hashtags.'
        : null,
    ]);
  }
  if (ps.tiktok) {
    block('TikTok', [
      hashtagDirective(undefined, ps.tiktok.tags || '', sanitize),
      ps.tiktok.hooks ? 'Auto-generate a scroll-stopping viral text hook for the opening seconds of each video.' : null,
    ]);
  }
  if (ps.youtube) {
    const ytContentLabels: Record<string, string> = {
      tutorial: 'tutorial / how-to',
      demo: 'product demo',
      talking_head: 'talking-head / thought-leadership',
      vlog: 'vlog / behind-the-scenes',
      listicle: 'listicle / tips',
    };
    const contentType = (ps.youtube.contentType || '').trim();
    const cadence = (ps.youtube.cadence || '').trim();
    block('YouTube', [
      ps.youtube.format === 'shorts'
        ? 'Prioritise Shorts over long-form videos.'
        : ps.youtube.format === 'longform'
          ? 'Prioritise long-form videos for the main channel.'
          : ps.youtube.format === 'mix'
            ? 'Mix Shorts and long-form videos.'
            : null,
      ps.youtube.repurpose ? 'Cut short-form clips (Shorts) from every long-form video to maximise reach.' : null,
      ps.youtube.hooks ? 'Open every Short with a scroll-stopping hook in the first 1–2 seconds.' : null,
      contentType && ytContentLabels[contentType] ? `Focus on ${ytContentLabels[contentType]} style videos.` : null,
      cadence ? `Target this publishing cadence: ${sanitize(cadence)}.` : null,
      ps.youtube.seo ? 'Optimise every video description for YouTube SEO (keywords, chapters, links).' : null,
    ]);
  }

  return blocks.length ? blocks.join('\n') : null;
}
