// src/config/site-templates.ts — the Website Assistant's templates (owner, 2026-10-18: "a template
// area… beautiful and enticing… the basis of the first draft"). DATA ONLY: the design (lettering,
// colours, corners, spacing, header, hero) and a starting layout of pages and sections for each.
// Applied by site-definition.ts applySiteOperation({ op: 'apply_template' }); shown in the editor's
// template gallery (previews rendered by site-preview.ts with the business's own name).
//
// Rules for the words here — they become a real business's site:
//   • nothing a buyer could take as a fact about THIS business: prices, years, numbers, names and
//     claims are [in square brackets], which publishing refuses until they are filled in;
//   • no testimonials: sites show real reviews (the Reviews section), never made-up ones;
//   • {name} is the business's name and {town} its town, filled in when the template is applied.
// Pictures are free-to-use Pexels photos (hotlinked, as stock is everywhere in the product), there to
// be swapped for the business's own.

import type { SiteTheme } from '../utils/site-definition';

type Look = { background?: 'auto' | 'plain' | 'soft' | 'brand'; columns?: 'auto' | 2 | 3; menuLabel?: string | null };
export interface TemplateSection { id?: string; type: string; props: Record<string, unknown>; look?: Look }
export interface TemplatePage { title: string; slug: string; sections: TemplateSection[] }
export interface SiteTemplate {
    id: string;
    name: string;
    /** One line for the gallery card. */
    tagline: string;
    /** Who it suits — shown on the card and used to suggest one. */
    bestFor: string[];
    theme: Pick<SiteTheme, 'primaryColor' | 'textColor' | 'backgroundColor' | 'font' | 'radius'> & Required<Pick<SiteTheme, 'spacing' | 'header'>> & { accentColor: string | null };
    structure: 'pages' | 'one_page';
    pages: TemplatePage[];
}

const px = (id: number, alt: string) => ({ url: `https://images.pexels.com/photos/${id}/pexels-photo-${id}.jpeg?auto=compress&cs=tinysrgb&w=1600`, alt });

