// scripts/gen-vapid-keys.mjs
// Generate the VAPID keypair Web Push needs. Run once per environment:
//
//   node scripts/gen-vapid-keys.mjs
//
// Then set the three values it prints as environment variables. VAPID_PRIVATE_KEY is a secret and
// belongs in the environment, never in the repo.
//
// ⚠️ Staging and production should have DIFFERENT keypairs, and neither should ever change once
// users have subscribed. Every subscription in push_subscriptions is bound to the public key it
// was created with; rotating the pair silently invalidates all of them, and the failure mode is
// silence rather than an error — the push service rejects each message individually and nothing
// reports that the key is the reason. If you must rotate, expire the table in the same change.

import webpush from 'web-push';

const { publicKey, privateKey } = webpush.generateVAPIDKeys();

console.log(`
VAPID keypair generated.

Set these in your environment (Netlify → Site configuration → Environment variables):

  VAPID_PUBLIC_KEY   ${publicKey}
  VAPID_PRIVATE_KEY  ${privateKey}
  VAPID_SUBJECT      mailto:hello@bemoreswan.com

The public key is served to browsers and is safe to expose.
Keep VAPID_PRIVATE_KEY secret, and do not commit it.

Until all three are set, push stays switched off: isPushConfigured() returns false and the
notification fan-out skips the channel entirely rather than erroring.
`);
