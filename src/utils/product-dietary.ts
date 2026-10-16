// src/utils/product-dietary.ts — dietary markers on a product, for menus. PURE.
// db/z-product-dietary.sql. tests/product-dietary.test.ts.
//
// A closed set, so a marker always means the same thing on every site and to every assistant.
// The owner states them in Business Information ▸ Products & Services; nothing infers them.

export const DIETARY = ['vegetarian', 'vegan', 'gluten_free', 'dairy_free', 'contains_nuts', 'spicy'] as const;
export type Dietary = typeof DIETARY[number];

/** Short mark on the menu, and its meaning in the key. */
export const DIETARY_MARK: Record<Dietary, { mark: string; label: string }> = {
    vegetarian: { mark: 'V', label: 'Vegetarian' },
    vegan: { mark: 'VG', label: 'Vegan' },
    gluten_free: { mark: 'GF', label: 'Gluten-free' },
    dairy_free: { mark: 'DF', label: 'Dairy-free' },
    contains_nuts: { mark: 'N', label: 'Contains nuts' },
    spicy: { mark: '🌶', label: 'Spicy' },
};

export const ALLERGENS_MAX = 200;

/** What may be saved: known markers only, each once, in the set's own order. Vegan implies vegetarian. */
export function cleanDietary(raw: unknown): Dietary[] | null {
    const list = Array.isArray(raw) ? raw.map(String) : [];
    const set = new Set(list.filter((x): x is Dietary => (DIETARY as readonly string[]).includes(x)));
    if (set.has('vegan')) set.delete('vegetarian');   // VG says it; V beside it is noise
    const out = DIETARY.filter((d) => set.has(d));
    return out.length ? out : null;
}

export function cleanAllergens(raw: unknown): string | null {
    const t = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, ALLERGENS_MAX) : '';
    return t || null;
}

/** "VG · GF" — for a menu line. */
export function dietaryMarks(d: unknown): string {
    return (cleanDietary(d) ?? []).map((x) => DIETARY_MARK[x].mark).join(' · ');
}

/** The key under a menu: only the marks that appear on it. */
export function dietaryKey(all: unknown[]): string {
    const used = new Set(all.flatMap((d) => cleanDietary(d) ?? []));
    return DIETARY.filter((d) => used.has(d)).map((d) => `${DIETARY_MARK[d].mark} ${DIETARY_MARK[d].label.toLowerCase()}`).join(' · ');
}

/** For assistants: "vegan, gluten-free". */
export function dietaryWords(d: unknown): string {
    return (cleanDietary(d) ?? []).map((x) => DIETARY_MARK[x].label.toLowerCase()).join(', ');
}
