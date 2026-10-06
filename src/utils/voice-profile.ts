// src/utils/voice-profile.ts
//
// Turns an assistant's tone-of-voice setting into WRITING RULES the model can actually follow.
//
// ⚠️ Why this exists: every generator used to say "write in a ${tone} tone" — one adjective, no
// definition. "Professional", "Casual", "Confident" and "Friendly" all collapsed into the same
// pleasant, mid-length, LinkedIn-ish register, because that is the model's default and a single word
// gives it nothing to move away from. The user reported that changing the setting made no visible
// difference to drafts (2026-10-06). The cure is to say what each tone DOES to sentences: length,
// contractions, punctuation, emoji, humour, vocabulary, how the reader is addressed, how a piece ends
// — with a "sounds like / never sounds like" pair so the model can calibrate against something.
//
// The tone setting is free text on the Social Media Assistant ("Friendly and supportive, never
// salesy") and a fixed choice elsewhere (Professional / Casual / Confident / Friendly, formal /
// casual, empathetic / professional / energetic). So traits are DETECTED from the words used, any
// number may combine, and the user's own words always lead — the rules sharpen them, never replace
// them. A description that matches no trait still gets a directive: the model is told to derive
// concrete rules from it rather than fall back to its default voice.
//
// One module, every surface: social posts, blog posts, email marketing, lead outreach and support
// replies. A surface passes `surface` so the rules that only make sense on one (emoji, hashtags,
// sign-offs) are worded for it.

export type VoiceSurface = 'social' | 'blog' | 'email' | 'outreach' | 'support';

interface Trait {
    key: string;
    /** Whole-word matches against the lower-cased tone setting. */
    words: string[];
    label: string;
    rules: string[];
    /** Rules that only apply on these surfaces (e.g. emoji on social). */
    surfaceRules?: Partial<Record<VoiceSurface, string[]>>;
    soundsLike: string;
    neverLike: string;
}

