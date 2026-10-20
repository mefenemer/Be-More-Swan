/**
 * src/components/social-profile-url.js — one place that knows what each platform's profile
 * address looks like.
 *
 * Business Information shows each social field as a fixed prefix ("instagram.com/") plus a box for
 * the handle, so the customer types `yourbrand` instead of a whole URL they have to get right. The
 * value SAVED is the full profile URL (organisations.social_handles), built here from the two parts.
 *
 * ⚠️ Stored values predate this and are a mix: "@yourbrand", "yourbrand", "facebook.com/page",
 * "https://www.linkedin.com/in/jane/". split() reads every one of those back into a handle, and a
 * pasted full URL is split the same way on blur — so nobody has to re-enter anything.
 *
 * integrations.js reads the same value to prefill the Connect form, which asks for a USERNAME on
 * some platforms and a URL on others — handleForConnect() gives it the shape it asks for.
 */
(function () {
  'use strict';
  if (window.SocialProfileUrl) return;

  // base: what the customer sees in front of the box (and what the saved URL starts with).
  // hosts: every address the platform answers on, so a pasted link from any of them is understood.
  // paths (LinkedIn only): the section in front of the name — a company page and a person's profile
  // live under different paths, and guessing wrong gives a 404.
  const PLATFORMS = {
    instagram: { base: 'https://www.instagram.com/',  hosts: ['instagram.com', 'instagr.am'], connect: 'username' },
    facebook:  { base: 'https://www.facebook.com/',   hosts: ['facebook.com', 'fb.com'],       connect: 'url' },
    linkedin:  { base: 'https://www.linkedin.com/',   hosts: ['linkedin.com'],                 connect: 'url',
                 paths: ['company/', 'in/', 'showcase/', 'school/'], defaultPath: 'company/' },
    x:         { base: 'https://x.com/',              hosts: ['x.com', 'twitter.com'],         connect: 'username' },
    tiktok:    { base: 'https://www.tiktok.com/@',    hosts: ['tiktok.com'],                   connect: 'username' },
    youtube:   { base: 'https://www.youtube.com/@',   hosts: ['youtube.com'],                  connect: 'url' },
    pinterest: { base: 'https://www.pinterest.com/',  hosts: ['pinterest.com', 'pinterest.co.uk', 'pin.it'], connect: 'url' },
    threads:   { base: 'https://www.threads.com/@',   hosts: ['threads.com', 'threads.net'],   connect: 'username' },
  };

  // YouTube channels that predate @handles still live at /channel/<id>, /c/<name> or /user/<name>.
  // Those are kept whole: forcing them under "/@" makes a link that does not exist.
  const YT_LEGACY = /^(channel|c|user)\//i;

  /** The prefix as shown to the customer: no scheme, no www. */
  function displayPrefix(platform, path) {
    const p = PLATFORMS[platform];
    if (!p) return '';
    return p.base.replace(/^https?:\/\//, '').replace(/^www\./, '') + (path || '');
  }

  /**
   * Read anything a customer might have typed or pasted into { path, handle, explicitPath }.
   * `path` is only ever set for LinkedIn; `explicitPath` says the text itself named it (a pasted
   * "linkedin.com/in/jane"), as opposed to falling back to the default.
   */
  function split(platform, raw) {
    const p = PLATFORMS[platform];
    let s = String(raw == null ? '' : raw).trim();
    if (!p || !s) return { path: p && p.defaultPath || '', handle: '', explicitPath: false };

    // Strip a scheme and any subdomain in front of a host this platform owns.
    const noScheme = s.replace(/^https?:\/\//i, '');
    const lower = noScheme.toLowerCase();
    for (const host of p.hosts) {
      const m = lower.match(new RegExp('^(?:[a-z0-9-]+\\.)*' + host.replace(/\./g, '\\.') + '(?=/|$)'));
      if (m) { s = noScheme.slice(m[0].length).replace(/^\/+/, ''); break; }
    }
    // Facebook pages without a username live at profile.php?id=<number> — the query IS the handle.
    const fbProfile = platform === 'facebook' && s.match(/^profile\.php\?id=\d+/i);
    s = fbProfile ? fbProfile[0] : s.replace(/[?#].*$/, '').replace(/\/+$/, '').trim();

    let path = '';
    let explicitPath = false;
    if (p.paths) {
      const hit = p.paths.find((x) => s.toLowerCase().startsWith(x));
      path = hit || p.defaultPath;
      explicitPath = !!hit;
      if (hit) s = s.slice(hit.length);
    }
    if (!(platform === 'youtube' && YT_LEGACY.test(s))) s = s.replace(/^@+/, '');
    return { path, handle: s, explicitPath };
  }

  /** The full profile URL to save, or '' when there is no handle. */
  function compose(platform, path, handle) {
    const p = PLATFORMS[platform];
    const h = String(handle || '').trim().replace(/^@+/, '');
    if (!p || !h) return '';
    if (platform === 'youtube' && YT_LEGACY.test(handle)) return 'https://www.youtube.com/' + String(handle).trim();
    return p.base + (p.paths ? (path || p.defaultPath) : '') + h;
  }

  /** Normalise any stored value to the canonical URL (idempotent). */
  function normalise(platform, raw) {
    const parts = split(platform, raw);
    return compose(platform, parts.path, parts.handle);
  }

  /**
   * The stored value in the shape the Connect form asks for: "@name" where it asks for a
   * username, the full URL where it asks for a link.
   */
  function handleForConnect(platform, raw) {
    const key = String(platform || '').toLowerCase();
    const p = PLATFORMS[key];
    if (!p || !String(raw || '').trim()) return String(raw || '').trim();
    if (p.connect === 'url') return normalise(key, raw);
    const { handle } = split(key, raw);
    return handle ? '@' + handle : '';
  }

  window.SocialProfileUrl = { PLATFORMS, displayPrefix, split, compose, normalise, handleForConnect };
})();
