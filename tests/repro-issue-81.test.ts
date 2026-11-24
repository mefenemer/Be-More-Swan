// tests/repro-issue-81.test.ts
// Fix pipeline #81 (prod, workspace 40, Business Information ▸ What people search, 2026-11-21): "I asked for them
// to suggest for me and chose United States, but it keeps pulling up terms specific to the United Kingdom."
// The Region picker sits beside "Suggest terms for me", but the click sent only { action: 'suggest' };
// suggestTrendTerms saved every suggestion under the time-zone default, and countryFromTimezone maps the owner's
// Europe/Athens to nothing, so 'GB'. The model was never told the country either, so the words leaned British.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as terms from '../src/utils/search-trend-terms';

const root = join(__dirname, '..');

// The chosen region wins over the time-zone default; junk falls back.
const pick = (terms as any).pickRegionIso;
assert.strictEqual(typeof pick, 'function', 'there is a rule for which region a suggestion is saved in');
assert.strictEqual(pick('US', 'GB'), 'US', 'United States chosen → United States');
assert.strictEqual(pick('us', 'GB'), 'US');
assert.strictEqual(pick(undefined, 'GB'), 'GB', 'nothing chosen → the default');
assert.strictEqual(pick('XX', 'AU'), 'AU', 'an unknown region → the default');

// The model is told which country's words to use.
const prompt = terms.suggestUserPrompt({ industry: 'Health coaching', description: 'Nurse coach', products: [], keywords: [], existing: [], country: 'United States' } as any);
assert.ok(prompt.includes('The customers are in United States'), 'the prompt names the country');

// The button sends the picker's value, and the endpoint passes it on.
const view = readFileSync(join(root, 'src/components/search-trends-view.js'), 'utf8');
assert.ok(/action: 'suggest', region: rf && rf\.region \? rf\.region\.value/.test(view), 'Suggest sends the chosen region');
const fn = readFileSync(join(root, 'netlify/functions/search-trends.ts'), 'utf8');
assert.ok(fn.includes('})).text, body.region);'), 'the endpoint passes the region to suggestTrendTerms');
const util = readFileSync(join(root, 'src/utils/search-trend-terms.ts'), 'utf8');
assert.ok(util.includes('countryLocation(pickRegionIso(region, await defaultRegionIso(db, userId)))'), 'suggestions are saved in the chosen region');

console.log('repro-issue-81: Suggest terms uses the chosen country ✓');