// Each trait is written to be AUDIBLY different from its neighbours — that is the whole point.
// Keep the rules concrete (a measurable habit), not adjectives restated.
const TRAITS: Trait[] = [
    {
        key: 'professional',
        words: ['professional', 'formal', 'corporate', 'polished', 'business', 'businesslike', 'measured'],
        label: 'Professional',
        rules: [
            'Complete, well-formed sentences of medium length (roughly 12–22 words). No fragments for effect.',
            'Few or no contractions ("we will", "it is"), and no slang, filler words or exclamation marks.',
            'Precise, plain vocabulary; name things exactly. Claims are measured and qualified where honest.',
            'Address the reader respectfully and directly; no "hey", no "folks", no in-jokes.',
            'End with a clear, courteous next step or conclusion — never a joke or a cliffhanger.',
        ],
        surfaceRules: { social: ['No emoji, or at most one functional one (e.g. a pointer to a link).'] },
        soundsLike: 'Most late payments are a process problem, not a customer problem. Here is how to fix the process.',
        neverLike: "Ugh, chasing invoices? We've ALL been there 😅 Let's fix it!!",
    },
    {
        key: 'authoritative',
        words: ['authoritative', 'expert', 'expertise', 'credible', 'thought-leader', 'thought-leadership', 'knowledgeable'],
        label: 'Authoritative',
        rules: [
            'Speak from experience and state conclusions plainly — "this works", not "this might help".',
            'Lead with the insight, then the reasoning. Specific, concrete examples over general advice.',
            'No hedging stacks ("perhaps it could be worth considering"); one qualifier at most, only when true.',
            'Name the trade-off or the common mistake — experts know where things go wrong.',
        ],
        surfaceRules: { social: ['No emoji.'] },
        soundsLike: 'Discounting to win a client sets the price of every job that follows. Quote the real number once.',
        neverLike: 'Here are some tips that might possibly help you think about pricing!',
    },
    {
        key: 'casual',
        words: ['casual', 'conversational', 'relaxed', 'informal', 'chatty', 'laid', 'laidback', 'down-to-earth', 'chilled'],
        label: 'Casual',
        rules: [
            'Write the way you would talk to a friend over coffee: contractions everywhere, everyday words.',
            'Mix very short sentences with longer rambling ones. Fragments are fine. Starting with "And" or "But" is fine.',
            'Use "you" and "I/we" freely; asides in brackets or after a dash are welcome.',
            'No corporate vocabulary ("leverage", "solutions", "stakeholders", "optimise", "streamline").',
            'Endings can be loose — a throwaway line, a question, or just stopping when the point is made.',
        ],
        surfaceRules: { social: ['One or two emoji are fine where they add feeling; never as bullet points.'] },
        soundsLike: "Honestly? Most of my Mondays used to go on admin. Not anymore — and it wasn't some big system.",
        neverLike: 'Our solution enables businesses to optimise their weekly administrative workflows.',
    },
    {
        key: 'friendly',
        words: ['friendly', 'warm', 'approachable', 'welcoming', 'kind', 'supportive', 'encouraging', 'helpful', 'caring'],
        label: 'Friendly & warm',
        rules: [
            'Warm and generous: assume the reader is doing their best, and say so where it fits.',
            'Contractions and plain words; sentences short to medium. Talk TO the reader ("you"), not about them.',
            'Encourage, never lecture or scold. No "you\'re doing it wrong", no guilt.',
            'Small human touches are welcome — a thank-you, a "you\'ve got this", a shared moment.',
        ],
        surfaceRules: { social: ['A friendly emoji or two is fine (😊 🙌 ☕), never a row of them.'] },
        soundsLike: "If your week got away from you, you're in good company. Here's one small thing that helps.",
        neverLike: 'Failing to plan your week is the number one mistake small businesses make.',
    },
    {
        key: 'confident',
        words: ['confident', 'bold', 'direct', 'assertive', 'punchy', 'straight-talking', 'straightforward', 'no-nonsense', 'blunt', 'decisive'],
        label: 'Confident & direct',
        rules: [
            'Short, declarative sentences. Many under 8 words. Say the point first, no warm-up.',
            'No hedging words at all: drop "maybe", "perhaps", "might", "just", "I think", "kind of".',
            'Active voice and strong verbs. Take a clear position and own it.',
            'Cut every sentence that does not earn its place. White space is a feature.',
            'End on a firm line or an instruction — not a question asking permission.',
        ],
        surfaceRules: { social: ['No emoji, or one at most.'] },
        soundsLike: 'Stop discounting. Your price is your positioning. Hold it.',
        neverLike: 'We think it might perhaps be worth considering whether discounting is always the best idea.',
    },
    {
        key: 'witty',
        words: ['witty', 'humorous', 'humour', 'humor', 'funny', 'playful', 'cheeky', 'fun', 'light-hearted', 'lighthearted', 'quirky', 'irreverent', 'tongue-in-cheek', 'sarcastic', 'dry'],
        label: 'Witty & playful',
        rules: [
            'Use real humour: an unexpected comparison, wordplay, understatement or a self-aware aside — at least one genuine laugh-line per piece.',
            'Comic timing matters: set up, then a short sharp payoff on its own line.',
            'Playful never means vague — the useful point must still land clearly.',
            'Never mean, never at the customer\'s expense, never about protected characteristics.',
            'No forced puns stacked on puns; one good joke beats three groan-worthy ones.',
        ],
        surfaceRules: { social: ['Emoji may be used for comic effect, sparingly.'] },
        soundsLike: 'My filing system is called "the pile". It has a 40% retrieval rate and a strong personality.',
        neverLike: 'Organising your documents is an important part of running a business efficiently.',
    },
    {
        key: 'inspirational',
        words: ['inspirational', 'inspiring', 'motivational', 'motivating', 'uplifting', 'aspirational', 'empowering', 'positive', 'optimistic', 'energetic', 'enthusiastic', 'upbeat', 'passionate'],
        label: 'Uplifting & energetic',
        rules: [
            'Forward-looking and energising: show what becomes possible, not only what is wrong.',
            'Vivid, concrete images over abstract motivation ("the first Friday you leave at four", not "achieve your dreams").',
            'Rhythm matters — vary sentence length and let a short line land after a longer build.',
            'Belief without hype: no "crush it", no "10x", no empty superlatives, no guarantees.',
        ],
        surfaceRules: { social: ['An energetic emoji or two is fine (✨ 🚀 💪), never a wall of them.'] },
        soundsLike: 'Picture the first Friday you close the laptop at four — and nothing falls over. That week is closer than you think.',
        neverLike: 'Unlock your full potential and crush your goals with our amazing game-changing tool!!!',
    },
    {
        key: 'empathetic',
        words: ['empathetic', 'empathic', 'compassionate', 'understanding', 'gentle', 'calm', 'reassuring', 'patient', 'sensitive', 'thoughtful'],
        label: 'Empathetic & calm',
        rules: [
            'Acknowledge the reader\'s situation or feeling first, specifically, before offering anything.',
            'Calm pace: medium sentences, no exclamation marks, no urgency or pressure language.',
            'Reassure with facts and next steps, not platitudes. Never minimise ("just", "simply", "easy").',
            'Leave the reader feeling understood rather than sold to.',
        ],
        surfaceRules: { social: ['No emoji, or one gentle one at most.'] },
        soundsLike: "Falling behind on the books is stressful, and it's far more common than people admit. Here's a calm way back in.",
        neverLike: 'Behind on your books?! Fix it NOW before it is too late!',
    },
    {
        key: 'educational',
        words: ['educational', 'informative', 'instructive', 'clear', 'practical', 'helpful', 'teaching', 'explanatory'],
        label: 'Clear & educational',
        rules: [
            'Teach one thing properly rather than several things vaguely.',
            'Explain any term the audience might not know, in plain words, the first time it appears.',
            'Use a concrete example or worked case for every abstract point.',
            'Signpost clearly — the reader should always know where they are and what they are learning.',
        ],
        soundsLike: 'A "retainer" just means the client pays a fixed amount each month for a set amount of your time. Here is how to price one.',
        neverLike: 'Leverage retainer-based monetisation paradigms for recurring revenue optimisation.',
    },
    {
        key: 'luxury',
        words: ['luxury', 'luxurious', 'premium', 'sophisticated', 'elegant', 'refined', 'exclusive', 'high-end', 'upscale'],
        label: 'Refined & premium',
        rules: [
            'Restraint: fewer words, chosen carefully. Understatement over enthusiasm.',
            'Sensory, precise detail (materials, craft, time taken) instead of adjectives like "amazing".',
            'No discount language, no urgency, no exclamation marks, no slang.',
            'Calm confidence — the quality speaks; the copy does not shout.',
        ],
        surfaceRules: { social: ['No emoji.'] },
        soundsLike: 'Hand-finished over three days. Made to be used for thirty years.',
        neverLike: 'AMAZING deal on our super premium luxury range!! 🔥🔥 Don\'t miss out!',
    },
];

