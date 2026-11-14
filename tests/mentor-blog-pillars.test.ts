// tests/mentor-blog-pillars.test.ts — FR#21 (owner 2026-11-14): the Mentor's Monday review lists last week's blog
// articles, each matched to one of the Social Media Assistant's content pillars.

import assert from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

(async () => {
    console.log('mentor-blog-pillars');
    const path = join(root, 'src/utils/mentor-blog-pillars.ts');
    await check('the module exists', () => assert.ok(existsSync(path)));
    const m: any = existsSync(path) ? await import('../src/utils/mentor-blog-pillars') : {};

    await check('last week is the previous Monday–Sunday in UK time', () => {
        assert.deepStrictEqual(m.lastUkWeek(new Date('2026-11-16T07:00:00Z')), { from: '2026-11-09', to: '2026-11-15' });   // a Monday morning
        assert.deepStrictEqual(m.lastUkWeek(new Date('2026-11-15T23:30:00Z')), { from: '2026-11-02', to: '2026-11-08' });   // still Sunday in the UK
    });

    const pillars = [
        { name: 'Garden tips', description: 'Practical planting and pruning advice' },
        { name: 'Behind the scenes', description: 'Our nursery team and how we grow plants' },
        { name: 'Offers', description: null },
    ];
    const articles = [
        { id: 1, title: 'Pruning roses in November', publishedOn: '2026-11-10' },
        { id: 2, title: 'Meet the team growing our plants', publishedOn: '2026-11-12' },
        { id: 3, title: 'A poem about rain', publishedOn: '2026-11-13' },
    ];

    await check('each article gets its closest pillar by shared words, or none', () => {
        const r = m.matchArticlesToPillars(articles, pillars);
        assert.deepStrictEqual(r.map((x: any) => x.pillar), ['Garden tips', 'Behind the scenes', null]);
    });

    await check('the review text lists every title with its pillar', () => {
        const t = m.blogPillarText({ from: '2026-11-09', to: '2026-11-15', articles, pillars, matches: m.matchArticlesToPillars(articles, pillars) });
        assert.ok(t.startsWith('Published last week (9 Nov–15 Nov):'), t);
        assert.ok(t.includes('• “Pruning roses in November” (10 Nov) → Garden tips'));
        assert.ok(t.includes('• “A poem about rain” (13 Nov) → no clear pillar'));
        const none = m.blogPillarText({ from: '2026-11-09', to: '2026-11-15', articles: [articles[0]], pillars: null, matches: [{ article: articles[0], pillar: null }] });
        assert.ok(none.includes('no Social Media Assistant pillars to match') && none.includes('Hire a Social Media Assistant'));
    });

    await check('the model block lists every article and the pillars, and forbids invented pillars', () => {
        const b = m.renderBlogPillarsForMentor({ from: '2026-11-09', to: '2026-11-15', articles, pillars, matches: m.matchArticlesToPillars(articles, pillars) }).join('\n');
        for (const a of articles) assert.ok(b.includes(`"${a.title}"`));
        assert.ok(b.includes('"Garden tips" — Practical planting') && /never invent a pillar/.test(b) && b.includes('Last week’s articles'));
        assert.ok(m.renderBlogPillarsForMentor(null)[0].includes('could not be read'));
    });

    await check('wired into the weekly review: inputs, the model prompt, its JSON shape and the thin-week review', () => {
        const r = read('src/utils/mentor-review.ts');
        assert.ok(r.includes('loadBlogPillarWeek(db, orgId, data.team, now)'));
        assert.ok(r.includes("renderBlogPillarsForMentor(inputs.blogPillars ?? null).join('\\n')"));
        assert.ok(r.includes('{"title": "Last week’s articles", "text": '));
        assert.ok(r.includes("{ title: 'Last week’s articles', text: blogPillarText(i.blogPillars ?? null)! }"));
    });

    await check('a thin week still shows the list (code-written, no model call)', async () => {
        const { notEnoughDataReview } = await import('../src/utils/mentor-review');
        const w = { from: '2026-11-09', to: '2026-11-15', articles, pillars, matches: m.matchArticlesToPillars(articles, pillars) };
        const out = notEnoughDataReview({ data: { goals: [], team: [] } as any, figures: [], commitments: [], customers: null, content: null, blogPillars: w } as any, new Date('2026-11-16T07:00:00Z'));
        const s = out.sections.find((x: any) => x.title === 'Last week’s articles');
        assert.ok(s && s.text.includes('Pruning roses in November'), JSON.stringify(out.sections));
    });

    console.log(`\n${passed} passed`);
})();
