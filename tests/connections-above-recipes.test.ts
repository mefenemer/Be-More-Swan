// The Connections tab: connect a tool first, then switch on what it does (owner, 2026-11-16). The
// Minute Taker's new Gmail/Outlook rows appeared UNDER its recipes, the opposite of the pattern.
// Run: npx tsx tests/connections-above-recipes.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync('assistant-detail.html', 'utf8');
const tab = html.slice(html.indexOf('<div id="tab-platforms"'), html.indexOf('Emergency: Revoke All Connections'));
const grid = tab.indexOf('<div id="connections-grid"');
const recipes = tab.indexOf('<div id="assistant-integrations-host"');
assert.ok(grid > 0 && recipes > 0, 'both sections are on the Connections tab');
assert.ok(grid < recipes, 'connections come before the recipes');
console.log('connections-above-recipes: all checks passed');