// ── Voice builder (profile ▸ Voice builder, 2026-10-06) ──────────────────────────────────────────
// A user reported drafts read as "cheesy" and wanted control. The builder stores
// onboardingContext.voice; every generator passes it here beside the free-text tone.

/** The personalities the builder offers — the trait keys above, by label. Generated to the client. */
export const VOICE_PERSONALITIES = TRAITS.map((t) => ({ key: t.key, label: t.label }));

/**
 * The stock phrases that make copy read as "AI marketing" — offered as one-click SUGGESTIONS in the
 * builder's Never-say section. ⚠️ Not applied unless the owner adds them (2026-10-06: "this should
 * be empty by default"); a ban the owner cannot see on the screen is not theirs to control.
 */
export const DEFAULT_NEVER_SAY = [
    'game-changer', 'game changer', 'unlock', 'unleash', 'elevate', 'supercharge', 'level up',
    "let's dive in", 'dive into', 'deep dive', "in today's fast-paced world", 'in the ever-evolving',
    'look no further', 'take it to the next level', 'revolutionise', 'revolutionize', 'seamless',
    'cutting-edge', 'best-kept secret', "here's the thing", 'buckle up', 'the secret sauce',
    'Ever wondered', "Let's face it", 'Picture this', 'Imagine a world',
];

export interface VoiceSettings {
    /** Up to two TRAITS keys. Combined with any traits detected in the free-text tone. */
    personalities?: string[];
    /** 1–5 sliders; 3 = no steer. */
    formality?: number;   // 1 very formal … 5 very casual
    playfulness?: number; // 1 completely serious … 5 very playful
    energy?: number;      // 1 understated … 5 high energy
    colour?: number;      // 1 plain … 5 colourful
    emoji?: 'none' | 'few' | 'auto';
    exclamations?: 'never' | 'rarely' | 'auto';
    spelling?: 'british' | 'american' | 'auto';
    /** Phrases the copy must never contain. Absent = none. */
    neverSay?: string[];
    /** A short sample of the owner's own writing to match (style, not content). */
    sample?: string;
}

