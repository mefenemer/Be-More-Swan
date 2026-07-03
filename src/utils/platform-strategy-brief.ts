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

  return blocks.length ? blocks.join('\n') : null;
}
