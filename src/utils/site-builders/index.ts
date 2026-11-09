// src/utils/site-builders/index.ts — every platform the Website import knows, most specific first
// (Elementor and WooCommerce run on WordPress; Wix Studio is Wix). Add a platform: a file of its own
// and one line here. Each platform's file, test and report are worked on separately.
import type * as cheerio from 'cheerio';
import type { BuilderAdapter } from './types';
import { adapter as elementor } from './elementor';
import { adapter as woocommerce } from './woocommerce';
import { adapter as wordpress } from './wordpress';
import { adapter as wix_studio } from './wix-studio';
import { adapter as wix } from './wix';
import { adapter as squarespace } from './squarespace';
import { adapter as shopify } from './shopify';
import { adapter as webflow } from './webflow';
import { adapter as framer } from './framer';
import { adapter as duda } from './duda';
import { adapter as tilda } from './tilda';
import { adapter as godaddy } from './godaddy';
import { adapter as hostinger } from './hostinger';
import { adapter as weebly } from './weebly';
import { adapter as carrd } from './carrd';
import { adapter as bigcommerce } from './bigcommerce';
import { adapter as magento } from './magento';
import { adapter as hubspot } from './hubspot';
import { adapter as aem } from './aem';
import { adapter as sitecore } from './sitecore';
import { adapter as ghost } from './ghost';
import { adapter as drupal } from './drupal';
import { adapter as joomla } from './joomla';
import { adapter as contentful } from './contentful';
import { adapter as sanity } from './sanity';
import { adapter as strapi } from './strapi';
import { adapter as payload } from './payload';
import { adapter as lovable } from './lovable';
import { adapter as bolt } from './bolt';
import { adapter as v0 } from './v0';
import { adapter as replit } from './replit';
import { adapter as windsurf } from './windsurf';
import { adapter as cursor } from './cursor';
import { adapter as claude_code } from './claude-code';

export const ADAPTERS: readonly BuilderAdapter[] = [elementor, woocommerce, wordpress, wix_studio, wix, squarespace, shopify, webflow, framer, duda, tilda, godaddy, hostinger, weebly, carrd, bigcommerce, magento, hubspot, aem, sitecore, ghost, drupal, joomla, contentful, sanity, strapi, payload, lovable, bolt, v0, replit, windsurf, cursor, claude_code];

/** The platform that made this page, or null. */
export function adapterFor(html: string, $: cheerio.CheerioAPI): BuilderAdapter | null {
    const gen = ($('meta[name="generator"]').attr('content') ?? '').toLowerCase();
    for (const a of ADAPTERS) {
        try { if (a.detect(html, gen, $)) return a; } catch { /* a broken adapter never stops an import */ }
    }
    return null;
}
export type { BuilderAdapter };