const SLIDERS: Record<'formality' | 'playfulness' | 'energy' | 'colour', Record<number, string>> = {
    formality: {
        1: 'Very formal: complete sentences, no contractions, no slang, no fragments.',
        2: 'Leaning formal: mostly complete sentences, few contractions, nothing chatty.',
        4: 'Leaning casual: contractions and everyday words; the odd fragment is fine.',
        5: 'Very casual: write like a message to a friend — contractions, short bursts, plain talk.',
    },
    playfulness: {
        1: 'Completely serious: no jokes, puns, wordplay or winks of any kind.',
        2: 'Mostly serious: a light touch at most, never a joke for its own sake.',
        4: 'Playful: a wry aside or a little humour is welcome where it fits.',
        5: 'Very playful: real humour and personality in most pieces — still clear and useful.',
    },
    energy: {
        1: 'Understated: calm and matter-of-fact. No hype words, no urgency, no superlatives.',
        2: 'Measured: confident but quiet; let the facts carry it.',
        4: 'Upbeat: positive and lively, without overselling.',
        5: 'High energy: enthusiastic and punchy — but every claim still has to be true and specific.',
    },
    colour: {
        1: 'Plain: literal language only — no metaphors, no imagery, no flourishes.',
        2: 'Mostly plain: one concrete image at most.',
        4: 'Colourful: vivid, concrete detail and the occasional fresh metaphor (never a cliché).',
        5: 'Very colourful: rich imagery and striking word choice — fresh, never purple or clichéd.',
    },
};

/** A clean, bounded VoiceSettings from anything (it is stored from the browser). */
export function normaliseVoice(raw: unknown): VoiceSettings | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const r = raw as Record<string, unknown>;
    const lvl = (v: unknown) => { const n = Math.round(Number(v)); return n >= 1 && n <= 5 ? n : 3; };
    const pick = <T extends string>(v: unknown, opts: readonly T[], d: T): T => (opts as readonly string[]).includes(String(v)) ? (v as T) : d;
    const keys = new Set(TRAITS.map((t) => t.key));
    return {
        personalities: (Array.isArray(r.personalities) ? r.personalities : []).map(String).filter((k) => keys.has(k)).slice(0, 2),
        formality: lvl(r.formality), playfulness: lvl(r.playfulness), energy: lvl(r.energy), colour: lvl(r.colour),
        emoji: pick(r.emoji, ['none', 'few', 'auto'] as const, 'auto'),
        exclamations: pick(r.exclamations, ['never', 'rarely', 'auto'] as const, 'auto'),
        spelling: pick(r.spelling, ['british', 'american', 'auto'] as const, 'auto'),
        neverSay: Array.isArray(r.neverSay)
            ? r.neverSay.map((x) => String(x).replace(/\s+/g, ' ').trim().slice(0, 60)).filter(Boolean).slice(0, 60)
            : undefined,
        sample: typeof r.sample === 'string' ? r.sample.trim().slice(0, 1500) : '',
    };
}

/** Phrases from the Never-say list that appear in `text` (case-insensitive). For post-checks. */
export function findNeverSay(text: string, voice?: VoiceSettings | null): string[] {
    const list = voice?.neverSay ?? [];
    const t = String(text || '').toLowerCase();
    return list.filter((p) => p && t.includes(p.toLowerCase()));
}

/** Words that, near a trait word, invert it ("not salesy", "never formal"). Kept deliberately small. */
const NEGATORS = ['not', 'never', 'no', 'avoid', 'avoiding', 'without', 'less', "don't", 'dont', 'non'];

