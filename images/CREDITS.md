# Image credits and provenance

Provenance for the stock photography in `images/`.

**This file, not `THIRD-PARTY-NOTICES`.** That file is generated wholesale from npm dependency
licenses by `scripts/generate-notices.js` and overwritten on every run, so anything hand-written
there is lost the next time someone regenerates it.

## Self-hosted homepage images

Added 2026-08-05. These five were previously hot-linked directly from the Pexels and Unsplash
CDNs in `index.html`. They were brought in-repo because a hot-linked hero makes Largest
Contentful Paint depend on a third party we have no agreement with, and because the CDN URLs
requested the wrong sizes — the three step images render at 80&nbsp;px (`w-20`) and were being
fetched at 300&nbsp;px wide.

Each is stored twice: `.webp` for browsers that accept it (via `<picture><source>`) and `.jpg`
as the fallback. Both are the same pixel dimensions.

| File | Rendered at | Stored | Source |
|---|---|---|---|
| `home-hero-relaxing.{webp,jpg}` | ~600&nbsp;px wide | 1200×800 | [Pexels 3755021](https://www.pexels.com/photo/3755021/) |
| `home-case-study-prints.{webp,jpg}` | ~568×450 | 1140×760 | [Pexels 4050291](https://www.pexels.com/photo/4050291/) |
| `home-step-1-select.{webp,jpg}` | 80×80 | 160×160 | [Unsplash `photo-1499750310107-5fef28a66643`](https://unsplash.com/photos/1499750310107-5fef28a66643) |
| `home-step-2-connect.{webp,jpg}` | 80×80 | 160×160 | [Unsplash `photo-1552664730-d307ca884978`](https://unsplash.com/photos/1552664730-d307ca884978) |
| `home-step-3-track.{webp,jpg}` | 80×80 | 160×160 | [Unsplash `photo-1522202176988-66273c2fd55f`](https://unsplash.com/photos/1522202176988-66273c2fd55f) |

Stored at 2× the rendered size so they stay sharp on high-DPI displays.

### Licensing

Both the [Pexels License](https://www.pexels.com/license/) and the
[Unsplash License](https://unsplash.com/license) permit free commercial use, modification, and
self-hosting, with no attribution required. This file is a provenance record, not a legal
obligation.

Two limits in both licenses are worth knowing, because these images are used in marketing:

- **No implied endorsement by identifiable people.** Neither service guarantees a model release.
  These images sit alongside product copy but are not presented as customers, staff, or
  testimonials, and they should not be relabelled as any of those. The real customer photos on
  the homepage (`CatFenemer.jpeg`, `DJ_Limi.png`, `Angela.jpeg`) are a separate matter and are
  not stock.
- **Do not redistribute as stock.** Selling or giving these away as standalone photography, or
  compiling them into a competing service, is out of bounds. Using them on our own pages is not.

### Refreshing or replacing one

The originals were retrieved with the CDNs' own resize/format parameters — no local image
processing, which is why the repo has no `sharp` dependency. To re-fetch:

```bash
curl -sfS "https://images.pexels.com/photos/3755021/pexels-photo-3755021.jpeg?auto=compress&cs=tinysrgb&w=1200&fm=webp" -o images/home-hero-relaxing.webp
```

Drop `&fm=webp` for the JPEG. Unsplash uses `?fit=crop&w=160&h=160&q=80` with the same `&fm=webp`
switch. If you change a file's pixel dimensions, update the `width`/`height` attributes on the
matching `<img>` in `index.html` — they are what stop the page shifting as images load.
