# Google Fonts fixtures

Saved Google Fonts responses for **Plus Jakarta Sans**, captured 2026-11-17 with
`src/lib/brand-card-webfont.ts`'s legacy User-Agent (so the faces are `.woff`):

- `plus-jakarta-sans.css` — what `https://fonts.googleapis.com/css2?family=Plus%20Jakarta%20Sans:wght@400;700&display=swap` returned
- `*.woff` — the two Latin faces that stylesheet points at (400 and 700), named as on `fonts.gstatic.com`

`tests/brand-card.test.ts` serves them for a made-up site font, **"Fixture Sans"**, to exercise the
web-font download path offline. (Plus Jakarta Sans itself is the bundled family and is never
downloaded.) The test then no longer depends on Google being reachable or fast.

Plus Jakarta Sans © The Plus Jakarta Sans Project Authors, licensed under the SIL Open Font License 1.1
(https://openfontlicense.org), which permits redistribution with software.
