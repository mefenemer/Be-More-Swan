/**
 * src/components/platform-post-preview.js
 *
 * US-SMM-2.1.1: Platform-specific post preview component.
 *
 * Usage:
 *   window.PlatformPostPreview.render(container, { post, assets, platforms })
 *
 *   post     — scheduledPosts row (caption, platform, postFormat, mediaUrl, etc.)
 *   assets   — array of attached workspaceAssets
 *   platforms — optional array of platforms for cross-post tab view
 *               (defaults to [post.platform])
 *
 * The container receives:
 *   - Platform tab bar (if multiple platforms)
 *   - Read-only visual preview styled per platform
 *   - Character-limit warning banner + Approve button gate
 *   - Media aspect-ratio warning if asset dimensions mismatch
 */
(function () {
  'use strict';

  // ── Character limits per platform ────────────────────────────────────────
  const CHAR_LIMITS = {
    twitter:   280,
    x:         280,
    instagram: 2200,
    linkedin:  3000,
    facebook:  63206,
    threads:   500,
    tiktok:    2200,  // direct-post caption limit
    youtube:   5000,  // description limit (titles are capped separately at 100)
  };

  // ── Aspect ratio rules per platform / format ────────────────────────────
  // [widthRatio, heightRatio, label]
  const ASPECT_RULES = {
    instagram_feed:    [1, 1,    '1:1 (square feed)'],
    instagram_story:   [9, 16,   '9:16 (story)'],
    instagram_reel:    [9, 16,   '9:16 (reel)'],
    twitter:           [16, 9,   '16:9'],
    x:                 [16, 9,   '16:9'],
    linkedin:          [1.91, 1, '1.91:1'],
    facebook:          [1.91, 1, '1.91:1'],
    threads:           [1, 1,    '1:1 (square)'],
    tiktok:            [9, 16,   '9:16 (vertical video)'],
    youtube_shorts:    [9, 16,   '9:16 (Short)'],
    youtube:           [16, 9,   '16:9 (long-form)'],
  };

  // ── Fake profile fixtures (visual only) ─────────────────────────────────
  const PROFILE = {
    name:     'Your Brand',
    handle:   '@yourbrand',
    avatar:   null, // null → initials fallback
    followers: '1,204 followers',
  };

  // ── Helpers ──────────────────────────────────────────────────────────────

  function _escHtml(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function _avatarHtml(size = 40) {
    return `<div style="width:${size}px;height:${size}px;border-radius:50%;background:#6366f1;color:#fff;
      display:flex;align-items:center;justify-content:center;font-size:${Math.round(size*0.38)}px;font-weight:700;flex-shrink:0;">
      YB</div>`;
  }

  /** Highlight hashtags and @mentions blue, truncate to maxLen with ellipsis. */
  function _formatCaption(text, maxLen, platform) {
    if (!text) return '<span class="text-gray-400 italic">No caption</span>';
    let display = text;
    let truncated = false;
    if (maxLen && display.length > maxLen) {
      display = display.slice(0, maxLen);
      truncated = true;
    }
    const escaped = _escHtml(display)
      .replace(/(#\w+)/g, '<span style="color:#1d9bf0">$1</span>')
      .replace(/(@\w+)/g, '<span style="color:#1d9bf0">$1</span>');
    return escaped + (truncated ? '<span style="color:#ef4444"> …[truncated]</span>' : '');
  }

  /** Return chars-over-limit count, or 0 if within limit. */
  function _overLimit(caption, platform) {
    const limit = CHAR_LIMITS[platform?.toLowerCase()] ?? null;
    if (!limit) return 0;
    return Math.max(0, (caption || '').length - limit);
  }

  /** Detect aspect ratio mismatch for a given platform + format. */
  function _aspectWarning(assets, platform, postFormat) {
    if (!assets?.length) return null;
    const key = `${platform?.toLowerCase()}_${(postFormat || '').toLowerCase().replace(/[^a-z]/g,'_')}`;
    const fallbackKey = platform?.toLowerCase();
    const rule = ASPECT_RULES[key] || ASPECT_RULES[fallbackKey];
    if (!rule) return null;
    const [rw, rh, label] = rule;
    const asset = assets[0];
    if (asset?.width && asset?.height) {
      // Compare RATIOS, tolerating a few percent. Only a genuine mismatch is worth interrupting for.
      const ratio = asset.width / asset.height;
      const expected = rw / rh;
      if (Math.abs(ratio - expected) / expected > 0.05) {
        return { level: 'warn', text: `Asset is ${asset.width}×${asset.height} (${_ratioLabel(ratio)}) but this slot wants ${label}. It may be cropped.` };
      }
      return null; // verified good — say nothing
    }
    // No stored dimensions. Historically this was the ONLY branch ever reached, because
    // content_assets had no width/height columns at all — so every post with media showed the same
    // warning forever, whether or not anything was wrong. Now it means what it says: we genuinely
    // don't know this asset's shape (a legacy row, or a file we couldn't measure). Downgraded to an
    // informational note so it reads as context, not as a defect.
    return { level: 'info', text: `This slot is designed for ${label}. We couldn't read this asset's dimensions to check it.` };
  }

  /**
   * The nearest ratio a platform actually publishes, and whether it is near ENOUGH to claim.
   *
   * Split out from _ratioLabel because two callers need different halves of the same answer: the
   * label wants a string either way, while mediaAdvice needs to know whether anything matched at
   * all. Sniffing that back out of the string ("does it end in :1?") would misread 1:1 and 1.91:1,
   * which are legitimate matches of exactly that shape.
   */
  function _nearestRatio(ratio) {
    const known = [[1, 1], [4, 5], [9, 16], [16, 9], [1.91, 1]];
    let best = null, bestErr = Infinity;
    for (const [w, h] of known) {
      const err = Math.abs(ratio - w / h);
      if (err < bestErr) { bestErr = err; best = `${w}:${h}`; }
    }
    return { label: best, matched: bestErr / ratio < 0.06 };
  }

  /** Human-readable ratio for a measured asset, e.g. 1.78 → "16:9". */
  function _ratioLabel(ratio) {
    const near = _nearestRatio(ratio);
    return near.matched ? near.label : `${ratio.toFixed(2)}:1`;
  }

  // ── Media placeholder ────────────────────────────────────────────────────

  function _mediaHtml(assets, aspectClass, warning) {
    if (!assets?.length) return '';
    const asset = assets[0];
    const src = asset.storageUrl || asset.previewUrl || null;
    // `warning` is { level:'warn'|'info', text } — an actual ratio mismatch is red and warns; an
    // unmeasurable asset is neutral grey and merely informs. They used to look identical, which is
    // how a purely informational note ended up reading as a defect on every post.
    const warnBanner = warning
      ? `<div style="position:absolute;bottom:0;left:0;right:0;background:${
           warning.level === 'warn' ? 'rgba(239,68,68,0.85)' : 'rgba(55,65,81,0.82)'
         };color:#fff;font-size:11px;padding:4px 8px;">${
           warning.level === 'warn' ? '⚠' : 'ⓘ'} ${_escHtml(warning.text)}</div>`
      : '';
    if (src) {
      // A video asset MUST render as <video>. This used to emit <img> for everything, so every
      // video post previewed as a blank black box — the preview silently stopped being a preview
      // for exactly the posts whose framing matters most.
      const isVideo = (asset.assetType || '').toLowerCase() === 'video'
        || /^video\//i.test(asset.mimeType || '');
      const media = isVideo
        ? `<video src="${_escHtml(src)}" muted playsinline controls preload="metadata"
             style="width:100%;height:100%;object-fit:cover;background:#000;"></video>`
        : `<img src="${_escHtml(src)}" alt="post media" style="width:100%;height:100%;object-fit:cover;">`;
      return `<div style="position:relative;width:100%;${aspectClass}overflow:hidden;background:#000;border-radius:4px;">
        ${media}
        ${warnBanner}
      </div>`;
    }
    return `<div style="position:relative;width:100%;${aspectClass}background:#e5e7eb;border-radius:4px;
      display:flex;align-items:center;justify-content:center;color:#9ca3af;font-size:13px;">
      🖼 Media placeholder
      ${warnBanner}
    </div>`;
  }

  // ── Platform renderers ───────────────────────────────────────────────────

  function _renderInstagram(post, assets) {
    const isStory = (post.postFormat || '').toLowerCase().includes('story') ||
                    (post.postFormat || '').toLowerCase().includes('reel');
    const aspectClass = isStory
      ? 'aspect-ratio:9/16;padding-bottom:177.78%;'
      : 'aspect-ratio:1/1;padding-bottom:100%;';
    const mediaWarning = _aspectWarning(assets, 'instagram', post.postFormat);
    const over = _overLimit(post.caption, 'instagram');

    return `
      <div style="max-width:400px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
           border:1px solid #dbdbdb;border-radius:8px;background:#fff;overflow:hidden;">
        <!-- Header -->
        <div style="display:flex;align-items:center;gap:10px;padding:10px 12px;">
          ${_avatarHtml(32)}
          <div>
            <div style="font-size:13px;font-weight:600;">${_escHtml(PROFILE.name)}</div>
            <div style="font-size:11px;color:#8e8e8e;">Sponsored</div>
          </div>
          <div style="margin-left:auto;font-size:18px;color:#262626;">•••</div>
        </div>
        <!-- Media -->
        ${_mediaHtml(assets, isStory ? 'padding-bottom:177.78%;' : 'padding-bottom:100%;', mediaWarning)}
        <!-- Actions -->
        <div style="padding:8px 12px;display:flex;gap:14px;font-size:22px;">
          <span>🤍</span><span>💬</span><span>↗</span>
          <span style="margin-left:auto;">🔖</span>
        </div>
        <!-- Caption -->
        <div style="padding:0 12px 12px;font-size:13px;line-height:1.5;">
          <span style="font-weight:600;">${_escHtml(PROFILE.name)}</span>
          <span style="margin-left:6px;">${_formatCaption(post.caption, over > 0 ? CHAR_LIMITS.instagram : null, 'instagram')}</span>
          ${over > 0 ? `<div style="margin-top:6px;color:#ef4444;font-size:12px;">⚠ ${over} characters over Instagram limit (2,200)</div>` : ''}
        </div>
      </div>`;
  }

  function _renderLinkedIn(post, assets) {
    const over = _overLimit(post.caption, 'linkedin');
    const mediaWarning = _aspectWarning(assets, 'linkedin', post.postFormat);
    const captionRaw = post.caption || '';
    const showMore = captionRaw.length > 220;
    const displayCaption = showMore ? captionRaw.slice(0, 220) : captionRaw;

    return `
      <div style="max-width:420px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
           border:1px solid #e0e0e0;border-radius:8px;background:#fff;overflow:hidden;">
        <div style="padding:12px;">
          <div style="display:flex;align-items:flex-start;gap:10px;">
            ${_avatarHtml(40)}
            <div>
              <div style="font-size:14px;font-weight:600;">${_escHtml(PROFILE.name)}</div>
              <div style="font-size:12px;color:#666;">${_escHtml(PROFILE.followers)}</div>
              <div style="font-size:11px;color:#999;">Just now • 🌐</div>
            </div>
          </div>
          <div style="margin-top:10px;font-size:14px;line-height:1.5;color:#191919;">
            ${_formatCaption(displayCaption, null, 'linkedin')}
            ${showMore ? '<span style="color:#0077b5;cursor:pointer;"> …see more</span>' : ''}
            ${over > 0 ? `<div style="margin-top:6px;color:#ef4444;font-size:12px;">⚠ ${over} chars over LinkedIn limit (3,000)</div>` : ''}
          </div>
        </div>
        ${_mediaHtml(assets, 'padding-bottom:52.3%;', mediaWarning)}
        <div style="padding:6px 12px;border-top:1px solid #e0e0e0;display:flex;gap:16px;font-size:13px;color:#666;">
          <span>👍 Like</span><span>💬 Comment</span><span>🔁 Repost</span><span>✈️ Send</span>
        </div>
      </div>`;
  }

  function _renderTwitter(post, assets) {
    const limit = CHAR_LIMITS.twitter;
    const len = (post.caption || '').length;
    const over = Math.max(0, len - limit);
    const pct = Math.min(100, Math.round((len / limit) * 100));
    const circleColor = over > 0 ? '#ef4444' : pct >= 80 ? '#f59e0b' : '#1d9bf0';
    const mediaWarning = _aspectWarning(assets, 'twitter', post.postFormat);

    return `
      <div style="max-width:420px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
           border:1px solid #e7e7e7;border-radius:16px;background:#fff;padding:12px;">
        <div style="display:flex;gap:10px;">
          ${_avatarHtml(40)}
          <div style="flex:1;">
            <div style="display:flex;align-items:baseline;gap:6px;">
              <span style="font-size:14px;font-weight:700;">${_escHtml(PROFILE.name)}</span>
              <span style="font-size:13px;color:#536471;">${_escHtml(PROFILE.handle)}</span>
            </div>
            <div style="margin-top:6px;font-size:14px;line-height:1.5;">
              ${_formatCaption(post.caption, over > 0 ? limit : null, 'twitter')}
            </div>
            ${_mediaHtml(assets, 'padding-bottom:56.25%;margin-top:8px;', mediaWarning)}
            <!-- Character counter -->
            <div style="display:flex;align-items:center;gap:8px;margin-top:10px;font-size:13px;color:${over > 0 ? '#ef4444' : '#536471'};">
              <svg width="20" height="20" viewBox="0 0 20 20">
                <circle cx="10" cy="10" r="8" fill="none" stroke="#e7e7e7" stroke-width="2"/>
                <circle cx="10" cy="10" r="8" fill="none" stroke="${circleColor}" stroke-width="2"
                  stroke-dasharray="${2*Math.PI*8}" stroke-dashoffset="${2*Math.PI*8*(1-pct/100)}"
                  transform="rotate(-90 10 10)"/>
              </svg>
              <span>${over > 0 ? `-${over}` : `${limit - len} remaining`}</span>
            </div>
          </div>
        </div>
        <div style="display:flex;gap:20px;margin-top:10px;color:#536471;font-size:13px;padding-left:50px;">
          <span>💬</span><span>🔁</span><span>🤍</span><span>📊</span><span>↗</span>
        </div>
      </div>`;
  }

  function _renderFacebook(post, assets) {
    const over = _overLimit(post.caption, 'facebook');
    const mediaWarning = _aspectWarning(assets, 'facebook', post.postFormat);

    return `
      <div style="max-width:420px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
           border:1px solid #dadde1;border-radius:8px;background:#fff;overflow:hidden;">
        <div style="padding:12px;display:flex;align-items:center;gap:10px;">
          ${_avatarHtml(40)}
          <div>
            <div style="font-size:14px;font-weight:600;">${_escHtml(PROFILE.name)}</div>
            <div style="font-size:12px;color:#65676b;">Just now · 🌐</div>
          </div>
          <div style="margin-left:auto;font-size:20px;color:#65676b;">•••</div>
        </div>
        <div style="padding:0 12px 10px;font-size:14px;color:#1c1e21;line-height:1.5;">
          ${_formatCaption(post.caption, null, 'facebook')}
          ${over > 0 ? `<div style="margin-top:6px;color:#ef4444;font-size:12px;">⚠ ${over} chars over limit</div>` : ''}
        </div>
        ${_mediaHtml(assets, 'padding-bottom:52.3%;', mediaWarning)}
        <div style="padding:4px 12px;border-top:1px solid #dadde1;display:flex;justify-content:space-around;font-size:13px;color:#65676b;">
          <span>👍 Like</span><span>💬 Comment</span><span>↗ Share</span>
        </div>
      </div>`;
  }

  // ── Main renderer ────────────────────────────────────────────────────────

  function _renderForPlatform(platform, post, assets) {
    const p = (platform || '').toLowerCase();
    if (p === 'instagram') return _renderInstagram(post, assets);
    if (p === 'linkedin')  return _renderLinkedIn(post, assets);
    if (p === 'twitter' || p === 'x') return _renderTwitter(post, assets);
    if (p === 'facebook')  return _renderFacebook(post, assets);
    // Fallback: plain text preview
    return `<div style="padding:12px;border:1px solid #e5e7eb;border-radius:8px;background:#f9fafb;font-size:13px;">
      <strong>${_escHtml(platform)}</strong><br>${_formatCaption(post.caption, null, p)}
    </div>`;
  }

  /**
   * Render the full preview widget into `container`.
   *
   * @param {HTMLElement} container
   * @param {{ post: object, assets?: object[], platforms?: string[] }} opts
   * @returns {{ approveBlocked: boolean }} — true if Approve button should be disabled
   */
  function render(container, { post, assets = [], platforms }) {
    if (!container || !post) return { approveBlocked: false };

    const platformList = platforms?.length
      ? platforms
      : [post.platform].filter(Boolean);

    let activePlatform = platformList[0] || 'unknown';

    function _buildHtml() {
      const issues = platformList.map(p => {
        const over = _overLimit(post.caption, p);
        const aspectWarn = _aspectWarning(assets, p, post.postFormat);
        // Only a real mismatch flags the platform tab. An info-level note ("couldn't measure this
        // asset") is not an issue and must not put a red dot on every tab of every post.
        return { platform: p, over, aspectWarn, hasIssue: over > 0 || aspectWarn?.level === 'warn' };
      });

      const anyBlocked = issues.some(i => i.over > 0);

      // Tab bar (only if multiple platforms)
      const tabBar = platformList.length > 1 ? `
        <div style="display:flex;gap:0;margin-bottom:12px;border-bottom:2px solid #e5e7eb;">
          ${platformList.map(p => {
            const issue = issues.find(i => i.platform === p);
            const isActive = p === activePlatform;
            return `<button data-ppv-tab="${_escHtml(p)}"
              style="padding:6px 14px;font-size:13px;font-weight:${isActive?'700':'400'};
              border:none;background:none;cursor:pointer;
              border-bottom:${isActive?'2px solid #6366f1':'2px solid transparent'};
              color:${isActive?'#6366f1':'#374151'};position:relative;top:2px;">
              ${_escHtml(p.charAt(0).toUpperCase()+p.slice(1))}
              ${issue?.hasIssue ? '<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#ef4444;margin-left:4px;vertical-align:middle;"></span>' : ''}
            </button>`;
          }).join('')}
        </div>` : '';

      const previewHtml = _renderForPlatform(activePlatform, post, assets);

      const blockedBanner = anyBlocked ? `
        <div style="margin-top:10px;padding:8px 12px;background:#fef2f2;border:1px solid #fca5a5;
             border-radius:6px;font-size:12px;color:#b91c1c;">
          ⛔ One or more platforms exceed their character limit. Edit the caption before approving.
        </div>` : '';

      return { tabBarHtml: tabBar, previewHtml, blockedBanner, anyBlocked };
    }

    function _mount() {
      const { tabBarHtml, previewHtml, blockedBanner, anyBlocked } = _buildHtml();
      container.innerHTML = `
        <div id="ppv-root" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
          <div style="font-size:12px;font-weight:600;color:#6b7280;text-transform:uppercase;
               letter-spacing:.05em;margin-bottom:8px;">Platform Preview</div>
          ${tabBarHtml}
          <div id="ppv-preview">${previewHtml}</div>
          ${blockedBanner}
        </div>`;

      // Wire tab clicks
      container.querySelectorAll('[data-ppv-tab]').forEach(btn => {
        btn.addEventListener('click', () => {
          activePlatform = btn.dataset.ppvTab;
          _mount();
        });
      });

      // Expose blocked state on the container for parent to gate Approve button
      container.dataset.ppvBlocked = anyBlocked ? '1' : '0';
    }

    _mount();

    return {
      get approveBlocked() { return container.dataset.ppvBlocked === '1'; },
    };
  }

  // ── Is there anything WRONG with this media? ────────────────────────────
  // The post editor's media panel used to print Type / Resolution / Aspect for every asset, always.
  // That is diagnostic data with no decision attached: "1.63:1" only means something if you already
  // know the five ratios platforms publish, and a healthy 1080×1350 photo got the same three rows as
  // a broken one. So the panel now asks this instead, and says nothing when the answer is nothing.
  //
  // Deliberately narrow — only the two things the composer does not already tell you elsewhere:
  //
  //   • TOO SMALL. Nothing else mentions it. Platforms render feed images at about 1080px wide and
  //     upscale anything narrower, so it publishes soft — invisibly, until it is live.
  //   • A SHAPE NO PLATFORM PUBLISHES. The per-platform tab already states the OUTCOME
  //     ("auto-cropped"); this states the CAUSE once, which is the part a raw ratio was hiding.
  //     Phrased as "will be cropped somewhere", never as a per-platform verdict — the tabs own that,
  //     and Facebook/LinkedIn/X are far more permissive than Instagram.

  /** The width platforms render a feed image at. Narrower than this is upscaled, and looks soft. */
  const RECOMMENDED_MIN_WIDTH = 1080;

  /**
   * What is worth saying about this asset, or null when it is fine.
   * @returns {{ level: 'warn'|'info', lines: string[] } | null}
   */
  function _mediaAdvice(metrics) {
    if (!metrics || !metrics.w || !metrics.h) return null;
    const { w, h, kind } = metrics;
    const lines = [];

    if (w < RECOMMENDED_MIN_WIDTH) {
      lines.push(`${w} × ${h} is below the ${RECOMMENDED_MIN_WIDTH}px width platforms render at, so it may publish soft.`);
    }
    // A ratio nothing matched is a ratio no format declares. Videos are left alone: their framing is
    // the format router's call, and it weighs duration too.
    const near = _nearestRatio(w / h);
    if (kind !== 'Video' && !near.matched) {
      lines.push(`${(w / h).toFixed(2)}:1 isn’t a shape any platform publishes, so it will be cropped — the platform tabs say where.`);
    }
    return lines.length ? { level: 'warn', lines } : null;
  }

  // ratioLabel is exported so the post editor's media panel can name an aspect ratio the same way
  // this component's mismatch warning does. Exported rather than copied: two implementations would
  // eventually disagree, and then the inspector would call a clip 9:16 while the preview warned it
  // was not — the same drift the overlay-geometry test exists to prevent. mediaAdvice is exported for
  // the same reason: the judgement of "is this asset a problem" belongs with the ratio rules it uses.
  window.PlatformPostPreview = { render, ratioLabel: _ratioLabel, mediaAdvice: _mediaAdvice, RECOMMENDED_MIN_WIDTH };
})();
