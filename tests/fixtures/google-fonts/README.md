# Google Fonts fixtures

What `src/lib/brand-card-webfont.ts` receives from Google Fonts for the default brand kit's family,
**Plus Jakarta Sans**, captured 2026-11-17 with its legacy User-Agent (so the faces are `.woff`):

- `plus-jakarta-sans.css` — `https://fonts.googleapis.com/css2?family=Plus%20Jakarta%20Sans:wght@400;700&display=swap`
- `*.woff` — the two Latin faces that stylesheet points at (400 and 700), named as on `fonts.gstatic.com`

`tests/brand-card.test.ts` serves these instead of the network, so the web-font path is still exercised
but the test no longer depends on Google being reachable or fast.

Plus Jakarta Sans © The Plus Jakarta Sans Project Authors, licensed under the SIL Open Font License 1.1
(https://openfontlicense.org), which permits redistribution with software.
