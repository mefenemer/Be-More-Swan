/**
 * scripts/seo/reviews.mjs — Job 9's markup: published reviews of Be More Swan on the home and pricing
 * pages, plus the Review / AggregateRating JSON-LD that describes them. Pure; tested in
 * tests/seo-reviews.test.ts. Data from get-reviews.ts (admin-published, author-consented).
 *
 * The rules, each one a reason not to "improve" this later:
 *   • Nothing at all until MIN_TO_SHOW reviews are published. Two quotes read as a gap, not proof.
 *   • Newest first, never sorted by stars — choosing only the glowing ones is misleading
 *     presentation under the DMCC Act 2024.
 *   • The average and count shown are the SAME numbers as the JSON-LD, and include hidden reviews.
 *     Google requires marked-up ratings to be visible on the page.
 *   • Every quote carries its incentive note ("Received free access during beta").
 *   • The JSON-LD hangs off the existing SoftwareApplication node (#software), not Organization —
 *     Google ignores self-serving reviews of an Organization.
 */

const SITE_ORIGIN = 'https://bemoreswan.com';
export const MIN_TO_SHOW = 3;
export const MAX_SHOWN = 6;

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const ldJson = (obj, indent = '    ') =>
    `${indent}<script type="application/ld+json">\n` +
    JSON.stringify(obj, null, 2).replace(/</g, '\\u003c').split('\n').map((l) => indent + l).join('\n') +
    `\n${indent}</script>`;

/** The reviews worth showing, or null when there are too few to show any. */
export function showable(data) {
    const reviews = (data && Array.isArray(data.reviews) ? data.reviews : [])
        .filter((r) => r && r.name && r.body && Number.isInteger(r.rating) && r.rating >= 1 && r.rating <= 5)
        .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    const count = Number(data?.summary?.count) || 0;
    const average = Number(data?.summary?.average);
    if (reviews.length < MIN_TO_SHOW || !count || !Number.isFinite(average)) return null;
    return { reviews: reviews.slice(0, MAX_SHOWN), count, average };
}

const stars = (n) => `<span class="text-amber-500" aria-hidden="true">${'★'.repeat(n)}${'☆'.repeat(5 - n)}</span>`;

/** The visible section. '' when there is nothing to show — the marker region stays empty. */
export function testimonialsHtml(data) {
    const s = showable(data);
    if (!s) return '';
    const cards = s.reviews.map((r) => `
            <figure class="bg-gray-50 rounded-2xl border border-gray-200 p-6 flex flex-col">
                <p class="text-lg" aria-label="${r.rating} out of 5 stars">${stars(r.rating)}</p>
                <blockquote class="text-gray-700 mt-3 whitespace-pre-line flex-1">${esc(r.body)}</blockquote>
                <figcaption class="mt-4">
                    <p class="font-bold text-gray-900">${esc(r.name)}</p>
                    ${r.detail ? `<p class="text-sm text-gray-500">${esc(r.detail)}</p>` : ''}
                    ${r.incentiveNote ? `<p class="text-xs text-gray-500 mt-1">${esc(r.incentiveNote)}</p>` : ''}
                </figcaption>
            </figure>`).join('');
    return `<section id="reviews" class="py-20 bg-white border-t border-gray-100">
    <div class="max-w-7xl mx-auto px-4">
        <div class="text-center max-w-3xl mx-auto mb-12">
            <h2 class="text-4xl font-extrabold text-gray-900 tracking-tight">What business owners say</h2>
            <p class="text-xl text-gray-500 mt-4">Rated <strong class="text-gray-900">${s.average.toFixed(1)} out of 5</strong> from ${s.count} review${s.count === 1 ? '' : 's'} by people using Be More Swan. Newest first.</p>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-6">${cards}
        </div>
    </div>
</section>`;
}

/** Review + AggregateRating on the #software node. '' when the section shows nothing. */
export function reviewsJsonLd(data) {
    const s = showable(data);
    if (!s) return '';
    return ldJson({
        '@context': 'https://schema.org',
        '@type': 'SoftwareApplication',
        '@id': `${SITE_ORIGIN}/#software`,
        name: 'Be More Swan',
        aggregateRating: {
            '@type': 'AggregateRating',
            ratingValue: s.average.toFixed(1),
            reviewCount: s.count,
            bestRating: 5,
            worstRating: 1,
        },
        review: s.reviews.map((r) => ({
            '@type': 'Review',
            author: { '@type': 'Person', name: r.name },
            ...(r.date ? { datePublished: r.date } : {}),
            reviewBody: r.body,
            reviewRating: { '@type': 'Rating', ratingValue: r.rating, bestRating: 5, worstRating: 1 },
        })),
    });
}

/** One line for llms.txt's generated half, or '' when there is nothing to say. */
export function llmsReviewsLine(data) {
    const s = showable(data);
    if (!s) return '';
    return `## Reviews\n\nRated ${s.average.toFixed(1)} out of 5 from ${s.count} reviews by people using Be More Swan. ` +
        `Early reviewers were beta testers who had free access, and their reviews say so. Read them at ${SITE_ORIGIN}/#reviews.`;
}
