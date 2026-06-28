/**
 * config.mjs — runtime agency settings (provider, API key, public URL, etc.).
 * Persisted through the STORE layer (MongoDB in prod, filesystem locally) under
 * the key "cms-config.json", so settings saved in the Agency Console survive
 * redeploys on an ephemeral host like Railway. The raw key is stored
 * server-side only; the API never returns it.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { store } from './store.mjs';

const KEY = 'cms-config.json';
const PATH = join(dirname(fileURLToPath(import.meta.url)), '..', KEY);

// In-memory cache so getConfig()/aiCreds()/plannerMode() stay synchronous.
// Seed from a local file if one exists (local dev, before loadConfig runs).
let cfg = readLocal();
function readLocal() { try { return existsSync(PATH) ? JSON.parse(readFileSync(PATH, 'utf8')) : {}; } catch { return {}; } }

/** Hydrate settings from the active store. Call once after initStore(). */
export async function loadConfig() {
  try {
    const fromStore = await store.getJSON(KEY);
    if (fromStore && typeof fromStore === 'object') cfg = fromStore;
  } catch (e) { console.error('[config] load failed:', e.message); }
  return cfg;
}

export function getConfig() { return cfg; }

/** Merge a patch, update the in-memory cache immediately, and persist through
 *  the store. Returns a promise that resolves once the write completes. */
export function setConfig(patch) {
  cfg = { ...cfg, ...patch };
  return Promise.resolve(store.putJSON(KEY, cfg))
    .catch((e) => console.error('[config] persist failed:', e.message))
    .then(() => cfg);
}

/** Effective AI credentials: UI config first, then env fallback.
 *  Default provider is OpenRouter. Set the model with OPENROUTER_MODEL_ID. */
export function aiCreds() {
  const key = cfg.apiKey || process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_API_KEY || '';
  let provider = cfg.provider;
  if (!provider) {
    if (process.env.OPENROUTER_API_KEY) provider = 'openrouter';
    else if (process.env.ANTHROPIC_API_KEY) provider = 'anthropic';
    else provider = key.startsWith('sk-ant') ? 'anthropic' : 'openrouter';
  }
  const model = cfg.model || (provider === 'anthropic'
    ? (process.env.ANTHROPIC_MODEL_ID || 'claude-sonnet-4-6')
    : (process.env.OPENROUTER_MODEL_ID || 'anthropic/claude-sonnet-4.5'));
  return { key, provider: key ? provider : 'local', model };
}
export function plannerMode() { return aiCreds().provider; }