export const SITE_TEMPLATES: SiteTemplate[] = [
    {
        id: 'willow', name: 'Willow', tagline: 'Soft, calm and elegant — a centred name and a full-width welcome.',
        bestFor: ['Hair & beauty', 'Salons & spas', 'Nails & brows'],
        theme: { font: 'elegant', primaryColor: '#7d5a44', textColor: '#2e2925', backgroundColor: '#faf6f1', accentColor: '#d8c3ae', radius: 'small', spacing: 'airy', header: 'centered' },
        structure: 'one_page',
        pages: [{ title: 'Home', slug: '', sections: [
            { type: 'hero', props: { layout: 'cover', eyebrow: 'Hair & beauty in {town}', headline: 'Look like you, only more so', subheadline: 'Unhurried appointments, honest advice and a finish you can manage at home.', primaryCta: { label: 'Book an appointment', href: '#book' }, secondaryCta: { label: 'See our services', href: '#services' }, image: px(7823407, 'A bright salon with mirrors and styling chairs') } },
            { type: 'text', look: { menuLabel: 'About' }, props: { heading: 'A calm chair and an honest opinion', body: 'At {name} we take the time to listen before we pick up the scissors. We\'ll tell you what will suit your hair, what it needs, and how to keep it looking good between visits.\n\n[A sentence about your team and what makes your salon different.]', image: px(14564860, 'A client relaxing in the salon'), imageSide: 'right' } },
            { id: 'services', type: 'features', look: { menuLabel: 'Services', columns: 3 }, props: { heading: 'Services', intro: 'Every appointment starts with a proper consultation.', items: [
                { title: 'Cut & finish', body: 'Shaped for the way your hair grows and the time you have in the morning. From [price].' },
                { title: 'Colour', body: 'Gloss, highlights or a complete change, with a skin test first. From [price].' },
                { title: 'Treatments', body: 'Conditioning and repair that you can feel. From [price].' }] } },
            { id: 'book', type: 'booking', look: { menuLabel: 'Book' }, props: { kind: 'appointment', heading: 'Book your appointment', intro: 'Choose a service and a time that suits you.' } },
            { type: 'gallery', look: { menuLabel: 'Gallery' }, props: { heading: 'Inside the salon', layout: 'square', images: [px(7750124, 'Styling stations with round mirrors'), px(853427, 'Salon chairs in warm light'), px(7195799, 'The backwash area')] } },
            { type: 'reviews', props: { heading: 'What clients say', showSummary: true } },
            { type: 'hours', look: { menuLabel: 'Find us' }, props: { heading: 'Opening hours' } },
            { type: 'contact', look: { menuLabel: 'Contact' }, props: { heading: 'Get in touch', intro: 'Questions about a service or a booking? Send us a message.', askPhone: true } },
        ] }],
    },
    {
        id: 'bistro', name: 'Bistro', tagline: 'Warm and classic — big food photography and a book-a-table button.',
        bestFor: ['Restaurants', 'Cafés', 'Bars & pubs'],
        theme: { font: 'classic', primaryColor: '#8e2c20', textColor: '#231c16', backgroundColor: '#fbf7f0', accentColor: '#e8d6bd', radius: 'none', spacing: 'regular', header: 'centered' },
        structure: 'pages',
        pages: [
            { title: 'Home', slug: '', sections: [
                { type: 'hero', props: { layout: 'cover', eyebrow: '{town}', headline: 'Seasonal food, cooked with care', subheadline: 'Come in for [breakfast, lunch or dinner] — and stay a little longer than you planned.', primaryCta: { label: 'Book a table', href: '/book' }, secondaryCta: { label: 'Opening hours', href: '/visit' }, image: px(5083907, 'A warm restaurant table with wine glasses') } },
                { type: 'text', props: { heading: 'From our kitchen', body: 'At {name} we cook with what is good right now, from suppliers we know by name.\n\n[A sentence about your food, your chef or your story.]', image: px(12318002, 'A plated dish on the table'), imageSide: 'left' } },
                { type: 'features', look: { columns: 3, background: 'soft' }, props: { heading: 'Worth coming back for', items: [
                    { title: '[A signature dish]', body: '[What is in it, and why people order it.]' },
                    { title: '[A second dish]', body: '[A short, mouth-watering description.]' },
                    { title: '[Something to drink]', body: '[Your coffee, wine or cocktails.]' }] } },
                { type: 'gallery', props: { heading: 'At the table', layout: 'square', images: [px(7627418, 'Plates of food to share'), px(3015229, 'Salad and a glass of wine'), px(6327536, 'A small plate on a white table'), px(15372564, 'Dishes on a wooden table')] } },
                { type: 'reviews', props: { heading: 'Kind words', showSummary: true } },
                { type: 'cta', props: { heading: 'Celebrating something?', body: 'We host birthdays, private dinners and small events. Tell us what you have in mind.', button: { label: 'Ask about events', href: '/visit' } } },
            ] },
            { title: 'Book a table', slug: 'book', sections: [
                { type: 'booking', props: { kind: 'table', heading: 'Book a table', intro: 'Choose a day, a time and how many of you are coming.' } },
            ] },
            { title: 'Visit us', slug: 'visit', sections: [
                { type: 'hours', props: { heading: 'Opening hours' } },
                { type: 'contact', props: { heading: 'Get in touch', intro: 'For bookings of [eight] or more, events or anything else.', askPhone: true } },
            ] },
        ],
    },
    {
        id: 'studio', name: 'Studio', tagline: 'Clean, white and confident — lets the work speak.',
        bestFor: ['Photographers', 'Designers & creatives', 'Architects'],
        theme: { font: 'tech', primaryColor: '#111111', textColor: '#111111', backgroundColor: '#ffffff', accentColor: '#efece6', radius: 'none', spacing: 'airy', header: 'standard' },
        structure: 'pages',
        pages: [
            { title: 'Home', slug: '', sections: [
                { type: 'hero', props: { layout: 'split', eyebrow: '{name}', headline: 'Quiet, honest pictures of [what you photograph]', subheadline: 'Based in {town}, working [across the UK].', primaryCta: { label: 'Start a project', href: '/contact' }, secondaryCta: { label: 'See the work', href: '#work' }, image: px(19356864, 'A chair in soft afternoon light') } },
                { id: 'work', type: 'gallery', props: { heading: 'Selected work', layout: 'natural', images: [px(18269637, 'Behind the scenes of a shoot'), px(25287581, 'A stool against a green backdrop'), px(7193650, 'A wooden chair beside a plant'), px(14920159, 'A plaster bust on a stool')] } },
                { type: 'text', look: { background: 'soft' }, props: { heading: 'How I work', body: 'Every project starts with a conversation about what the pictures are for. Then I plan the day so it feels easy, and deliver a careful edit you can use straight away.\n\n[A sentence about your experience or approach.]', image: px(20368729, 'A camera on a tripod in the studio'), imageSide: 'right' } },
                { type: 'steps', props: { heading: 'From first message to finished pictures', items: [
                    { title: 'Tell me about it', body: 'What you need, when, and where the pictures will be used.' },
                    { title: 'A clear quote', body: 'One price that covers the shoot and the edit. [Typical timescale].' },
                    { title: 'The shoot', body: 'Relaxed, organised and on time.' },
                    { title: 'Your gallery', body: 'A private online gallery to choose and download from.' }] } },
                { type: 'cta', props: { heading: 'Have a project in mind?', body: 'Tell me a little about it and I\'ll come back to you within [two working days].', button: { label: 'Get in touch', href: '/contact' } } },
            ] },
            { title: 'Contact', slug: 'contact', sections: [
                { type: 'contact', props: { heading: 'Start a project', intro: 'A few lines is plenty — dates, place and what the pictures are for.', askPhone: true } },
            ] },
        ],
    },
    {
        id: 'bloom', name: 'Bloom', tagline: 'Gentle and natural — soft greens, rounded corners, room to breathe.',
        bestFor: ['Yoga & pilates', 'Therapists & wellbeing', 'Classes & retreats'],
        theme: { font: 'editorial', primaryColor: '#4e6a50', textColor: '#26302a', backgroundColor: '#f6f4ee', accentColor: '#cfdcc6', radius: 'large', spacing: 'airy', header: 'standard' },
        structure: 'one_page',
        pages: [{ title: 'Home', slug: '', sections: [
            { type: 'hero', props: { layout: 'cover', eyebrow: '{name} · {town}', headline: 'Make a little room for yourself', subheadline: 'Small, friendly classes for every body and every level.', primaryCta: { label: 'See classes', href: '#classes' }, secondaryCta: { label: 'Ask a question', href: '#contact' }, image: px(38470685, 'A peaceful studio with soft curtains') } },
            { type: 'text', look: { menuLabel: 'About' }, props: { heading: 'Come as you are', body: 'You don\'t need to be flexible, fit or experienced. Our classes are small, so there is always time to help you find your way into each pose.\n\n[A sentence about you, your training and why you teach.]', image: px(39031170, 'People meditating in the studio'), imageSide: 'left' } },
            { type: 'features', look: { menuLabel: 'Ways to practise', columns: 3, background: 'soft' }, props: { heading: 'Ways to practise', items: [
                { title: 'Group classes', body: 'Steady, mindful sessions of [length]. [Price] a class.' },
                { title: 'Private sessions', body: 'One to one, shaped around you. [Price].' },
                { title: 'Workshops', body: 'Longer sessions on a single theme, a few times a year.' }] } },
            { id: 'classes', type: 'booking', look: { menuLabel: 'Classes' }, props: { kind: 'class', heading: 'Classes & workshops', intro: 'Book your place — when a class is full you can join the waiting list.' } },
            { type: 'gallery', props: { heading: 'The studio', layout: 'square', images: [px(4323341, 'Light through white curtains'), px(37573625, 'A sunlit pilates studio'), px(3984341, 'A group meditating together')] } },
            { type: 'faq', look: { menuLabel: 'Questions' }, props: { heading: 'Questions', items: [
                { q: 'I\'m a complete beginner — is that all right?', a: 'Yes. Every class offers simpler options, and we\'ll help you settle in.' },
                { q: 'What should I bring?', a: '[Your answer — mats, water, clothing.]' },
                { q: 'How do I cancel?', a: '[Your cancellation policy.]' }] } },
            { id: 'contact', type: 'contact', look: { menuLabel: 'Contact' }, props: { heading: 'Say hello', intro: 'Not sure which class is for you? Ask us.' } },
        ] }],
    },
    {
        id: 'atelier', name: 'Atelier', tagline: 'Crafted and warm — terracotta tones and a boutique serif.',
        bestFor: ['Makers & small shops', 'Florists & gift shops', 'Ceramics & craft'],
        theme: { font: 'warm', primaryColor: '#a4502f', textColor: '#2a2420', backgroundColor: '#fbf8f4', accentColor: '#f0d9cc', radius: 'medium', spacing: 'regular', header: 'standard' },
        structure: 'pages',
        pages: [
            { title: 'Home', slug: '', sections: [
                { type: 'hero', props: { layout: 'split', eyebrow: 'Made in {town}', headline: 'Small batches, made by hand', subheadline: '[What you make] for everyday use — each one a little different.', primaryCta: { label: 'Visit the studio', href: '/contact' }, secondaryCta: { label: 'Our story', href: '#story' }, image: px(6611415, 'Handmade pottery by a window') } },
                { type: 'gallery', props: { heading: 'From the studio', layout: 'square', images: [px(6611418, 'Pottery on wooden shelves'), px(29286722, 'Cups and bowls on rustic shelves'), px(20304752, 'Handmade mugs in the workshop'), px(8063872, 'A row of white ceramic vases')] } },
                { id: 'story', type: 'text', look: { background: 'soft' }, props: { heading: 'The story', body: '{name} began [when and how]. Everything is still made by hand, in small numbers, so it lasts.\n\n[A sentence about your materials or your process.]', image: px(14963657, 'Working in the ceramic workshop'), imageSide: 'right' } },
                { type: 'features', look: { columns: 3 }, props: { heading: 'Why people come back', items: [
                    { title: 'Made to last', body: 'Chosen materials and careful finishing.' },
                    { title: 'Small batches', body: 'Made in small numbers, never mass-produced.' },
                    { title: 'Wrapped with care', body: 'Gift-ready, with [delivery or collection details].' }] } },
                { type: 'reviews', props: { heading: 'Lovely things people say', showSummary: true } },
                { type: 'cta', props: { heading: 'Something made just for you', body: 'We take a few commissions each [season]. Tell us what you\'re looking for.', button: { label: 'Ask about a commission', href: '/contact' } } },
            ] },
            { title: 'Contact', slug: 'contact', sections: [
                { type: 'hours', props: { heading: 'Studio opening hours' } },
                { type: 'contact', props: { heading: 'Get in touch', intro: 'Orders, commissions or a question — we\'re happy to help.' } },
            ] },
        ],
    },
    {
        id: 'ledger', name: 'Ledger', tagline: 'Clear, modern and trustworthy — made for professional services.',
        bestFor: ['Accountants & bookkeepers', 'Consultants', 'Solicitors & advisers'],
        theme: { font: 'modern', primaryColor: '#1f3a5f', textColor: '#0f1d2e', backgroundColor: '#ffffff', accentColor: '#dbe5f1', radius: 'small', spacing: 'regular', header: 'standard' },
        structure: 'pages',
        pages: [
            { title: 'Home', slug: '', sections: [
                { type: 'hero', props: { layout: 'split', eyebrow: '[What you do] in {town}', headline: 'Clear advice, from people who pick up the phone', subheadline: 'We help [who you help] with [what you help with] — explained in plain English.', primaryCta: { label: 'Book a free first call', href: '/contact' }, secondaryCta: { label: 'How we help', href: '#help' }, image: px(5511119, 'A bright, modern office') } },
                { id: 'help', type: 'features', look: { columns: 3, background: 'soft' }, props: { heading: 'How we help', items: [
                    { title: '[Your first service]', body: '[Who it is for and what they get.]' },
                    { title: '[Your second service]', body: '[Who it is for and what they get.]' },
                    { title: '[Your third service]', body: '[Who it is for and what they get.]' }] } },
                { type: 'steps', props: { heading: 'Working with us', items: [
                    { title: 'A free first call', body: 'We listen, and tell you honestly whether we can help.' },
                    { title: 'A fixed quote', body: 'One clear price, agreed before we start.' },
                    { title: 'We get to work', body: 'You\'ll always know who is looking after you.' }] } },
                { type: 'text', props: { heading: 'People, not a call centre', body: '{name} is [a small team / one adviser] based in {town}. You\'ll speak to the same person every time.\n\n[Your qualifications or memberships, in a sentence.]', image: px(3860621, 'Colleagues talking through a project'), imageSide: 'left' } },
                { type: 'faq', props: { heading: 'Common questions', items: [
                    { q: 'How much does it cost?', a: '[Your pricing — fixed fees, hourly, or "from".]' },
                    { q: 'Do you work with businesses like mine?', a: '[The kinds of clients you work with.]' },
                    { q: 'How quickly can you start?', a: '[Your usual timescale.]' }] } },
                { type: 'cta', props: { heading: 'Let\'s talk it through', body: 'A free, no-obligation first call.', button: { label: 'Book a call', href: '/contact' } } },
            ] },
            { title: 'Contact', slug: 'contact', sections: [
                { type: 'contact', props: { heading: 'Get in touch', intro: 'Tell us a little about what you need and we\'ll be in touch within [one working day].', askPhone: true } },
                { type: 'hours', props: { heading: 'Office hours' } },
            ] },
        ],
    },
    {
        id: 'forge', name: 'Forge', tagline: 'Strong and direct — bold lettering for trades that get things done.',
        bestFor: ['Builders & joiners', 'Plumbers & electricians', 'Decorators & landscapers'],
        theme: { font: 'bold', primaryColor: '#c2410c', textColor: '#1b1b1b', backgroundColor: '#ffffff', accentColor: '#efe7dc', radius: 'small', spacing: 'regular', header: 'standard' },
        structure: 'pages',
        pages: [
            { title: 'Home', slug: '', sections: [
                { type: 'hero', props: { layout: 'cover', eyebrow: '[Your trade] in {town}', headline: 'Built properly. Finished on time.', subheadline: 'Free quotes, fixed prices and a tidy site — from first visit to final sign-off.', primaryCta: { label: 'Get a free quote', href: '/quote' }, secondaryCta: { label: 'See our work', href: '#work' }, image: px(37663434, 'A workbench with tools in the workshop') } },
                { type: 'features', look: { columns: 3 }, props: { heading: 'What we do', items: [
                    { title: '[Service one]', body: '[A sentence on what is included.]' },
                    { title: '[Service two]', body: '[A sentence on what is included.]' },
                    { title: '[Service three]', body: '[A sentence on what is included.]' },
                    { title: '[Service four]', body: '[A sentence on what is included.]' },
                    { title: '[Service five]', body: '[A sentence on what is included.]' },
                    { title: '[Service six]', body: '[A sentence on what is included.]' }] } },
                { type: 'steps', look: { background: 'soft' }, props: { heading: 'How it works', items: [
                    { title: 'Free visit & quote', body: 'We look at the job and give you a written, fixed price.' },
                    { title: 'A date that suits you', body: 'Booked in, with a clear start and finish.' },
                    { title: 'The work', body: 'Done properly, with the site left clean every day.' },
                    { title: 'Sign-off', body: 'We walk round it with you before we call it finished.' }] } },
                { id: 'work', type: 'gallery', props: { heading: 'Recent work', layout: 'square', images: [px(7480737, 'A finished piece of joinery'), px(5974285, 'Cutting timber in the workshop'), px(6790031, 'Tools laid out for the job'), px(5484718, 'Carpentry tools on wood')] } },
                { type: 'reviews', props: { heading: 'What customers say', showSummary: true } },
                { type: 'cta', props: { heading: 'Need a job doing?', body: 'Tell us about it and we\'ll arrange a free visit.', button: { label: 'Get a free quote', href: '/quote' } } },
            ] },
            { title: 'Free quote', slug: 'quote', sections: [
                { type: 'contact', props: { heading: 'Get a free quote', intro: 'Tell us what needs doing and where — photos help if you have them.', askPhone: true, buttonLabel: 'Send my enquiry' } },
                { type: 'hours', props: { heading: 'When we work' } },
            ] },
        ],
    },
    {
        id: 'stride', name: 'Stride', tagline: 'Bright and energetic — friendly lettering and a strong call to start.',
        bestFor: ['Personal trainers', 'Coaches', 'Fitness & sport'],
        theme: { font: 'friendly', primaryColor: '#c8401b', textColor: '#1d1d1f', backgroundColor: '#fffdf9', accentColor: '#ffe3d6', radius: 'large', spacing: 'regular', header: 'standard' },
        structure: 'one_page',
        pages: [{ title: 'Home', slug: '', sections: [
            { type: 'hero', props: { layout: 'cover', eyebrow: 'Coaching in {town}', headline: 'Get stronger, at your own pace', subheadline: 'Personal training that fits around your life — and keeps you coming back.', primaryCta: { label: 'Book a free consultation', href: '#book' }, secondaryCta: { label: 'How it works', href: '#how' }, image: px(39219674, 'A trainer guiding a client in the gym') } },
            { id: 'how', type: 'steps', look: { menuLabel: 'How it works' }, props: { heading: 'How we\'ll work together', items: [
                { title: 'A free chat', body: 'Where you are now, where you want to be, and what gets in the way.' },
                { title: 'Your plan', body: 'Sessions and habits built around your week.' },
                { title: 'Keep going', body: 'Regular check-ins so progress keeps coming.' }] } },
            { type: 'text', look: { background: 'soft', menuLabel: 'About' }, props: { heading: 'Training that fits your life', body: 'I\'m [your name], a [qualification] coach in {town}. I work with people who want to feel fitter and stronger without living in the gym.\n\n[A sentence about your approach.]', image: px(40211337, 'An outdoor training session'), imageSide: 'right' } },
            { type: 'features', look: { menuLabel: 'Ways to train', columns: 3 }, props: { heading: 'Ways to train', items: [
                { title: 'One to one', body: 'Full attention, every session. [Price].' },
                { title: 'Small groups', body: 'Train with [two to four] others and share the cost. [Price].' },
                { title: 'Online', body: 'A plan and weekly check-ins, wherever you are. [Price].' }] } },
            { id: 'book', type: 'booking', look: { menuLabel: 'Book' }, props: { kind: 'consultation', heading: 'Book a free consultation', intro: 'Twenty minutes to talk about what you want — no pressure.' } },
            { type: 'gallery', props: { heading: 'In the gym', layout: 'square', images: [px(37963576, 'A trainer helping a client'), px(4853682, 'Lifting weights in the gym')] } },
            { type: 'faq', look: { menuLabel: 'Questions' }, props: { heading: 'Questions', items: [
                { q: 'I haven\'t exercised in years — where do I start?', a: 'With the free consultation. We\'ll start where you are.' },
                { q: 'Where do sessions happen?', a: '[Your gym, outdoors, or at home.]' },
                { q: 'How much does it cost?', a: '[Your prices and any packages.]' }] } },
            { type: 'contact', look: { menuLabel: 'Contact' }, props: { heading: 'Ask me anything', intro: 'Questions before you book? Send a message.' } },
        ] }],
    },
];

export const templateById = (id: unknown) => SITE_TEMPLATES.find((t) => t.id === id) ?? null;

/** {name} and {town} filled in, everywhere in a template's words. */
export function fillTemplateWords<T>(value: T, words: { name: string; town: string | null }): T {
    const fill = (s: string) => s.replace(/\{name\}/g, words.name).replace(/\{town\}/g, words.town || '[your town]');
    const walk = (v: unknown): unknown => (typeof v === 'string' ? fill(v) : Array.isArray(v) ? v.map(walk) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v);
    return walk(value) as T;
}
