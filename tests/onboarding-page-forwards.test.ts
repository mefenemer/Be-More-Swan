// tests/onboarding-page-forwards.test.ts
// onboarding.html is an old role picker that never shows a step (#step-1 starts hidden and the
// wizard counts from 2), so anyone sent there saw a blank card. A new sign-up hit it from the
// welcome email's "Set Up My First Assistant" button (2026-11-17). Pins:
//   - onboarding.html forwards to the workspace catalogue before any other script runs
//   - nothing we control links people to onboarding.html any more
//
// Run:  npx tsx tests/onboarding-page-forwards.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const CATALOGUE = '/workspace.html?view=catalog';

// 1. The page forwards first thing in <head>.
{
  const html = read('onboarding.html');
  const head = html.slice(html.indexOf('<head>'), html.indexOf('</head>'));
  const forward = head.indexOf(`window.location.replace('${CATALOGUE}')`);
  assert.ok(forward !== -1, 'onboarding.html must forward to the catalogue');
  const firstScriptSrc = head.indexOf('<script src=');
  assert.ok(firstScriptSrc === -1 || forward < firstScriptSrc, 'the forward must run before any loaded script');
}

// 2. Welcome email + login fallbacks no longer point at the blank page.
{
  const verify = read('netlify/functions/verify.ts');
  assert.ok(verify.includes('`${emailBaseUrl}/workspace.html?view=catalog`'), 'welcome email CTA → catalogue');
  assert.ok(!/['`/]onboarding\.html['`]/.test(verify), 'verify.ts must not redirect to onboarding.html');

  assert.ok(!read('verify-account.html').includes("'/onboarding.html'"), 'verify-account fallback must not be onboarding.html');
  assert.ok(!read('dashboard.html').includes('href="onboarding.html"'), 'dashboard button must not link to onboarding.html');
  assert.ok(!read('assistant-setup.html').includes("replace('onboarding.html')"), 'assistant-setup must not send roles to onboarding.html');
}

// 3. No page links or navigates to onboarding.html (comments may still name it).
{
  const { readdirSync } = require('node:fs') as typeof import('node:fs');
  const navigates = /(href=["']|location\.(href|replace)\b[^;\n]*["'`]|wizard:\s*["'`]|\|\|\s*["'`])\/?onboarding\.html/;
  for (const f of readdirSync(root).filter((n: string) => n.endsWith('.html') && n !== 'onboarding.html')) {
    assert.ok(!navigates.test(read(f)), `${f} still sends people to onboarding.html`);
  }
}

console.log('onboarding-page-forwards: all checks passed');
