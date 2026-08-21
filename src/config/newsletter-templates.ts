// src/config/newsletter-templates.ts
// The layouts a new issue can start from, and the one it starts from by default for each purpose.
//
// ⚠️ A TEMPLATE IS A STARTING POINT, NOT A FORMAT. Everything a template produces is an ordinary
// block the author can move, restyle or delete — there is no locked region, no "template mode" and
// nothing that has to be filled in. A design that cannot be taken apart is a design people fight,
// and the whole reason for the Studio is that a plain Markdown box was too little control rather
// than too much.
//
// ⚠️ THE PLACEHOLDER COPY IS DELIBERATELY OBVIOUS. "Say the one thing this email is about" is
// annoying to read and impossible to send by accident; a lorem-ipsum-grade filler that reads like
// English is how a template's own words end up in somebody's inbox. Every text block below is
// written so that leaving it in would be visibly wrong.

import type { NewsletterDesign, DesignBlock } from '../utils/newsletter-design';
import { DEFAULT_THEME } from '../utils/newsletter-design';

export interface NewsletterTemplate {
    key: string;
    label: string;
    /** One line in the picker. What this shape is FOR, not what is in it. */
    description: string;
    /** A tiny schematic for the picker — block types top to bottom, drawn as bars. */
    build: () => DesignBlock[];
}

let seq = 0;
const id = () => `t_${Date.now().toString(36)}_${(seq++).toString(36)}`;

const heading = (text: string, level: 1 | 2 | 3 = 2): DesignBlock =>
    ({ id: id(), type: 'heading', text, level, align: 'left' });
const text = (markdown: string): DesignBlock =>
    ({ id: id(), type: 'text', markdown, align: 'left' });
const image = (): DesignBlock =>
    ({ id: id(), type: 'image', assetId: null, baseAssetId: null, alt: '', href: '', align: 'center', width: 100, caption: '', overlays: [] });
const button = (label: string): DesignBlock =>
    ({ id: id(), type: 'button', label, href: '', align: 'center', background: DEFAULT_THEME.accent, color: '#ffffff' });
const divider = (): DesignBlock => ({ id: id(), type: 'divider' });
const spacer = (size = 16): DesignBlock => ({ id: id(), type: 'spacer', size });

export const NEWSLETTER_TEMPLATES: NewsletterTemplate[] = [
    {
        key: 'classic',
        label: 'Letter',
        description: 'Words first — a greeting and a few short sections. The shape people read fastest.',
        build: () => [
            text('Hi {{contact.first_name | "there"}},'),
            text('Open with the one thing this issue is about, in a sentence.'),
            heading('First thing'),
            text('Replace this with what you wanted to tell them.'),
            heading('Second thing'),
            text('And this. Two or three sections is plenty.'),
            text('Replace this with how you sign off.'),
        ],
    },
    {
        key: 'announcement',
        label: 'Announcement',
        description: 'One picture, one headline, one action. For news that is a single thing.',
        build: () => [
            image(),
            heading('Say the news in six words', 1),
            text('One short paragraph: what it is, when it happens, who it is for.'),
            button('Find out more'),
            spacer(8),
            text('Anything else worth knowing goes here, briefly.'),
        ],
    },
    {
        key: 'update',
        label: 'What is new',
        description: 'A run of short entries. For product updates and monthly round-ups.',
        build: () => [
            heading("What's new", 1),
            text('One line on why this batch is worth reading.'),
            divider(),
            heading('The first change', 3),
            text('What a reader can now do that they could not do before.'),
            heading('The second change', 3),
            text('Same again — lead with what it means for them.'),
            divider(),
            button('See it all'),
        ],
    },
    {
        key: 'notice',
        label: 'Notice',
        description: 'Plain and unadorned. For terms changes, outages and anything people must actually read.',
        build: () => [
            heading('What is changing', 1),
            text('State the change and the date it takes effect, in the first two sentences.'),
            heading('What this means for you', 3),
            text('Say plainly whether they need to do anything, and by when.'),
            heading('If you would rather not', 3),
            text('Say what their options are, including leaving, if that is one.'),
        ],
    },
    {
        key: 'offer',
        label: 'Offer',
        description: 'A hero image, the offer, and one button. For promotions with a deadline.',
        build: () => [
            image(),
            heading('The offer, in plain words', 1),
            text('What it is, who it applies to, and the date it ends.'),
            button('Claim it'),
            spacer(8),
            text('_The terms, in full, so nobody has to ask._'),
        ],
    },
    {
        key: 'two_column',
        label: 'Two column',
        description: 'A picture beside its words. For a digest of several unrelated things.',
        build: () => [
            heading('This month', 1),
            {
                id: id(), type: 'columns',
                columns: [
                    [image()],
                    [
                        { id: id(), type: 'heading', text: 'The first item', level: 3, align: 'left' },
                        { id: id(), type: 'text', markdown: 'Two or three lines, no more.', align: 'left' },
                    ],
                ],
            } as DesignBlock,
            divider(),
            {
                id: id(), type: 'columns',
                columns: [
                    [
                        { id: id(), type: 'heading', text: 'The second item', level: 3, align: 'left' },
                        { id: id(), type: 'text', markdown: 'Two or three lines, no more.', align: 'left' },
                    ],
                    [image()],
                ],
            } as DesignBlock,
        ],
    },
    {
        key: 'blank',
        label: 'Blank',
        description: 'Nothing at all. Build it up block by block.',
        build: () => [text('Start writing.')],
    },
];

export const TEMPLATE_KEYS = NEWSLETTER_TEMPLATES.map((t) => t.key);

export function findTemplate(key: unknown): NewsletterTemplate {
    const k = typeof key === 'string' ? key : '';
    return NEWSLETTER_TEMPLATES.find((t) => t.key === k) ?? NEWSLETTER_TEMPLATES[0];
}

/** A fresh design from a template key. The theme is always the default — themes are per-issue. */
export function designFromTemplate(key: unknown): NewsletterDesign {
    const template = findTemplate(key);
    return {
        version: 1,
        template: template.key,
        theme: { ...DEFAULT_THEME },
        blocks: template.build(),
    };
}
