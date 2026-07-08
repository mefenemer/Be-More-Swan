// detect-currency.ts
// US-I18N-2.1 SC2: Returns the user's likely currency based on Netlify geo-IP headers.
// GET /.netlify/functions/detect-currency
// → { currency: 'GBP' | 'USD' | 'EUR' | 'AUD' | 'CAD' }

import { Handler } from '@netlify/functions';
import { withLambda } from '@netlify/aws-lambda-compat';

// Netlify geo header: x-nf-country (ISO 3166-1 alpha-2 country code)
const COUNTRY_TO_CURRENCY: Record<string, string> = {
    // GBP
    GB: 'GBP', JE: 'GBP', GG: 'GBP', IM: 'GBP',
    // USD
    US: 'USD', EC: 'USD', SV: 'USD', PA: 'USD', PR: 'USD', GU: 'USD', VI: 'USD',
    // EUR — Eurozone members
    DE: 'EUR', FR: 'EUR', IT: 'EUR', ES: 'EUR', NL: 'EUR', BE: 'EUR', AT: 'EUR',
    PT: 'EUR', IE: 'EUR', FI: 'EUR', GR: 'EUR', SK: 'EUR', SI: 'EUR', EE: 'EUR',
    LV: 'EUR', LT: 'EUR', LU: 'EUR', MT: 'EUR', CY: 'EUR', HR: 'EUR',
    // AUD
    AU: 'AUD',
    // CAD
    CA: 'CAD',
};

export default withLambda(async (event) => {
    const country = (
        event.headers['x-nf-country'] ||
        event.headers['x-country'] ||
        event.headers['cf-ipcountry'] ||
        ''
    ).toUpperCase().trim();

    const currency = COUNTRY_TO_CURRENCY[country] || 'GBP';

    return {
        statusCode: 200,
        headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'private, max-age=300',
        },
        body: JSON.stringify({ currency, country: country || null }),
    };
});
