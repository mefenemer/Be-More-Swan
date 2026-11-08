# Website import — platform by platform

One report per platform the Website Assistant's "Import my current site" should handle. Each platform
has its own adapter (`src/utils/site-builders/<key>.ts`), test (`tests/site-platform-<key>.test.ts`),
fixtures (`tests/fixtures/site-platforms/<key>/`) and report (`docs/site-import-platforms/<key>.md`),
so platforms are worked on separately without touching each other's files.

How an import works, for context: `src/utils/site-import.ts` `runImport` reads the home page and its menu
pages through `site-fetch.ts` (robots.txt + SSRF fence), turns each into ordered blocks with
`site-extract.ts` `readImportPage` (headings, text, list items, quotes, buttons, pictures, inline links),
opens a page in headless Chrome when the plain read finds under 40 words (`site-js-render.ts`), reads
Wix "Embed HTML" boxes (`site-embeds.ts`), asks a model to place block numbers into sections (never
rewrite words), and reads the look (`site-import-theme.ts`).

## Report template (copy into `<key>.md`)

```
# <Platform>

## How sites on <Platform> are built
(server-rendered or JavaScript-drawn; where the words, menu, pictures and styles live; tell-tale markup)

## Already covered
(what the import gets right today, tested against fixtures)

## Fixed in this pass
(what the adapter now does, with the test that proves it)

## Can be done (not done yet)
(each with effort: S / M / L, and the files it would touch outside this platform's own — those need
the main session, because other platform sessions share them)

## Can't be done
(and why: platform blocks crawlers, content behind login, licensing, our no-third-party / no-script rules…)

## Suggested improvements to our import
(changes to the shared import that would help this platform and others)

## Detection
(the signals `detect` uses, and false positives / negatives found)
```