/** Which traits a free-text tone description asks for. Exported for tests. */
export function detectVoiceTraits(toneText: string): string[] {
    const text = String(toneText || '').toLowerCase();
    const tokens = text.split(/[^a-z'-]+/).filter(Boolean);
    const found: string[] = [];
    for (const trait of TRAITS) {
        const hit = tokens.some((tok, i) => {
            if (!trait.words.includes(tok)) return false;
            // "not formal", "avoiding overly corporate language" — a negated trait is not asked for.
            const before = tokens.slice(Math.max(0, i - 3), i);
            return !before.some((b) => NEGATORS.includes(b));
        });
        if (hit) found.push(trait.key);
    }
    return found;
}

const SURFACE_NOUN: Record<VoiceSurface, string> = {
    social: 'post',
    blog: 'article',
    email: 'email',
    outreach: 'email',
    support: 'reply',
};

/**
 * The voice section of a generation prompt. Always returns a block — an empty or unrecognised tone
 * still tells the model to commit to a distinct voice rather than its default register.
 *
 * `fallback` is used only when `toneText` is empty (e.g. 'professional' for a role with no setting).
 */
export function voiceDirective(toneText: unknown, opts: { surface: VoiceSurface; fallback?: string; voice?: unknown }): string {
    const raw = typeof toneText === 'string' ? toneText.trim().slice(0, 300) : '';
    const voice = normaliseVoice(opts.voice);
    const chosen = voice?.personalities ?? [];
    const chosenLabels = TRAITS.filter((t) => chosen.includes(t.key)).map((t) => t.label);
    // With personalities picked, THEY name the voice. The stored tone is kept as extra detail only
    // when it says more than a one-word preset (a setup answer of "Friendly" would otherwise be
    // quoted back after the owner un-ticked Friendly in the builder).
    const rawIsPreset = !raw || raw.split(/\s+/).length <= 2;
    const tone = chosenLabels.length
        ? chosenLabels.join(' and ') + (rawIsPreset ? '' : ` — in their own words: ${raw}`)
        : (raw || opts.fallback || 'friendly and professional');
    const noun = SURFACE_NOUN[opts.surface];
    // Personalities picked in the builder ARE the voice; the free-text / setup tone is only read for
    // traits when none are picked. Merging the two meant un-ticking "Friendly" in the builder did
    // nothing while the setup answer still said "Friendly" (2026-10-06).
    const keys = chosen.length ? chosen : detectVoiceTraits(raw || tone);
    const traits = TRAITS.filter((t) => keys.includes(t.key));

    const lines: string[] = [
        `VOICE — this is a hard requirement, not a suggestion. The owner described the voice as: "${tone}".`,
        `Write so that someone who saw this ${noun} next to one written in a different voice would tell them apart from the first two sentences.`,
        `Do NOT fall back on a generic, polished, mid-length "marketing" register — that default is exactly what this voice setting exists to replace.`,
    ];

    if (traits.length) {
        for (const t of traits) {
            const extra = t.surfaceRules?.[opts.surface] ?? [];
            lines.push(
                '',
                `${t.label.toUpperCase()} means:`,
                ...[...t.rules, ...extra].map((r) => `- ${r}`),
                `- Sounds like: "${t.soundsLike}"`,
                `- Never sounds like: "${t.neverLike}"`,
            );
        }
        if (traits.length > 1) {
            lines.push('', 'Where these pull in different directions, blend them the way the owner\'s own description does — their words decide the balance.');
        }
    } else {
        lines.push(
            '',
            'Before writing, turn that description into four or five CONCRETE habits — typical sentence length, contractions or not, punctuation (exclamation marks? fragments?), emoji or not, humour or not, how the reader is addressed, how the piece ends — and follow them consistently.',
        );
    }

    // The builder's fine-tuning. Each slider at its middle says nothing; either end is a hard rule.
    if (voice) {
        const tuning: string[] = [];
        (['formality', 'playfulness', 'energy', 'colour'] as const).forEach((k) => {
            const rule = SLIDERS[k][voice[k] ?? 3];
            if (rule) tuning.push(rule);
        });
        if (voice.emoji === 'none' && opts.surface !== 'blog') tuning.push('No emoji at all.');
        if (voice.emoji === 'few' && opts.surface === 'social') tuning.push('At most one or two emoji, and only where they add meaning.');
        if (voice.exclamations === 'never') tuning.push('No exclamation marks at all.');
        if (voice.exclamations === 'rarely') tuning.push('At most one exclamation mark in the whole piece.');
        if (voice.spelling === 'british') tuning.push('British English spelling and vocabulary (colour, organise, favourite).');
        if (voice.spelling === 'american') tuning.push('American English spelling and vocabulary (color, organize, favorite).');
        if (tuning.length) {
            lines.push('', 'FINE-TUNING — set by the owner, and these win over anything above:', ...tuning.map((r) => `- ${r}`));
        }
        if (voice.sample) {
            lines.push('', "WRITE LIKE THIS — a sample of the owner's own writing. Match its rhythm, sentence length, vocabulary and attitude. Do NOT copy its words or topic:",
                `<sample>${voice.sample}</sample>`);
        }
    }

    // Never say — exactly the owner's list (empty unless they add to it). This is the part that
    // answers "it sounds cheesy": the clichés they pick are named and banned, not hoped away.
    const never = voice?.neverSay ?? [];
    if (never.length) {
        lines.push('', `NEVER use these words or phrases, or close variants of them: ${never.map((p) => `"${p}"`).join(', ')}. They read as generic AI marketing copy.`);
    }

    lines.push(
        '',
        `VOICE CHECK before you answer: read your opening and closing lines. If they could appear unchanged in a ${noun} with a different voice setting, rewrite them until they could not.`,
    );
    return lines.join('\n');
}
