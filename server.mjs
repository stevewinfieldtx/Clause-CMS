/**
 * server.mjs — multi-site, MULTI-PAGE, framework-agnostic CMS.
 *
 * A SITE has many PAGES. Each page is a frozen template + content model.
 *   sites/<name>/
 *     site.json                 { order:[slug], home, pages:{slug:{title,path}} }
 *     pages/<slug>/             template.html · content.json · schema.json · meta.json
 *     versions/<seq>.json       immutable snapshot of ALL pages
 *     releases/<seq>/           built static: index.html (home) + <slug>.html
 *     access.json               client magic-link token (hashed)
 *
 * Edits → Guardian → per-page draft → Publish → version (all pages) → static
 * release (atomic pointer). render/guardian/agent/structure are page-agnostic.
 */
import express from 'express';
import { load } from 'cheerio';
import { readFileSync, writeFileSync as _wfs, mkdirSync, readdirSync, existsSync, rmSync as _rm } from 'node:fs';
import { store, initStore, hydrateToFs } from './lib/store.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { render } from './lib/render.mjs';
import { validate } from './lib/guardian.mjs';
import { plan, planTotal, plannerMode } from './lib/agent.mjs';
import { applyTotalOps } from './lib/total.mjs';
import { autotag, autotagSnippet } from './lib/autotag.mjs';
import { applyStructure } from './lib/structure.mjs';
import { deployer } from './lib/deploy.mjs';
import { effectiveSeo, SEO_FIELDS, STYLE_SPEC, sectionList } from './lib/fields.mjs';
import { getConfig, setConfig, aiCreds, loadConfig } from './lib/config.mjs';
import { pushFilesToBranch, mergeBranchToMain, ghToken } from './lib/github.mjs';
import { randomBytes, createHash } from 'node:crypto';

const ADMIN_KEY = process.env.ADMIN_KEY || 'owner-dev';
const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');
const ROOT = dirname(fileURLToPath(import.meta.url));
const SITES_DIR = join(ROOT, 'sites');
mkdirSync(SITES_DIR, { recursive: true });

/* ── persistence mirror ──
   The filesystem stays the fast local working copy. When MongoDB is connected,
   every write/delete under sites/ is mirrored to the DB in real time, and a fresh
   host hydrates from the DB on boot — so the data lives in Mongo, portable across hosts. */
const relOf = (p) => { const s = String(p); if (!s.startsWith(ROOT)) return null; return s.slice(ROOT.length).replace(/^[/\\]/, '').replace(/\\/g, '/'); };
const mirrorable = (rel) => rel && rel.startsWith('sites/') && !rel.includes('/releases/');
// Every mirror write/delete is registered here while in flight, so a handler can
// `await flushMirror()` before responding — guaranteeing the data is durable in
// Mongo before the client is told "ok". Without this, a restart between the local
// write and the (previously fire-and-forget) Mongo write could leave a partial site.
const _mirrorPending = new Set();
function track(pr) { _mirrorPending.add(pr); pr.finally(() => _mirrorPending.delete(pr)); return pr; }
async function flushMirror() { while (_mirrorPending.size) await Promise.allSettled([..._mirrorPending]); }
function mirrorWrite(p) {
  if (store.mode !== 'mongodb') return; const rel = relOf(p); if (!mirrorable(rel)) return;
  track((async () => { try {
    if (rel.endsWith('.json')) await store.putJSON(rel, JSON.parse(readFileSync(p, 'utf8')));
    else if (/\.(html|log|txt)$/.test(rel)) await store.putText(rel, readFileSync(p, 'utf8'));
    else await store.putBuf(rel, readFileSync(p));
  } catch (e) { console.error('[mirror] write', rel, e.message); } })());
}
function mirrorDel(p) { if (store.mode !== 'mongodb') return; const rel = relOf(p); if (!mirrorable(rel)) return; track(store.del(rel).catch((e) => console.error('[mirror] del', rel, e.message))); }
// mirror-aware drop-ins for the real fs calls (every existing call site uses these names unchanged)
function writeFileSync(p, data, opts) { _wfs(p, data, opts); mirrorWrite(p); }
function rmSync(p, opts) { _rm(p, opts); mirrorDel(p); }

const sites = {}; // name -> { pages:{slug:{templateHtml,schema,content,sections,collections}}, order, home, pagesMeta, draft:{slug:state}, versions, head, access }

const siteDir = (name) => join(SITES_DIR, name.replace(/[^a-z0-9_-]/gi, ''));
const pageDir = (name, slug) => join(siteDir(name), 'pages', String(slug).replace(/[^a-z0-9_-]/gi, ''));
const versionsDir = (name) => join(siteDir(name), 'versions');
function withBase(html) { return html.replace('<head>', '<head><base href="/">'); }

/* ───── load / migrate ───── */
function readPage(name, slug) {
  const pd = pageDir(name, slug);
  const meta = existsSync(join(pd, 'meta.json')) ? JSON.parse(readFileSync(join(pd, 'meta.json'), 'utf8')) : {};
  return {
    templateHtml: readFileSync(join(pd, 'template.html'), 'utf8'),
    schema: JSON.parse(readFileSync(join(pd, 'schema.json'), 'utf8')),
    content: JSON.parse(readFileSync(join(pd, 'content.json'), 'utf8')),
    sections: meta.sections || [],
    collections: meta.collections || [],
  };
}
function writePage(name, slug, p) {
  const pd = pageDir(name, slug);
  mkdirSync(pd, { recursive: true });
  writeFileSync(join(pd, 'template.html'), p.templateHtml);
  writeFileSync(join(pd, 'content.json'), JSON.stringify(p.content, null, 2));
  writeFileSync(join(pd, 'schema.json'), JSON.stringify(p.schema, null, 2));
  writeFileSync(join(pd, 'meta.json'), JSON.stringify({ sections: p.sections, collections: p.collections }, null, 2));
}
function writeCfg(name) {
  const s = sites[name];
  writeFileSync(join(siteDir(name), 'site.json'), JSON.stringify({ order: s.order, home: s.home, pages: s.pagesMeta, sourceUrl: s.sourceUrl || null, clarity: s.clarity || null, convai: s.convai || null, totalMode: !!s.totalMode, domain: s.domain || null, embed: s.embed || null, repo: s.repo || null, repoBranch: s.repoBranch || null }, null, 2));
}

/* ───── drafts: staged-but-not-live edits, persisted so a Save survives reload/restart ───── */
const draftFile = (name, slug) => join(pageDir(name, slug), 'draft.json');
function writeDraft(name, slug, state) {
  const pd = pageDir(name, slug); mkdirSync(pd, { recursive: true });
  writeFileSync(draftFile(name, slug), JSON.stringify(state));
  queueRepoSync(name);   // mirror the draft onto the site's working branch
}
function clearDrafts(name) {
  const s = sites[name];
  for (const slug of Object.keys(s.draft)) rmSync(draftFile(name, slug), { force: true });
  s.draft = {};
  delete totalUndo[name]; // draft gone ⇒ nothing left to step back through
}

/* ── Total mode: per-page undo stack (in-memory, capped) ──
   Each entry is the page's draft state BEFORE an AI command (null = there was
   no draft, i.e. the command started from the published page). Cleared whenever
   the draft itself is resolved (publish / discard / restore). */
const totalUndo = {}; // name -> slug -> [prevStateOrNull, ...]
const TOTAL_UNDO_MAX = 20;
function pushTotalUndo(name, slug, prev) {
  const st = ((totalUndo[name] ||= {})[slug] ||= []);
  st.push(prev ? JSON.parse(JSON.stringify(prev)) : null);
  if (st.length > TOTAL_UNDO_MAX) st.shift();
}

// Best-known public base URL for a site (owner can set s.domain; else placeholder).
function siteBase(name) {
  const s = sites[name];
  let b = s.domain || `https://${name}.com`;
  if (!/^https?:\/\//.test(b)) b = 'https://' + b;
  return b.replace(/\/+$/, '');
}
const pagePath = (s, slug) => (slug === s.home ? '/' : `/${slug}`);
// SEO infra: sitemap.xml + robots.txt (auto-generated from the page list).
function sitemapXml(name) {
  const s = sites[name], base = siteBase(name);
  const urls = s.order
    .filter((slug) => (s.pages[slug]?.content?.['seo:robots'] || 'index,follow').indexOf('noindex') === -1)
    .map((slug) => `  <url><loc>${base}${pagePath(s, slug)}</loc></url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}
function robotsTxt(name) {
  return `User-agent: *\nAllow: /\n\nSitemap: ${siteBase(name)}/sitemap.xml\n`;
}
// llms.txt — tells AI engines (ChatGPT, Perplexity, Claude) what to read and cite.
function llmsTxt(name) {
  const s = sites[name], base = siteBase(name);
  const homeSeo = effectiveSeo(s.pages[s.home]?.templateHtml || '', s.pages[s.home]?.content || {});
  const title = s.pages[s.home]?.content?.['seo:orgName'] || homeSeo.title || name;
  const lines = s.order
    .filter((slug) => (s.pages[slug]?.content?.['seo:robots'] || 'index,follow').indexOf('noindex') === -1)
    .map((slug) => {
      const p = s.pages[slug];
      const seo = effectiveSeo(p?.templateHtml || '', p?.content || {});
      return `- [${seo.title || slug}](${base}${pagePath(s, slug)})${seo.description ? `: ${seo.description}` : ''}`;
    });
  return `# ${title}\n${homeSeo.description ? `\n> ${homeSeo.description}\n` : ''}\n## Pages\n\n${lines.join('\n')}\n`;
}

// Old single-page sites → migrate into pages/home and reseed the timeline.
function migrate(name) {
  const dir = siteDir(name);
  if (existsSync(join(dir, 'site.json'))) return;
  if (!existsSync(join(dir, 'template.html'))) return;
  const home = pageDir(name, 'home');
  mkdirSync(home, { recursive: true });
  for (const f of ['template.html', 'content.json', 'schema.json', 'meta.json']) {
    if (existsSync(join(dir, f))) { writeFileSync(join(home, f), readFileSync(join(dir, f))); rmSync(join(dir, f)); }
  }
  writeFileSync(join(dir, 'site.json'), JSON.stringify({ order: ['home'], home: 'home', pages: { home: { title: 'Home', path: '/' } } }, null, 2));
  rmSync(versionsDir(name), { recursive: true, force: true });
  rmSync(join(dir, 'releases'), { recursive: true, force: true });
  rmSync(join(dir, 'head.json'), { force: true });
}

function loadSite(name) {
  const dir = siteDir(name);
  migrate(name);
  if (!existsSync(join(dir, 'site.json'))) return null;
  const cfg = JSON.parse(readFileSync(join(dir, 'site.json'), 'utf8'));
  const pages = {};
  const order = [];
  // Load each page defensively: a missing/corrupt page is skipped, never fatal.
  for (const slug of (cfg.order || [])) {
    try { pages[slug] = readPage(name, slug); order.push(slug); }
    catch (e) { console.error(`Site "${name}": skipping unreadable page "${slug}" — ${e.message}`); }
  }
  if (!order.length) { console.error(`Site "${name}": no readable pages — site skipped.`); return null; }
  const home = order.includes(cfg.home) ? cfg.home : order[0];
  sites[name] = {
    pages, order, home, pagesMeta: cfg.pages, sourceUrl: cfg.sourceUrl || null, clarity: cfg.clarity || null, convai: cfg.convai || null, totalMode: !!cfg.totalMode, domain: cfg.domain || null, embed: cfg.embed || null, repo: cfg.repo || null, repoBranch: cfg.repoBranch || null,
    draft: {}, versions: [], head: -1,
    access: existsSync(join(dir, 'access.json')) ? JSON.parse(readFileSync(join(dir, 'access.json'), 'utf8')) : null,
  };
  for (const slug of order) { const df = draftFile(name, slug); if (existsSync(df)) { try { sites[name].draft[slug] = JSON.parse(readFileSync(df, 'utf8')); } catch {} } }
  loadVersions(name);
  if (deployer.current(dir) == null && sites[name].head >= 0) buildRelease(name, sites[name].head);
  return sites[name];
}

/* ───── the page the editor is working against (draft if staged) ───── */
const pageState = (s, slug) => s.draft[slug] || s.pages[slug];
const hasDraft = (s) => Object.keys(s.draft).length > 0;
const fileFor = (s, slug) => (slug === s.home ? 'index.html' : `${slug}.html`);

// This CMS's own reachable origin — needed ONLY for the one thing a published
// page still legitimately talks to the CMS for: submitting a contact form into
// the shared inbox. (Uploaded images are NOT resolved through this — see
// embedUploadsForRepo below. The CMS is an editing tool, not a runtime
// dependency of the published site.) Auto-detects Railway's own public-domain
// env var; a saved config value (settable via /api/admin/config) always wins.
function cmsPublicUrl() {
  const cfg = getConfig().publicUrl;
  if (cfg) return cfg.replace(/\/+$/, '');
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  return 'http://localhost:4321';
}

// Inject a tiny script so live/deployed forms post submissions back to the CMS inbox.
function wireForms(html, name) {
  const ep = `${cmsPublicUrl()}/api/forms/${name}`;
  const script = `<script>(function(){var EP=${JSON.stringify(ep)};document.querySelectorAll('form').forEach(function(f){f.addEventListener('submit',function(e){e.preventDefault();var d={_page:location.pathname};new FormData(f).forEach(function(v,k){if(typeof v==='string')d[k]=v;});fetch(EP,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)}).then(function(){f.innerHTML='<p style="padding:18px;font-size:16px;text-align:center">✓ Thanks — we\\'ve got your message.</p>';}).catch(function(){});});});})();</script>`;
  return html.includes('</body>') ? html.replace('</body>', script + '</body>') : html + script;
}
// Microsoft Clarity (analytics/heatmaps) is a <script> — stripped at ingest — so we
// inject it at build time, the same seam as wireForms. Resolution order: per-site id →
// global agency config → CLARITY_PROJECT_ID env var. No id configured ⇒ nothing injected.
function clarityId(name) {
  return (sites[name]?.clarity) || getConfig().clarity || process.env.CLARITY_PROJECT_ID || '';
}
function wireClarity(html, name) {
  const id = clarityId(name);
  if (!id) return html;
  const script = `<script type="text/javascript">(function(c,l,a,r,i,t,y){c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);})(window,document,"clarity","script",${JSON.stringify(String(id))});</script>`;
  return html.includes('</head>') ? html.replace('</head>', script + '</head>') : script + html;
}
// ElevenLabs Conversational AI widget — also a <script>, injected at build time.
// Resolution: per-site agent id → global config → ELEVENLABS_AGENT_ID env var.
// The <elevenlabs-convai> web component renders a chat/voice bubble (bottom-right by default).
function convaiId(name) {
  return (sites[name]?.convai) || getConfig().convai || process.env.ELEVENLABS_AGENT_ID || '';
}
function wireConvai(html, name) {
  const id = convaiId(name);
  if (!id) return html;
  const widget = `<elevenlabs-convai agent-id="${String(id).replace(/"/g, '')}"></elevenlabs-convai><script src="https://unpkg.com/@elevenlabs/convai-widget-embed" async type="text/javascript"></script>`;
  return html.includes('</body>') ? html.replace('</body>', widget + '</body>') : html + widget;
}
// Owner-provided embed snippet (e.g. a live-chat widget's <script> tag) —
// injected at build time, same seam as Clarity/ConvAI. Scripts are stripped at
// ingest, so this is how a site keeps its third-party widgets. Owner-only.
function wireEmbed(html, name) {
  const snippet = sites[name]?.embed || '';
  if (!snippet) return html;
  return html.includes('</body>') ? html.replace('</body>', snippet + '</body>') : html + snippet;
}
function pageHtmlFor(name, p) {
  let html = withBase(render(p.templateHtml, p.schema, p.content));
  html = wireForms(html, name);
  html = wireClarity(html, name);
  html = wireConvai(html, name);
  html = wireEmbed(html, name);
  return html;
}
const publishedPageHtml = (name, slug) => pageHtmlFor(name, sites[name].pages[slug]);

/* ── GitHub repo sync ──
   When a site has `repo` set (owner/name), every edit mirrors the rendered
   pages onto a working branch of that repo; Publish merges the branch into
   main, and the repo's host (Railway watching main) redeploys the real site.
   Sync failures never block the CMS — they're audit-logged and reported. */
const repoBranchOf = (s) => s.repoBranch || 'cms-edits';
/* Rendered page files with COLLISION-PROOF names. A crawl can ingest the same
   landing page twice (slug "home" AND slug "index"): both map to index.html,
   and whichever rendered last silently overwrote the real homepage in every
   release and repo push — edits to the homepage then never went live. The
   home page renders first and owns its filename; any other slug that maps to
   an already-taken filename is skipped. */
function renderedPageFiles(name, useDraft) {
  const s = sites[name];
  const files = [];
  const seen = new Set();
  for (const slug of [s.home, ...s.order.filter((x) => x !== s.home)]) {
    if (!s.pages[slug]) continue;
    const path = fileFor(s, slug);
    if (seen.has(path)) continue;
    seen.add(path);
    files.push({ path, content: pageHtmlFor(name, (useDraft && s.draft[slug]) || s.pages[slug]) });
  }
  return files;
}
/* A site pushed to its OWN repo must be able to run with the CMS switched off
   forever — so an uploaded image (stored only in the CMS's own store, at
   /u/<site>/<file>) can never ship as a reference to that path. Instead, every
   uploaded file actually IN USE gets committed into the repo itself (under
   uploads/) and the HTML is rewritten to point at that local copy. */
function siteUploadBytes(name, filename) {
  const p = join(siteDir(name), 'uploads', filename.replace(/[^a-z0-9_.-]/gi, ''));
  return existsSync(p) ? readFileSync(p) : null;
}
function embedUploadsForRepo(name, files) {
  const uploadRe = new RegExp(`/u/${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/([\\w.-]+)`, 'g');
  const seen = new Map(); // filename -> base64 (dedupe across pages)
  const rewritten = files.map((f) => {
    if (f.base64 != null || typeof f.content !== 'string') return f;
    const content = f.content.replace(uploadRe, (whole, fn) => {
      if (!seen.has(fn)) {
        const buf = siteUploadBytes(name, fn);
        seen.set(fn, buf ? buf.toString('base64') : null);
      }
      return seen.get(fn) != null ? `/uploads/${fn}` : whole; // leave unreadable refs as-is rather than break the page
    });
    return { ...f, content };
  });
  for (const [fn, base64] of seen) if (base64 != null) rewritten.push({ path: `uploads/${fn}`, base64 });
  return rewritten;
}
const repoFilesFor = renderedPageFiles;
const _repoTimers = {};
function queueRepoSync(name) {   // debounced: rapid edits become one branch commit
  const s = sites[name];
  if (!s?.repo || !ghToken()) return;
  clearTimeout(_repoTimers[name]);
  _repoTimers[name] = setTimeout(async () => {
    const files = embedUploadsForRepo(name, repoFilesFor(name, true));
    const r = await pushFilesToBranch({ repo: s.repo, branch: repoBranchOf(s), files, message: `CMS: draft sync (${name})` });
    if (!r.ok && !r.skipped) { console.error(`[repo] draft sync ${name}:`, r.error); auditLog(name, { role: 'system', action: 'repo-sync-failed', error: r.error }); }
  }, 4000);
}
async function repoPublish(name, summary) {
  const s = sites[name];
  if (!s?.repo || !ghToken()) return null;
  clearTimeout(_repoTimers[name]);
  const files = embedUploadsForRepo(name, repoFilesFor(name, false));   // published state, not draft
  const msg = `CMS publish: ${summary || name}`;
  const push = await pushFilesToBranch({ repo: s.repo, branch: repoBranchOf(s), files, message: msg });
  if (!push.ok) { auditLog(name, { role: 'system', action: 'repo-publish-failed', error: push.error }); return { ok: false, error: push.error }; }
  const merge = await mergeBranchToMain({ repo: s.repo, branch: repoBranchOf(s), files, message: msg });
  auditLog(name, merge.ok ? { role: 'system', action: 'repo-merged', sha: merge.sha } : { role: 'system', action: 'repo-merge-failed', error: merge.error });
  return merge;
}

/* ───── deploy: build the whole static site for a version ───── */
function buildRelease(name, seq) {
  const files = renderedPageFiles(name, false);
  files.push({ path: 'sitemap.xml', content: sitemapXml(name) });
  files.push({ path: 'robots.txt', content: robotsTxt(name) });
  files.push({ path: 'llms.txt', content: llmsTxt(name) });
  deployer.stage(siteDir(name), seq, files);
  deployer.activate(siteDir(name), seq);
}

/* ───── versions: snapshot ALL pages + site config ───── */
function loadVersions(name) {
  const s = sites[name];
  const dir = versionsDir(name);
  mkdirSync(dir, { recursive: true });
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort((a, b) => parseInt(a) - parseInt(b));
  if (!files.length) { s.versions = []; s.head = -1; saveVersion(name, 'Initial version'); return; }
  s.versions = files.map((f) => { const v = JSON.parse(readFileSync(join(dir, f), 'utf8')); return { seq: v.seq, ts: v.ts, summary: v.summary }; });
  const hp = join(siteDir(name), 'head.json');
  s.head = existsSync(hp) ? JSON.parse(readFileSync(hp, 'utf8')).head : s.versions[s.versions.length - 1].seq;
}

function saveVersion(name, summary) {
  const s = sites[name];
  const dir = versionsDir(name);
  mkdirSync(dir, { recursive: true });
  const seq = (s.versions.length ? Math.max(...s.versions.map((v) => v.seq)) : -1) + 1;
  const pages = {};
  for (const slug of s.order) { const p = s.pages[slug]; pages[slug] = { template: p.templateHtml, schema: p.schema, content: p.content, sections: p.sections, collections: p.collections }; }
  const state = { order: s.order, home: s.home, pagesMeta: s.pagesMeta, pages };
  writeFileSync(join(dir, `${seq}.json`), JSON.stringify({ seq, ts: new Date().toISOString(), summary, state }, null, 2));
  s.versions.push({ seq, ts: new Date().toISOString(), summary });
  s.head = seq;
  writeFileSync(join(siteDir(name), 'head.json'), JSON.stringify({ head: seq }));
  buildRelease(name, seq);
}

function restoreVersion(name, seq) {
  const s = sites[name];
  const f = join(versionsDir(name), `${seq}.json`);
  if (!existsSync(f)) return false;
  const { state } = JSON.parse(readFileSync(f, 'utf8'));
  s.order = state.order; s.home = state.home; s.pagesMeta = state.pagesMeta; s.pages = {}; s.draft = {};
  delete totalUndo[name];
  for (const slug of state.order) {
    const ps = state.pages[slug];
    s.pages[slug] = { templateHtml: ps.template, schema: ps.schema, content: ps.content, sections: ps.sections || [], collections: ps.collections || [] };
    writePage(name, slug, s.pages[slug]);
  }
  writeCfg(name);
  s.head = seq;
  writeFileSync(join(siteDir(name), 'head.json'), JSON.stringify({ head: seq }));
  buildRelease(name, seq);
  return true;
}

function auditLog(name, entry) {
  const p = join(siteDir(name), 'audit.log');
  writeFileSync(p, (existsSync(p) ? readFileSync(p, 'utf8') : '') + JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
}

// boot
{
  const m = await initStore();                       // connect Mongo if MONGODB_URI is set
  if (m.mode === 'mongodb') {
    if (m.migrated) console.log(`MongoDB connected (db: ${m.db}) — migrated ${m.migrated} files from disk on first run.`);
    else { const n = await hydrateToFs(); console.log(`MongoDB connected (db: ${m.db}) — hydrated ${n} files from the database.`); }
  }
  await loadConfig();                                  // load agency settings from the store (survives redeploys)
  for (const d of readdirSync(SITES_DIR, { withFileTypes: true })) if (d.isDirectory()) {
    try { loadSite(d.name); }
    catch (e) { console.error(`Skipping site "${d.name}" — failed to load: ${e.message}`); }
  }
}

/* ───────────────────────────── app ───────────────────────────── */
const app = express();
app.use(express.json({ limit: '16mb' }));
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Security headers. The always-safe set goes on every response; a Content-Security-
// Policy is scoped to the published /live/ sites only — the admin console and editor
// rely on inline + postMessage + contenteditable machinery that a strict CSP would break.
app.use((req, res, next) => {
  res.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  // microphone=(self) so the ElevenLabs voice widget can use the mic on the live sites.
  res.set('Permissions-Policy', 'geolocation=(), microphone=(self), camera=(), interest-cohort=()');
  if (req.path.startsWith('/live/')) res.set('Content-Security-Policy', liveCsp());
  next();
});

// CSP for published sites — used on /live/ paths AND on custom domains.
// interactivechat.up.railway.app is the ChatDesk live-chat widget (chat bubble +
// voice-agent iframe) that client sites embed via their custom snippet.
function liveCsp() {
  const pub = cmsPublicUrl(); // form handler may post here
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://www.clarity.ms https://*.clarity.ms https://unpkg.com https://*.elevenlabs.io https://interactivechat.up.railway.app",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com https://*.elevenlabs.io data:",
    "img-src 'self' data: https:",
    `connect-src 'self' https://*.clarity.ms https://formspree.io https://*.elevenlabs.io wss://*.elevenlabs.io https://interactivechat.up.railway.app${pub ? ' ' + pub : ''}`,
    "media-src 'self' blob: https://*.elevenlabs.io",
    "worker-src 'self' blob:",
    "frame-src 'self' https://www.youtube.com https://player.vimeo.com https://*.elevenlabs.io https://interactivechat.up.railway.app",
    "frame-ancestors 'self'",
    "base-uri 'self'",
    "form-action 'self' https://formspree.io https://interactivechat.up.railway.app",
    'upgrade-insecure-requests',
  ].join('; ');
}

/* ── custom domains: Publish IS the live site ──
   A site with `domain` set is served at that domain's ROOT from its active
   release — point the domain at this Railway service and rainnetworks.com is
   whatever was last published. CMS surfaces (/api, /editor, /admin, /client,
   /u uploads) still work on the custom domain so forms and assets resolve. */
function siteByHost(host) {
  const h = String(host || '').toLowerCase().split(':')[0].replace(/^www\./, '');
  if (!h) return null;
  for (const [name, s] of Object.entries(sites)) {
    if (!s.domain) continue;
    const d = String(s.domain).toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
    if (d === h) return name;
  }
  return null;
}
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const p = req.path;
  if (/^\/(api|u|editor|admin|client|live|s)\b/.test(p)) return next();
  const name = siteByHost(req.headers.host);
  if (!name) return next();
  const file = p === '/' ? 'index.html'
    : /^\/(sitemap\.xml|robots\.txt|llms\.txt)$/.test(p) ? p.slice(1)
    : /^\/[a-z0-9_-]+(\.html)?$/i.test(p) ? p.slice(1).replace(/\.html$/i, '') + '.html'
    : null;
  const body = file && deployer.liveHtml(siteDir(name), file);
  if (!body) return next();
  res.set('Content-Security-Policy', liveCsp());
  res.type(file.endsWith('.xml') ? 'application/xml' : file.endsWith('.txt') ? 'text/plain' : 'html').send(body);
});
app.use('/assets', express.static(join(ROOT, 'site/assets')));
app.use('/editor', express.static(join(ROOT, 'editor')));
app.use('/admin', express.static(join(ROOT, 'admin')));
app.use('/client', express.static(join(ROOT, 'client'))); // per-client front door: pick a page, then edit it

// Root-level well-known files served by the app itself (persist across redeploys —
// they live in the repo's public/ dir, not in the per-site Mongo data).
const servePublic = (rel) => (_req, res) => {
  const p = join(ROOT, 'public', rel);
  if (!existsSync(p)) return res.status(404).type('text/plain').send('Not found');
  res.type('text/plain; charset=utf-8').set('Cache-Control', 'public, max-age=3600').send(readFileSync(p, 'utf8'));
};
app.get('/llms.txt', servePublic('llms.txt'));
app.get('/.well-known/security.txt', servePublic('.well-known/security.txt'));
app.get('/security.txt', servePublic('.well-known/security.txt'));

const get = (req) => req.query.site || req.body?.site;
const pageOf = (req, s) => { const p = req.query.page || req.body?.page || s.home; return s.pages[p] || s.draft[p] ? p : s.home; };
const need = (req, res) => { const s = sites[get(req)]; if (!s) res.status(404).json({ error: `Unknown site "${get(req)}"` }); return s; };
const providedKey = (req) => req.query.key || req.headers['x-edit-key'] || req.body?.key;
const isOwner = (req) => providedKey(req) === ADMIN_KEY;
function authWrite(req, res, next) {
  const s = sites[get(req)];
  if (!s) return next();
  if (isOwner(req)) { req.role = 'owner'; return next(); }
  if (!s.access?.tokenHash) { req.role = 'owner'; return next(); }
  if (providedKey(req) && sha256(providedKey(req)) === s.access.tokenHash) { req.role = 'client'; return next(); }
  return res.status(401).json({ error: 'This site requires a valid editor link.' });
}
function requireOwner(req, res, next) { if (isOwner(req)) return next(); return res.status(401).json({ error: 'Owner key required.' }); }

/* ── per-client capabilities ──
   What a handed-off CLIENT may do beyond editing page content. Default is edit-only;
   the owner grants page add/delete per site from the Agency Console. Owners are unrestricted. */
const DEFAULT_CAPS = { canAddPages: false, canDeletePages: false, canChangeHome: false };
const capsOf = (s) => ({ ...DEFAULT_CAPS, ...(s?.access?.capabilities || {}) });
// Gate a page-management route: clients need the matching capability; owners always pass.
// Runs AFTER authWrite (which sets req.role), so the site is known and the role resolved.
function clientCan(cap) {
  return (req, res, next) => {
    if (req.role === 'client' && !capsOf(sites[get(req)])[cap]) return res.status(403).json({ error: 'Your editor doesn’t allow this — ask the site owner to enable it.' });
    next();
  };
}

/* Simple (Total) preview: NO editing chrome — the page looks exactly like the
   live site. Only page-to-page navigation is intercepted (so clicking the
   site's own nav switches pages inside the editor) and forms are inert. All
   editing happens through the chat. */
function injectNav(html) {
  const overlay = `
<script>
(function(){
  document.querySelectorAll('a').forEach(function(a){a.addEventListener('click',function(e){
    var raw=a.getAttribute('href')||'';
    if(!raw)return e.preventDefault();
    if(raw.charAt(0)==='#')return;                                        // in-page anchor: let it scroll
    e.preventDefault();e.stopPropagation();
    if(/^(mailto:|tel:|javascript:)/i.test(raw))return;
    if(/^https?:\\/\\//i.test(raw)&&raw.indexOf(location.host)===-1)return; // external: inert in preview
    parent.postMessage({type:'cms-nav',href:raw},'*');
  },true);});
  document.querySelectorAll('form').forEach(function(f){f.addEventListener('submit',function(e){e.preventDefault();},true);});
  window.addEventListener('message',function(e){var d=e.data;if(!d)return;
    if(d.type==='scroll-to'){var sc=document.querySelector(d.sel);if(sc)sc.scrollIntoView({behavior:'smooth',block:'start'});}
  });
})();
<\/script>`;
  return html.includes('</body>') ? html.replace('</body>', overlay + '</body>') : html + overlay;
}

function injectEditor(html, schema) {
  const richIds = Object.entries(schema).filter(([, d]) => d.rich).map(([id]) => id);
  const overlay = `
<style id="cms-ee">
  [data-cms]:focus{outline:none !important}
  .cms-edited{}
  .cmsL{position:fixed;pointer-events:none;z-index:2147483600;border:2px solid #0a72ef;border-radius:5px;display:none;transition:all .06s ease}
  .cmsL.sel{border-color:#0a72ef;box-shadow:0 0 0 4px rgba(10,114,239,.16)}
  .cmsTag{position:fixed;pointer-events:none;z-index:2147483601;background:#0a72ef;color:#fff;font:600 11px/1 'Geist',system-ui,sans-serif;padding:4px 8px;border-radius:6px;display:none;white-space:nowrap}
  .cmsBar{position:fixed;z-index:2147483602;display:none;gap:1px;background:#141416;border-radius:10px;padding:4px;box-shadow:0 10px 30px rgba(0,0,0,.5),inset 0 0 0 1px #2c2c32;pointer-events:auto;font-family:'Geist',system-ui,sans-serif}
  .cmsBar button{display:flex;align-items:center;gap:5px;border:0;background:transparent;color:#ededed;height:30px;padding:0 9px;border-radius:7px;cursor:pointer;font-size:12.5px;font-weight:500}
  .cmsBar button:hover{background:#26262b}
  .cmsBar button.rm:hover{background:#ff5b4f;color:#fff}
  .cmsBar .sep{width:1px;align-self:stretch;background:#2c2c32;margin:4px 2px}
  .cmsFlash{position:fixed;pointer-events:none;z-index:2147483599;border:2px solid #27c93f;border-radius:8px;display:none;box-shadow:0 0 0 4px rgba(39,201,63,.18);transition:opacity .4s ease}
  /* section-level selection (click the background of a block) */
  .cmsSect{position:fixed;pointer-events:none;z-index:2147483598;border:2px dashed #a05cf0;border-radius:9px;display:none;background:rgba(160,92,240,.06);transition:all .06s ease}
  .cmsSTag{position:fixed;pointer-events:none;z-index:2147483601;background:#a05cf0;color:#fff;font:600 11px/1 'Geist',system-ui,sans-serif;padding:4px 9px;border-radius:6px;display:none;white-space:nowrap;display:none}
  .cmsSBar{position:fixed;z-index:2147483602;display:none;gap:1px;background:#141416;border-radius:10px;padding:4px;box-shadow:0 10px 30px rgba(0,0,0,.5),inset 0 0 0 1px #2c2c32;pointer-events:auto;font-family:'Geist',system-ui,sans-serif}
  .cmsSBar button{display:flex;align-items:center;gap:5px;border:0;background:transparent;color:#ededed;height:30px;padding:0 10px;border-radius:7px;cursor:pointer;font-size:12.5px;font-weight:500}
  .cmsSBar button:hover{background:#26262b}
</style>
<script>window.__CMS={rich:${JSON.stringify(richIds)}};</script>
<script>(function(){
  var RICH=new Set(window.__CMS.rich);
  function send(id,value){parent.postMessage({type:'cms-edit',id:id,value:value},'*');}
  function isImg(el){return el.hasAttribute('data-cms-img');}
  function isEmbed(el){return el.hasAttribute('data-cms-embed');}
  function idOf(el){return el.getAttribute('data-cms')||el.getAttribute('data-cms-img')||el.getAttribute('data-cms-embed');}
  function selInfo(el){var a=el.closest('a');return {type:'cms-select',id:idOf(el),tag:el.tagName,text:(el.innerText||'').trim(),href:a?(a.getAttribute('href')||''):null,img:isImg(el),embed:isEmbed(el)};}
  function kind(el){var t=el.tagName.toLowerCase();if(isImg(el))return el.tagName==='VIDEO'?'Video':'Image';if(isEmbed(el))return 'Video embed';if(/^h[1-6]$/.test(t))return 'Heading';if(t==='a')return 'Link';if(t==='button'||el.closest('button'))return 'Button';if(t==='li')return 'List item';if(t==='blockquote')return 'Quote';return 'Text';}
  // floating chrome (portal — robust over any site CSS)
  var box=document.createElement('div');box.className='cmsL';
  var tag=document.createElement('div');tag.className='cmsTag';
  var bar=document.createElement('div');bar.className='cmsBar';
  var flash=document.createElement('div');flash.className='cmsFlash';
  var sbox=document.createElement('div');sbox.className='cmsSect';
  var stag=document.createElement('div');stag.className='cmsSTag';
  var sbar=document.createElement('div');sbar.className='cmsSBar';
  document.documentElement.appendChild(box);document.documentElement.appendChild(tag);document.documentElement.appendChild(bar);document.documentElement.appendChild(flash);
  document.documentElement.appendChild(sbox);document.documentElement.appendChild(stag);document.documentElement.appendChild(sbar);
  // sections = the same blocks the Sections navigator uses
  var SECTIONS=[].slice.call(document.querySelectorAll('header, main > section, body > section, section, footer')).filter(function(el){return el.offsetHeight>40;});
  var csec=null;
  function sectionOf(el){var n=el;while(n&&n!==document.body){if(SECTIONS.indexOf(n)>-1)return n;n=n.parentElement;}return null;}
  function sectionLabel(sec){var t=sec.tagName.toLowerCase();if(t==='header')return 'Header';if(t==='footer')return 'Footer';var h=sec.querySelector('h1,h2,h3');if(h&&(h.innerText||'').trim())return (h.innerText||'').trim().slice(0,42);if(sec.id)return sec.id.replace(/[-_]/g,' ');return 'Section';}
  function clearSection(){csec=null;sbox.style.display='none';stag.style.display='none';sbar.style.display='none';}
  function placeSection(){if(!csec)return;var r=csec.getBoundingClientRect();sbox.style.display='block';sbox.style.left=(r.left-2)+'px';sbox.style.top=(r.top-2)+'px';sbox.style.width=(r.width)+'px';sbox.style.height=(r.height)+'px';
    var bh=sbar.offsetHeight||38;var top=r.top>bh+30?(r.top-bh-10):(r.top+10);
    stag.style.display='block';stag.textContent='◳ '+sectionLabel(csec);stag.style.left=(r.left)+'px';stag.style.top=Math.max(6,top-2)+'px';
    sbar.style.display='flex';sbar.style.top=Math.max(6,top)+'px';sbar.style.left=Math.min(r.left+96,window.innerWidth-sbar.offsetWidth-8)+'px';}
  function selectSection(sec){deselect();csec=sec;sbar.innerHTML='';
    var b=document.createElement('button');b.innerHTML='✎ Edit this section';b.onclick=function(e){e.preventDefault();e.stopPropagation();var first=sec.querySelector('[data-cms],[data-cms-img],[data-cms-embed]');if(first){clearSection();select(first);first.scrollIntoView&&0;}};sbar.appendChild(b);
    var ab=document.createElement('button');ab.innerHTML='＋ Add block';ab.onclick=function(e){e.preventDefault();e.stopPropagation();var sel=sec.id?'#'+sec.id:sec.tagName.toLowerCase();parent.postMessage({type:'cms-add-block',section:sel,label:sectionLabel(sec)},'*');};sbar.appendChild(ab);
    placeSection();parent.postMessage({type:'cms-section',label:sectionLabel(sec)},'*');}
  function flashEl(el){if(!el)return;var r=el.getBoundingClientRect();flash.style.display='block';flash.style.opacity='1';flash.style.left=(r.left-3)+'px';flash.style.top=(r.top-3)+'px';flash.style.width=(r.width+2)+'px';flash.style.height=(r.height+2)+'px';clearTimeout(flash._t);flash._t=setTimeout(function(){flash.style.opacity='0';setTimeout(function(){flash.style.display='none';},400);},1000);}
  var current=null;
  function showHover(el){if(el===current)return;var r=el.getBoundingClientRect();box.classList.remove('sel');box.style.display='block';box.style.left=(r.left-2)+'px';box.style.top=(r.top-2)+'px';box.style.width=r.width+'px';box.style.height=r.height+'px';tag.style.display='block';tag.textContent=kind(el);tag.style.left=r.left+'px';tag.style.top=Math.max(2,r.top-23)+'px';}
  function hideHover(){if(!current){box.style.display='none';tag.style.display='none';}}
  function colItems(col){return [].slice.call(document.querySelectorAll('[data-cms-item="'+col+'"]'));}
  function placeSel(){if(!current)return;var r=current.getBoundingClientRect();box.classList.add('sel');box.style.display='block';box.style.left=(r.left-2)+'px';box.style.top=(r.top-2)+'px';box.style.width=r.width+'px';box.style.height=r.height+'px';
    var bh=bar.offsetHeight||38,bw=bar.offsetWidth||190;
    // toolbar ABOVE the element with a gap; flip BELOW only when too near the top (so it never sits over the page nav)
    var above=r.top>bh+58;var top=above?(r.top-bh-12):(r.bottom+12);
    var left=Math.min(Math.max(8,r.left),window.innerWidth-bw-8);
    bar.style.display='flex';bar.style.top=Math.max(8,top)+'px';bar.style.left=left+'px';
    // the kind tag rides with the toolbar so they don't both cover the element
    tag.style.display='block';tag.textContent=kind(current);tag.style.left=left+'px';tag.style.top=(above?top-19:top+bh+3)+'px';}
  function buildBar(el){
    bar.innerHTML='';
    function add(label,fn,cls){var b=document.createElement('button');b.innerHTML=label;if(cls)b.className=cls;b.onclick=function(e){e.preventDefault();e.stopPropagation();fn();};bar.appendChild(b);}
    function sep(){var s=document.createElement('span');s.className='sep';bar.appendChild(s);}
    if(isImg(el))add('🖼 Replace',function(){parent.postMessage({type:'cms-open',panel:'image',id:idOf(el)},'*');});
    else if(isEmbed(el))add('🎬 Replace',function(){parent.postMessage({type:'cms-open',panel:'embed',id:idOf(el)},'*');});
    else add('✎ Edit',function(){el.focus();});
    if(el.closest('a'))add('🔗 Link',function(){parent.postMessage({type:'cms-open',panel:'link',id:idOf(el)},'*');});
    add('↕ Style',function(){parent.postMessage({type:'cms-open',panel:'style',id:idOf(el)},'*');});
    var item=el.closest('[data-cms-item]');
    if(item&&!item.hasAttribute('data-cms')){var col=item.getAttribute('data-cms-item');sep();
      add('⧉ Duplicate',function(){parent.postMessage({type:'cms-structure',op:'add_item',col:col,index:colItems(col).indexOf(item)},'*');});
      add('🗑',function(){parent.postMessage({type:'cms-structure',op:'remove_item',col:col,index:colItems(col).indexOf(item)},'*');},'rm');
    }
  }
  function deselect(){current=null;box.style.display='none';tag.style.display='none';bar.style.display='none';document.querySelectorAll('.cms-sel').forEach(function(x){x.classList.remove('cms-sel');});parent.postMessage({type:'cms-deselect'},'*');}
  function select(el){clearSection();document.querySelectorAll('.cms-sel').forEach(function(x){x.classList.remove('cms-sel');});current=el;el.classList&&el.classList.add('cms-sel');buildBar(el);placeSel();parent.postMessage(selInfo(el),'*');}
  // click the background of a block → highlight that whole section; click truly-empty space → deselect
  document.addEventListener('mousedown',function(e){
    // an embed's own iframe is pointer-events:none in edit mode, so a click on it
    // lands on its wrapper — a descendant check catches that case too.
    if(e.target.closest('[data-cms],[data-cms-img],[data-cms-embed]')||e.target.querySelector('[data-cms-embed]')||e.target.closest('.cmsBar')||e.target.closest('.cmsSBar'))return;
    var sec=sectionOf(e.target);
    if(sec){selectSection(sec);}else{deselect();clearSection();}
  },true);
  // hover + click wiring
  document.querySelectorAll('[data-cms],[data-cms-img],[data-cms-embed]').forEach(function(el){
    if(isEmbed(el)){
      // A click landing on a cross-origin video iframe's own rendered surface (the
      // player) is delivered to THAT document, never to our click listener on the
      // <iframe> element — so it can never be selected by clicking it directly.
      // Disable pointer-events on the iframe itself (edit-mode preview only) so the
      // click lands on its wrapper instead, which we CAN listen on.
      el.style.pointerEvents='none';
      var host=el.parentElement||el;
      host.style.cursor='pointer';
      host.addEventListener('mouseenter',function(){showHover(el);});
      host.addEventListener('mouseleave',hideHover);
      host.addEventListener('click',function(e){e.preventDefault();select(el);});
      return;
    }
    el.addEventListener('mouseenter',function(){showHover(el);});
    el.addEventListener('mouseleave',hideHover);
    if(isImg(el)){el.style.cursor='pointer';el.addEventListener('click',function(e){e.preventDefault();select(el);});}
  });
  document.querySelectorAll('[data-cms]').forEach(function(el){
    var id=el.getAttribute('data-cms');
    el.setAttribute('contenteditable', RICH.has(id)?'true':'plaintext-only');
    el.addEventListener('focus',function(){select(el);});
    el.addEventListener('click',function(){select(el);});
    el.addEventListener('keydown',function(e){if(e.key==='Enter'&&!RICH.has(id)){e.preventDefault();el.blur();}if(e.key==='Escape')el.blur();});
    el.addEventListener('input',placeSel);
    el.addEventListener('blur',function(){el.classList.add('cms-edited');send(id,RICH.has(id)?el.innerHTML:el.innerText);});
  });
  // links to other pages navigate; other links just select for editing.
  // Runs on capture, so an editable element NESTED inside this anchor (e.g. a
  // card image inside <a class="card">) must be excluded first — otherwise this
  // fires and stops propagation before the event ever reaches that descendant's
  // own click handler, and it can never be selected at all.
  document.querySelectorAll('a').forEach(function(a){a.addEventListener('click',function(e){var editable=e.target.closest('[data-cms],[data-cms-img],[data-cms-embed]')||(e.target.querySelector&&e.target.querySelector('[data-cms-embed]'));if(editable&&editable!==a)return;var raw=a.getAttribute('href')||'';e.preventDefault();e.stopPropagation();if(!raw||raw.charAt(0)==='#'||/^(mailto:|tel:|javascript:)/i.test(raw))return;if(/^https?:\\/\\//i.test(raw)&&raw.indexOf(location.host)===-1)return;parent.postMessage({type:'cms-nav',href:raw},'*');},true);});
  document.querySelectorAll('button[id],form').forEach(function(el){el.addEventListener('click',function(e){if(!e.target.closest('[data-cms-img]'))e.preventDefault();},true);});
  window.addEventListener('scroll',function(){hideHover();placeSel();placeSection();},true);
  window.addEventListener('resize',function(){placeSel();placeSection();});
  window.addEventListener('message',function(e){var d=e.data;if(!d)return;
    if(d.type==='apply-style'){var el=document.querySelector('[data-cms="'+d.id+'"],[data-cms-img="'+d.id+'"],[data-cms-embed="'+d.id+'"]');if(!el)return;if(d.value==='')el.style.removeProperty(d.css);else el.style.setProperty(d.css,d.value);el.classList.add('cms-edited');placeSel();}
    if(d.type==='set-text'){var t=document.querySelector('[data-cms="'+d.id+'"]');if(t){t.innerText=d.value;t.classList.add('cms-edited');placeSel();}}
    if(d.type==='set-img'){var im=document.querySelector('[data-cms-img="'+d.id+'"]');if(im){im.setAttribute(im.tagName==='VIDEO'?'poster':'src',d.value);im.classList.add('cms-edited');placeSel();}}
    if(d.type==='set-embed'){var em=document.querySelector('[data-cms-embed="'+d.id+'"]');if(em){em.setAttribute('src',d.value);em.classList.add('cms-edited');placeSel();}}
    if(d.type==='focus-el'){var f=document.querySelector('[data-cms="'+d.id+'"],[data-cms-img="'+d.id+'"],[data-cms-embed="'+d.id+'"]');if(f)select(f);}
    if(d.type==='scroll-to'){var sc=document.querySelector(d.sel);if(sc){var top=0,n=sc;while(n){top+=n.offsetTop||0;n=n.offsetParent;}var se=document.scrollingElement||document.documentElement;se.scrollTop=Math.max(0,top-16);setTimeout(function(){flashEl(sc);},40);}}
    if(d.type==='flash'){(d.ids||[]).forEach(function(id){flashEl(document.querySelector('[data-cms="'+id+'"],[data-cms-img="'+id+'"],[data-cms-embed="'+id+'"]'));});}
    if(d.type==='select-in'){var sec=document.querySelector(d.sel);if(sec){var first=sec.querySelector('[data-cms],[data-cms-img],[data-cms-embed]')||(sec.matches('[data-cms],[data-cms-img],[data-cms-embed]')?sec:null);if(first)select(first);}}
    if(d.type==='exec-format'&&current&&RICH.has(idOf(current))){current.focus();document.execCommand(d.cmd,false,null);send(idOf(current),current.innerHTML);}
    if(d.type==='deselect'){deselect();clearSection();}
  });
})();</script>`;
  return html.replace('</body>', overlay + '</body>');
}

// Owner's home base is the Agency Console. (Clients reach the editor via the
// per-site link the owner shares, not the bare root.)
app.get('/', (_req, res) => res.redirect('/admin/'));

// LIVE site (static release). Home + each page.
app.get('/live/:name', (req, res) => {
  if (!sites[req.params.name]) return res.status(404).send('Unknown site');
  const html = deployer.liveHtml(siteDir(req.params.name), 'index.html');
  res.type('html').send(html || 'Not published yet');
});
// SEO infra files, served from the active release. Declared before the :slug
// catch-all so "sitemap.xml" is never treated as a page slug.
for (const [file, mime] of [['sitemap.xml', 'application/xml'], ['robots.txt', 'text/plain'], ['llms.txt', 'text/plain']]) {
  app.get(`/live/:name/${file}`, (req, res) => {
    if (!sites[req.params.name]) return res.status(404).send('Unknown site');
    const body = deployer.liveHtml(siteDir(req.params.name), file);
    if (!body) return res.status(404).send('Not published yet');
    res.type(mime).send(body);
  });
}
app.get('/live/:name/:slug', (req, res) => {
  if (!sites[req.params.name]) return res.status(404).send('Unknown site');
  const html = deployer.liveHtml(siteDir(req.params.name), `${req.params.slug.replace(/[^a-z0-9_-]/gi, '')}.html`);
  if (!html) return res.status(404).send('No such page');
  res.type('html').send(html);
});

// Editable preview of a page.
app.get('/s/:name', (req, res) => {
  const s = sites[req.params.name];
  if (!s) return res.status(404).send('Unknown site');
  const slug = s.pages[req.query.page] ? req.query.page : s.home;
  const a = pageState(s, slug);
  let html = withBase(render(a.templateHtml, a.schema, a.content));
  if (req.query.edit) html = injectEditor(html, a.schema);
  res.type('html').send(html);
});

app.get('/api/sites', (_req, res) => res.json({
  plannerMode: plannerMode(),
  sites: Object.keys(sites).map((name) => {
    const s = sites[name];
    return { name, pages: s.order.length, handedOff: !!s.access?.tokenHash, authMode: s.access?.mode || (s.access?.tokenHash ? 'link' : null), client: s.access?.clientName || null, requireApproval: !!s.access?.requireApproval, capabilities: capsOf(s), totalMode: !!s.totalMode, domain: s.domain || null, hasEmbed: !!s.embed, repo: s.repo || null, sourceUrl: s.sourceUrl || null, versions: s.versions.length };
  }),
}));

// Who am I? owner (agency, sees all sites) vs client (one site, simple editor).
app.get('/api/me', (req, res) => {
  const s = sites[get(req)];
  const key = providedKey(req);
  let role = 'none';
  if (key === ADMIN_KEY) role = 'owner';
  else if (s && s.access?.tokenHash && key && sha256(key) === s.access.tokenHash) role = 'client';
  else if (s && !s.access?.tokenHash) role = 'owner'; // not handed off yet → dev/owner
  // 'locked' = the site has a password set but no/wrong key was given → show the login gate
  const locked = role === 'none' && !!(s && s.access?.tokenHash);
  // Capabilities the UI should honour: owners are unrestricted; clients get the site's grants.
  const capabilities = role === 'owner' ? { canAddPages: true, canDeletePages: true, canChangeHome: true } : capsOf(s);
  res.json({ role, locked, hasAccess: !!(s && s.access?.tokenHash), requireApproval: !!(s && s.access?.requireApproval), clientName: s?.access?.clientName || null, capabilities, totalMode: !!s?.totalMode, mustChangePassword: role === 'client' && !!s?.access?.mustChangePassword, site: get(req), plannerMode: plannerMode() });
});

app.get('/api/pages', (req, res) => {
  const s = need(req, res); if (!s) return;
  res.json({ order: s.order, home: s.home, pages: s.order.map((slug) => ({ slug, ...s.pagesMeta[slug], home: slug === s.home, dirty: !!s.draft[slug] })) });
});

/* ───── multi-page import: find same-origin pages linked from a page, import each as an editable page ───── */
const ASSET_RE = /\.(jpg|jpeg|png|gif|svg|webp|avif|mp4|webm|mov|css|js|mjs|json|xml|ico|pdf|zip|rar|woff2?|ttf|eot|txt|csv)(\?|#|$)/i;
function discoverLinks(html, baseUrl) {
  let origin, homePath;
  try { const b = new URL(baseUrl); origin = b.origin; homePath = b.pathname; } catch { return []; }
  const $ = load(html, { decodeEntities: false });
  const seen = new Set(), out = [];
  $('a[href]').each((_, el) => {
    let href = ($(el).attr('href') || '').trim();
    if (!href || /^(mailto:|tel:|javascript:|#)/i.test(href)) return;
    let u; try { u = new URL(href, baseUrl); } catch { return; }
    if (u.origin !== origin || ASSET_RE.test(u.pathname)) return;
    u.hash = ''; u.search = '';
    if (u.pathname === homePath || u.pathname === '/' || seen.has(u.pathname)) return;
    seen.add(u.pathname); out.push(u.toString());
  });
  return out;
}
function slugFromUrl(u) {
  try { const base = (new URL(u).pathname.split('/').filter(Boolean).pop() || 'page').replace(/\.html?$/i, '');
    return base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'page'; } catch { return 'page'; }
}
function titleFromHtml(html, slug) {
  try { const $ = load(html);
    const h1 = ($('h1').first().text() || '').trim();
    if (h1 && h1.length <= 70) return h1.slice(0, 60);
    const t = ($('title').first().text() || '').trim();
    if (t) return (t.split(/[|–—\-·]/)[0].trim() || t).slice(0, 60);
  } catch {}
  return slug.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
// Fetch a URL and append it to an existing site as a new editable page (skips if the slug already exists).
async function importUrlAsPage(name, url) {
  const s = sites[name];
  const slug = slugFromUrl(url);
  if (s.pages[slug]) return { slug, skipped: true };
  const r = await fetch(url); if (!r.ok) throw new Error('HTTP ' + r.status);
  const html = await r.text();
  const { templateHtml, content, schema, sections, collections } = autotag(html, url);
  s.pages[slug] = { templateHtml, content, schema, sections, collections };
  s.order.push(slug);
  s.pagesMeta[slug] = { title: titleFromHtml(html, slug), path: `/${slug}` };
  writePage(name, slug, s.pages[slug]);
  return { slug, title: s.pagesMeta[slug].title };
}

app.post('/api/ingest', requireOwner, async (req, res) => {
  const name = String(req.body?.name || '').replace(/[^a-z0-9_-]/gi, '');
  if (!name) return res.status(400).json({ error: 'Need a site name.' });
  let html = req.body?.html, baseUrl = req.body?.baseUrl;
  if (!html && req.body?.url) {                               // fetch the built site server-side
    try { const u = String(req.body.url); const r = await fetch(u); if (!r.ok) throw new Error('HTTP ' + r.status); html = await r.text(); baseUrl = baseUrl || u; }
    catch (e) { return res.status(400).json({ error: 'Could not fetch that URL — ' + e.message }); }
  }
  if (!html) return res.status(400).json({ error: 'Provide a URL or paste the page HTML.' });
  // Duplicate guard: don't silently overwrite a same-named site, and don't re-capture a URL
  // that's already in the CMS under another name. The admin UI re-sends with force:true to confirm.
  if (!req.body?.force) {
    if (sites[name]) return res.status(409).json({ duplicate: 'name', existing: name, error: `A site named "${name}" already exists (${sites[name].order.length} page${sites[name].order.length !== 1 ? 's' : ''}). Re-ingesting replaces it and wipes its edit history and client access.` });
    const norm = (u) => String(u || '').trim().replace(/[#?].*$/, '').replace(/\/(index\.html?)?$/i, '').replace(/\/+$/, '').toLowerCase();
    if (baseUrl) { const hit = Object.keys(sites).find((n) => sites[n].sourceUrl && norm(sites[n].sourceUrl) === norm(baseUrl)); if (hit) return res.status(409).json({ duplicate: 'url', existing: hit, error: `This URL is already captured as "${hit}". Use "Import linked pages" on that site to add pages, instead of creating a duplicate.` }); }
  }
  const { templateHtml, content, schema, sections, collections } = autotag(html, baseUrl);
  const dir = siteDir(name);
  rmSync(dir, { recursive: true, force: true }); // fresh site
  writePage(name, 'home', { templateHtml, content, schema, sections, collections });
  sites[name] = { pages: {}, order: ['home'], home: 'home', pagesMeta: { home: { title: req.body?.title || 'Home', path: '/' } }, sourceUrl: baseUrl || null, draft: {}, versions: [], head: -1, access: null };
  writeCfg(name);
  loadSite(name);
  // Optional crawl: pull in every same-origin page linked from the home page, each fully editable.
  let imported = 0;
  if (req.body?.crawl && baseUrl) {
    const links = discoverLinks(html, baseUrl).slice(0, 60);
    for (const url of links) { try { const p = await importUrlAsPage(name, url); if (!p.skipped) imported++; } catch {} }
    if (imported) { writeCfg(name); saveVersion(name, `ingested + ${imported} linked pages`); }
  }
  await flushMirror();   // make the whole site durable in Mongo before we report success
  res.json({ ok: true, name, pages: 1 + imported, fields: Object.keys(schema).length, collections: collections.length });
});

// Crawl an existing site's home page for same-origin links and import each as an editable page (additive).
app.post('/api/pages/import-linked', requireOwner, async (req, res) => {
  const name = String(req.body?.site || '').replace(/[^a-z0-9_-]/gi, '');
  const s = sites[name]; if (!s) return res.status(404).json({ error: 'Unknown site.' });
  const src = String(req.body?.url || s.sourceUrl || '').trim();
  if (!src) return res.status(400).json({ error: 'Provide the site’s home page URL to scan for pages.' });
  let homeHtml;
  try { const r = await fetch(src); if (!r.ok) throw new Error('HTTP ' + r.status); homeHtml = await r.text(); }
  catch (e) { return res.status(400).json({ error: 'Could not fetch ' + src + ' — ' + e.message }); }
  const max = Math.min(Number(req.body?.max) || 40, 60);
  const links = discoverLinks(homeHtml, src).slice(0, max);
  const added = [], skipped = [], failed = [];
  for (const url of links) {
    try { const p = await importUrlAsPage(name, url); (p.skipped ? skipped : added).push(p.slug); }
    catch (e) { failed.push({ url, error: e.message }); }
  }
  s.sourceUrl = src; writeCfg(name);
  if (added.length) saveVersion(name, `imported ${added.length} linked page${added.length > 1 ? 's' : ''}`);
  auditLog(name, { role: 'owner', action: 'import-linked', added: added.length, skipped: skipped.length, failed: failed.length });
  await flushMirror();   // make every imported page durable in Mongo before we report success
  res.json({ ok: true, added, skipped, failed, scanned: links.length });
});

// Pull ONE specific URL in as a new page (recovery path for a page that was deleted from the
// CMS, or never got picked up by a linked-page crawl — e.g. a homepage that isn't itself
// linked-to from anywhere on its own site). Skips if the derived slug already exists.
app.post('/api/pages/import', requireOwner, async (req, res) => {
  const name = String(req.body?.site || '').replace(/[^a-z0-9_-]/gi, '');
  const s = sites[name]; if (!s) return res.status(404).json({ error: 'Unknown site.' });
  const url = String(req.body?.url || '').trim();
  if (!url) return res.status(400).json({ error: 'Provide the page URL to import.' });
  let p;
  try { p = await importUrlAsPage(name, url); }
  catch (e) { return res.status(400).json({ error: 'Could not import ' + url + ' — ' + e.message }); }
  if (p.skipped) return res.status(409).json({ error: `A page with slug "${p.slug}" already exists — delete or rename it first.` });
  writeCfg(name);
  saveVersion(name, `imported page "${p.slug}"`);
  auditLog(name, { role: 'owner', action: 'import-page', slug: p.slug, url });
  await flushMirror();
  res.json({ ok: true, slug: p.slug, title: p.title });
});

// Re-fetch ONE existing page's live HTML and re-autotag it — picks up new sections/images
// the live site gained since it was first imported. Unlike /api/ingest, this never touches
// s.access, s.home, s.order, other pages, capabilities, or version history — it only replaces
// this page's own template/content/schema. Field ids are re-derived from document order, so
// any unpublished draft for this page is discarded (it would point at stale ids).
app.post('/api/pages/refresh', requireOwner, async (req, res) => {
  const name = String(req.body?.site || '').replace(/[^a-z0-9_-]/gi, '');
  const s = sites[name]; if (!s) return res.status(404).json({ error: 'Unknown site.' });
  const slug = req.body?.slug;
  if (!s.pages[slug]) return res.status(404).json({ error: 'No such page.' });
  let url = req.body?.url;
  if (!url) {
    if (!s.sourceUrl) return res.status(400).json({ error: 'This site has no source URL — pass one explicitly.' });
    if (slug === s.home) url = s.sourceUrl;
    else { try { url = new URL(`${slug}.html`, s.sourceUrl).href; } catch { return res.status(400).json({ error: 'Could not derive a source URL for this page — pass one explicitly.' }); } }
  }
  let html;
  try { const r = await fetch(url); if (!r.ok) throw new Error('HTTP ' + r.status); html = await r.text(); }
  catch (e) { return res.status(400).json({ error: 'Could not fetch ' + url + ' — ' + e.message }); }
  const { templateHtml, content, schema, sections, collections } = autotag(html, url);
  s.pages[slug] = { templateHtml, content, schema, sections, collections };
  delete s.draft[slug];
  writePage(name, slug, s.pages[slug]);
  saveVersion(name, `refreshed "${slug}" from source`);
  auditLog(name, { role: 'owner', action: 'refresh-page', slug, url });
  await flushMirror();
  res.json({ ok: true, slug, url, fields: Object.keys(schema).length, collections: collections.length });
});

app.get('/api/state', (req, res) => {
  const s = need(req, res); if (!s) return;
  const slug = pageOf(req, s);
  const a = pageState(s, slug);
  const groups = {};
  for (const [id, d] of Object.entries(a.schema)) (groups[d.group] ||= []).push({ id, ...d, value: a.content[id] });
  // overlay any pending seo:* values so the panel reflects unsaved edits
  const seo = effectiveSeo(a.templateHtml, a.content);
  res.json({ plannerMode: plannerMode(), site: get(req), page: slug, groups, fieldCount: Object.keys(a.schema).length, collections: a.collections, dirty: !!s.draft[slug], seo, seoFields: SEO_FIELDS, styleSpec: STYLE_SPEC, sections: sectionList(a.templateHtml) });
});

app.post('/api/plan', authWrite, async (req, res) => {
  const s = need(req, res); if (!s) return;
  const a = pageState(s, pageOf(req, s));
  const command = String(req.body?.command || '').trim();
  if (!command) return res.status(400).json({ error: 'Empty command.' });
  // Last few turns for this page, so follow-ups like "make it bigger" resolve against
  // what was just discussed. Client sends its own rolling log; trust but cap it server-side.
  const history = Array.isArray(req.body?.history)
    ? req.body.history.slice(-8).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '').slice(0, 2000) }))
    : [];
  const { summary, changeset } = await plan(command, a.content, a.schema, history);
  const g = validate(changeset, a);
  res.json({ summary, plannerMode: plannerMode(), diff: g.diff, candidate: g.candidate, ok: g.ok, errors: g.errors, warnings: g.warnings });
});

/* ── Total mode: AI command → sanitized ops → applied straight to the DRAFT ──
   The client sees the change in the preview immediately; undo is one click;
   nothing goes live until Publish (which stays the versioned release flow). */
const totalUsage = {}; // `${site}:${yyyy-mm-dd}` -> count (in-memory; resets on redeploy)
function totalBudgetLeft(name) {
  const limit = Number(getConfig().totalDailyLimit) || 100;
  const key = `${name}:${new Date().toISOString().slice(0, 10)}`;
  return { key, left: limit - (totalUsage[key] || 0), limit };
}

app.post('/api/total', authWrite, async (req, res) => {
  const s = need(req, res); if (!s) return;
  if (!s.totalMode) return res.status(403).json({ error: 'Total mode is not enabled for this site.' });
  const command = String(req.body?.command || '').trim();
  if (!command) return res.status(400).json({ error: 'Empty command.' });
  const budget = totalBudgetLeft(get(req));
  if (req.role === 'client' && budget.left <= 0) return res.status(429).json({ error: `Daily AI limit reached (${budget.limit} commands). It resets tomorrow — or ask the site owner to raise it.` });

  const slug = pageOf(req, s);
  const base = s.draft[slug] || s.pages[slug];
  const history = Array.isArray(req.body?.history)
    ? req.body.history.slice(-8).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '').slice(0, 2000) }))
    : [];

  const { summary, ops } = await planTotal(command, base, history);
  totalUsage[budget.key] = (totalUsage[budget.key] || 0) + 1;
  if (!ops.length) return res.json({ ok: false, summary, errors: [] });

  const r = applyTotalOps(base, ops);
  if (!r.ok) return res.json({ ok: false, summary, errors: r.errors });

  pushTotalUndo(get(req), slug, s.draft[slug] || null);
  s.draft[slug] = r.state;
  writeDraft(get(req), slug, r.state);
  auditLog(get(req), { role: req.role || 'owner', action: 'total-ai', page: slug, command: command.slice(0, 200), did: r.did });
  res.json({ ok: true, summary, did: r.did, undoDepth: (totalUndo[get(req)]?.[slug] || []).length });
});

app.post('/api/total/undo', authWrite, (req, res) => {
  const s = need(req, res); if (!s) return;
  const slug = pageOf(req, s);
  const st = totalUndo[get(req)]?.[slug];
  if (!st || !st.length) return res.status(400).json({ error: 'Nothing to undo.' });
  const prev = st.pop();
  if (prev) { s.draft[slug] = prev; writeDraft(get(req), slug, prev); }
  else { delete s.draft[slug]; rmSync(draftFile(get(req), slug), { force: true }); }
  auditLog(get(req), { role: req.role || 'owner', action: 'total-undo', page: slug });
  res.json({ ok: true, undoDepth: st.length });
});

app.post('/api/render', (req, res) => {
  const s = need(req, res); if (!s) return;
  const a = pageState(s, pageOf(req, s));
  const merged = req.body?.content && typeof req.body.content === 'object' ? { ...a.content, ...req.body.content } : a.content;
  let html = withBase(render(a.templateHtml, a.schema, merged));
  if (req.query.edit === 'nav') html = injectNav(html);
  else if (req.query.edit) html = injectEditor(html, a.schema);
  res.type('html').send(html);
});

// add / remove a collection item on a page (staged in that page's draft)
app.post('/api/structure', authWrite, (req, res) => {
  const s = need(req, res); if (!s) return;
  const slug = pageOf(req, s);
  const { op, col, index } = req.body || {};
  const base = s.draft[slug] || { ...s.pages[slug], schema: { ...s.pages[slug].schema }, content: { ...s.pages[slug].content }, sections: [...s.pages[slug].sections] };
  const r = applyStructure(base, op, col, index);
  if (r.error) return res.status(400).json({ error: r.error });
  try {
    const $ = load(render(r.templateHtml, r.schema, r.content));
    for (const sel of base.sections) if ($(sel).length === 0) return res.status(400).json({ error: `Blocked: "${sel}" would disappear.` });
  } catch (e) { return res.status(400).json({ error: `Could not apply safely (${e.message}).` }); }
  s.draft[slug] = { templateHtml: r.templateHtml, schema: r.schema, sections: base.sections, collections: base.collections, content: r.content };
  writeDraft(get(req), slug, s.draft[slug]);
  res.json({ ok: true, message: r.message });
});

app.post('/api/discard', authWrite, (req, res) => { const s = need(req, res); if (!s) return; clearDrafts(get(req)); res.json({ ok: true }); });

// ─── block library ──────────────────────────────────────────────────────────
const BLOCKS = {
  heading:    { label: 'Heading',       icon: 'H', html: '<h2 style="margin:24px 0 8px">New heading</h2>' },
  paragraph:  { label: 'Paragraph',     icon: '¶', html: '<p style="margin:0 0 16px;line-height:1.65">New paragraph — click to edit.</p>' },
  image:      { label: 'Image',         icon: '🖼', html: '<img src="https://placehold.co/1200x600/eeeeee/999999?text=Image" alt="Add an image" style="width:100%;height:auto;display:block;border-radius:8px;margin:16px 0">' },
  video:      { label: 'YouTube / Vimeo', icon: '▶', html: '<div style="position:relative;padding-bottom:56.25%;height:0;overflow:hidden;border-radius:8px;margin:16px 0"><iframe data-cms-embed src="https://www.youtube.com/embed/dQw4w9WgXcQ" style="position:absolute;top:0;left:0;width:100%;height:100%;border:0" allowfullscreen loading="lazy"></iframe></div>' },
  button:     { label: 'Button',        icon: '⬡', html: '<div style="margin:20px 0"><a href="#" style="display:inline-block;padding:13px 28px;background:#111;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px">Click here</a></div>' },
  quote:      { label: 'Quote',         icon: '"', html: '<blockquote style="border-left:4px solid #111;margin:24px 0;padding:12px 20px;font-style:italic;color:#444">Add your quote here.</blockquote>' },
  divider:    { label: 'Divider',       icon: '—', html: '<hr style="border:0;border-top:1px solid #e0e0e0;margin:40px 0">' },
  spacer:     { label: 'Spacer',        icon: '↕', html: '<div style="height:48px"></div>' },
  columns:    { label: 'Two columns',   icon: '⊞', html: '<div style="display:grid;grid-template-columns:1fr 1fr;gap:32px;margin:24px 0"><div><h3 style="margin:0 0 8px">Left heading</h3><p style="margin:0;line-height:1.6">Left column text goes here.</p></div><div><h3 style="margin:0 0 8px">Right heading</h3><p style="margin:0;line-height:1.6">Right column text goes here.</p></div></div>' },
  'img-text': { label: 'Image + Text',  icon: '▤', html: '<div style="display:grid;grid-template-columns:1fr 1fr;gap:40px;align-items:center;margin:24px 0"><img src="https://placehold.co/800x600/eeeeee/999999?text=Image" alt="Add an image" style="width:100%;border-radius:8px"><div><h3 style="margin:0 0 10px">Heading</h3><p style="margin:0;line-height:1.65">Supporting text goes here — click to edit.</p></div></div>' },
};

// authWrite (not requireOwner): handed-off CLIENTS must be able to load the block
// list too, or the "+ Add block" picker shows up empty for them. The /add endpoint
// below already allows clients; this kept it owner-only, which silently broke it.
app.get('/api/blocks', authWrite, (_req, res) => {
  res.json({ blocks: Object.entries(BLOCKS).map(([type, b]) => ({ type, label: b.label, icon: b.icon })) });
});

app.post('/api/blocks/add', authWrite, (req, res) => {
  const s = need(req, res); if (!s) return;
  const slug = pageOf(req, s);
  const { section, type, position = 'end' } = req.body || {};
  const block = BLOCKS[type];
  if (!block) return res.status(400).json({ error: `Unknown block type "${type}".` });

  const base = s.draft[slug] || s.pages[slug];
  const maxN = Math.max(0, ...Object.keys(base.schema).map((id) => parseInt(id.replace('cms-', '')) || 0));

  // Autotag just the new block HTML, continuing from the highest existing id
  const { snippetTagged, schema: blockSchema, content: blockContent } = autotagSnippet(block.html, maxN, null);

  // Insert tagged block into the page template
  const $ = load(base.templateHtml, { decodeEntities: false });
  let target = section ? $(section) : null;
  if (!target || !target.length) target = $('main').length ? $('main') : $('body');
  if (position === 'start') target.prepend(snippetTagged);
  else target.append(snippetTagged);
  const newTemplateHtml = $.html();

  // Merge — existing content always wins over placeholder defaults
  const newSchema = { ...base.schema, ...blockSchema };
  const newContent = { ...blockContent, ...base.content };

  // Structural invariant check
  try {
    const $c = load(render(newTemplateHtml, newSchema, newContent));
    for (const sel of base.sections) {
      if ($c(sel).length === 0) return res.status(400).json({ error: `Structural check failed: "${sel}" would disappear.` });
    }
  } catch (e) { return res.status(400).json({ error: `Could not apply safely: ${e.message}` }); }

  s.draft[slug] = { templateHtml: newTemplateHtml, schema: newSchema, sections: base.sections, collections: base.collections, content: newContent };
  writeDraft(get(req), slug, s.draft[slug]);
  res.json({ ok: true, added: block.label, newFields: Object.keys(blockSchema).length });
});

const isEditable = (base, id) => base.schema[id] || id.startsWith('seo:') || id.startsWith('style:') || id.startsWith('link:');
// Stage browser edits into the persisted per-page draft (survives reload) — does NOT go live.
function stageDraft(name, pendingByPage) {
  const s = sites[name];
  const touched = new Set([...Object.keys(s.draft), ...Object.keys(pendingByPage).filter((sl) => Object.keys(pendingByPage[sl] || {}).length)]);
  if (!touched.size) return { ok: true, saved: 0 };
  let saved = 0;
  for (const slug of touched) {
    if (!s.pages[slug]) continue;
    const base = s.draft[slug] || s.pages[slug];
    const pend = pendingByPage[slug] || {};
    const changeset = Object.keys(pend).filter((id) => isEditable(base, id) && pend[id] !== base.content[id]).map((id) => ({ op: 'set', id, value: pend[id] }));
    if (!changeset.length && !s.draft[slug]) continue;
    let finalContent = base.content;
    if (changeset.length) {
      const g = validate(changeset, base);
      if (!g.ok) return { error: `Blocked on "${slug}"`, errors: g.errors };
      finalContent = g.candidate; saved += changeset.length;
    }
    s.draft[slug] = { templateHtml: base.templateHtml, schema: base.schema, sections: base.sections, collections: base.collections, content: finalContent };
    writeDraft(name, slug, s.draft[slug]);
  }
  return { ok: true, saved };
}
// Commit staged draft + pending edits → one immutable version (does NOT deploy — caller does).
function applyAndCommit(name, pendingByPage, role) {
  const s = sites[name];
  const touched = new Set([...Object.keys(s.draft), ...Object.keys(pendingByPage).filter((sl) => Object.keys(pendingByPage[sl] || {}).length)]);
  if (!touched.size) return { error: 'Nothing to publish.' };
  let totalEdits = 0, structural = false;
  for (const slug of touched) {
    if (!s.pages[slug]) continue;
    const base = s.draft[slug] || s.pages[slug];
    if (s.draft[slug]) structural = true;
    const pend = pendingByPage[slug] || {};
    const changeset = Object.keys(pend).filter((id) => isEditable(base, id) && pend[id] !== base.content[id]).map((id) => ({ op: 'set', id, value: pend[id] }));
    let finalContent = base.content;
    if (changeset.length) {
      const g = validate(changeset, base);
      if (!g.ok) return { error: `Blocked on "${slug}"`, errors: g.errors };
      finalContent = g.candidate; totalEdits += changeset.length;
    }
    s.pages[slug] = { templateHtml: base.templateHtml, schema: base.schema, sections: base.sections, collections: base.collections, content: finalContent };
    writePage(name, slug, s.pages[slug]);
  }
  clearDrafts(name);
  const bits = [];
  if (totalEdits) bits.push(`${totalEdits} text edit${totalEdits > 1 ? 's' : ''}`);
  if (structural) bits.push('layout change');
  if (touched.size > 1) bits.push(`${touched.size} pages`);
  const summary = bits.join(' · ') || 'Published';
  saveVersion(name, summary);
  auditLog(name, { role: role || 'owner', action: 'publish', version: s.head, summary });
  return { ok: true, summary, totalEdits, head: s.head };
}
// ─── approval gate (client edits wait for owner sign-off before going live) ───
const reviewFile = (name) => join(siteDir(name), 'review.json');
const getReview = (name) => { const f = reviewFile(name); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : { pending: false }; };
const setReview = (name, obj) => writeFileSync(reviewFile(name), JSON.stringify(obj, null, 2));
const clearReview = (name) => rmSync(reviewFile(name), { force: true });

// Save: stage all current edits into a persisted draft — does NOT go live.
app.post('/api/save', authWrite, (req, res) => {
  const s = need(req, res); if (!s) return;
  const pendingByPage = (req.body?.pages && typeof req.body.pages === 'object') ? req.body.pages : {};
  const r = stageDraft(get(req), pendingByPage);
  if (r.error) return res.status(400).json({ error: r.error, errors: r.errors });
  if (!r.saved && !hasDraft(s)) return res.status(400).json({ error: 'Nothing to save.' });
  auditLog(get(req), { role: req.role || 'owner', action: 'save', saved: r.saved });
  res.json({ ok: true, saved: r.saved });
});

// Submit for review: a client stages edits + flags them for the owner to approve. Not live.
app.post('/api/submit-review', authWrite, (req, res) => {
  const s = need(req, res); if (!s) return;
  const pendingByPage = (req.body?.pages && typeof req.body.pages === 'object') ? req.body.pages : {};
  const r = stageDraft(get(req), pendingByPage);
  if (r.error) return res.status(400).json({ error: r.error, errors: r.errors });
  if (!hasDraft(s)) return res.status(400).json({ error: 'Nothing to submit.' });
  const note = String(req.body?.note || '').slice(0, 500);
  setReview(get(req), { pending: true, by: req.role || 'client', at: new Date().toISOString(), note });
  auditLog(get(req), { role: req.role || 'client', action: 'submit', note });
  res.json({ ok: true });
});
app.get('/api/review', (req, res) => { const s = need(req, res); if (!s) return; res.json(getReview(get(req))); });
app.post('/api/review/approve', requireOwner, async (req, res) => {
  const s = need(req, res); if (!s) return;
  const r = applyAndCommit(get(req), {}, 'owner');   // the staged draft holds the client's changes
  if (r.error) return res.status(400).json({ error: r.error, errors: r.errors });
  clearReview(get(req));
  auditLog(get(req), { role: 'owner', action: 'approve', version: s.head });
  const repo = await repoPublish(get(req), r.summary);
  res.json({ ok: true, head: r.head, repo });
});
app.post('/api/review/reject', requireOwner, (req, res) => {
  const s = need(req, res); if (!s) return;
  const note = String(req.body?.note || '').slice(0, 500);
  if (req.body?.discard) clearDrafts(get(req));
  clearReview(get(req));
  auditLog(get(req), { role: 'owner', action: 'reject', note });
  res.json({ ok: true });
});

// Activity feed: the audit trail, newest first (owner only).
app.get('/api/audit', requireOwner, (req, res) => {
  const s = need(req, res); if (!s) return;
  const f = join(siteDir(get(req)), 'audit.log');
  const lines = existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean) : [];
  const entries = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse().slice(0, 200);
  res.json({ entries });
});

// ─── forms: live-site submissions captured into an in-product inbox ───
const formsFile = (name) => join(siteDir(name), 'forms.json');
const getForms = (name) => { const f = formsFile(name); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : []; };
const saveForms = (name, arr) => writeFileSync(formsFile(name), JSON.stringify(arr, null, 2));
// NOTE: specific routes MUST be declared before the catch-all /api/forms/:site capture route.
app.get('/api/forms', authWrite, (req, res) => { const s = need(req, res); if (!s) return; res.json({ submissions: getForms(get(req)) }); });
app.post('/api/forms/read', authWrite, (req, res) => { const s = need(req, res); if (!s) return; saveForms(get(req), getForms(get(req)).map((x) => ({ ...x, read: true }))); res.json({ ok: true }); });
app.post('/api/forms/delete', authWrite, (req, res) => { const s = need(req, res); if (!s) return; saveForms(get(req), getForms(get(req)).filter((x) => x.id !== req.body?.id)); res.json({ ok: true }); });
app.options('/api/forms/:site', (req, res) => res.set('Access-Control-Allow-Origin', '*').set('Access-Control-Allow-Headers', 'Content-Type').end());
app.post('/api/forms/:site', (req, res) => {                 // PUBLIC — the live site posts here (CORS open)
  res.set('Access-Control-Allow-Origin', '*');
  const name = String(req.params.site).replace(/[^a-z0-9_-]/gi, '');
  if (!sites[name]) return res.status(404).json({ error: 'Unknown site' });
  const fields = {};
  for (const [k, v] of Object.entries(req.body || {})) { if (k !== '_page' && typeof v === 'string' && k.length < 60) fields[k.slice(0, 60)] = v.slice(0, 2000); }
  if (!Object.keys(fields).length) return res.status(400).json({ error: 'Empty submission' });
  const arr = getForms(name);
  arr.unshift({ id: 'f' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36), at: new Date().toISOString(), page: String(req.body?._page || '').slice(0, 80), read: false, fields });
  saveForms(name, arr.slice(0, 500));
  res.json({ ok: true });
});

// Publish ALL staged edits across pages → one version → static deploy.
app.post('/api/publish', authWrite, async (req, res) => {
  const s = need(req, res); if (!s) return;
  const pendingByPage = (req.body?.pages && typeof req.body.pages === 'object') ? req.body.pages : {};
  const r = applyAndCommit(get(req), pendingByPage, req.role);
  if (r.error) return res.status(400).json({ error: r.error, errors: r.errors });
  clearReview(get(req));                                   // an owner publish also clears any pending review
  const repo = await repoPublish(get(req), r.summary);     // merge the working branch into the site repo's main
  res.json({ ok: true, head: r.head, published: r.totalEdits, liveUrl: `/live/${get(req)}`, repo });
});

app.get('/api/versions', (req, res) => { const s = need(req, res); if (!s) return; res.json({ head: s.head, versions: s.versions }); });

app.post('/api/version/restore', authWrite, async (req, res) => {
  const s = need(req, res); if (!s) return;
  const seq = Number(req.body?.seq);
  if (!restoreVersion(get(req), seq)) return res.status(400).json({ error: `No version ${seq}.` });
  auditLog(get(req), { role: req.role || 'owner', action: 'restore', version: seq });
  const repo = await repoPublish(get(req), `restore v${seq}`);   // a restore is a publish of the restored state
  res.json({ ok: true, head: s.head, repo });
});
app.post('/api/rollback', authWrite, async (req, res) => {
  const s = need(req, res); if (!s) return;
  const idx = s.versions.findIndex((v) => v.seq === s.head);
  if (idx <= 0) return res.status(400).json({ error: 'Already at the earliest version.' });
  restoreVersion(get(req), s.versions[idx - 1].seq);
  const repo = await repoPublish(get(req), `rollback to v${s.head}`);
  res.json({ ok: true, head: s.head, repo });
});

/* ───── PAGE MANAGEMENT (WordPress-style) — auto-versioned + deployed ───── */
app.post('/api/pages/add', authWrite, clientCan('canAddPages'), (req, res) => {
  const s = need(req, res); if (!s) return;
  const title = String(req.body?.title || 'New Page').slice(0, 60);
  let slug = String(req.body?.slug || title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || `page-${s.order.length}`;
  if (s.pages[slug]) slug = `${slug}-${s.order.length}`;
  const template = req.body?.template || 'blank';
  const home = s.pages[s.home];
  if (template === 'blank' || template === 'article') {
    // Build a new page reusing the site's head/header/footer (instant native styling),
    // swapping <main> for a starter layout, then autotag so it's fully editable.
    const $ = load(home.templateHtml, { decodeEntities: false });
    $('[data-cms],[data-cms-img],[data-cms-embed],[data-cms-item],[data-cms-collection]').each((_, el) => { for (const a of ['data-cms', 'data-cms-img', 'data-cms-embed', 'data-cms-item', 'data-cms-collection']) $(el).removeAttr(a); });
    if ($('head > title').length) $('head > title').text(`${title}`);
    const body = template === 'article'
      ? `<article style="max-width:760px;margin:0 auto;padding:80px 24px"><p style="font-family:monospace;font-size:13px;text-transform:uppercase;letter-spacing:.1em;opacity:.6">Article</p><h1 style="font-size:44px;line-height:1.1;letter-spacing:-.03em;margin:10px 0 8px">${title}</h1><p style="opacity:.6;font-size:14px;margin-bottom:34px">By Your Name · 5 min read</p><p style="font-size:17px;line-height:1.75;margin-bottom:20px">Write your opening paragraph here. Set the scene and tell the reader why this matters.</p><h2 style="font-size:26px;letter-spacing:-.02em;margin:34px 0 12px">A subheading</h2><p style="font-size:17px;line-height:1.75;margin-bottom:20px">Keep writing your article. Click any of this text to edit it, or describe changes in the chat.</p><p style="font-size:17px;line-height:1.75">Add as many paragraphs as you like.</p></article>`
      : `<section style="max-width:900px;margin:0 auto;padding:90px 24px"><h1 style="font-size:48px;line-height:1.08;letter-spacing:-.03em;margin:0 0 12px">${title}</h1><h2 style="font-size:21px;line-height:1.4;font-weight:500;opacity:.72;margin:0 0 24px;max-width:60ch">Add a subheading that tells visitors what this page is about.</h2><p style="font-size:17px;line-height:1.7;max-width:62ch;opacity:.85">This is your new page. Click any text to edit it, add sections, or describe what you want in the chat.</p></section>`;
    if ($('main').length) $('main').html(body); else $('body').append(`<main>${body}</main>`);
    const tagged = autotag($.html());
    s.pages[slug] = { templateHtml: tagged.templateHtml, schema: tagged.schema, content: tagged.content, sections: tagged.sections, collections: tagged.collections };
  } else {
    const src = s.pages[s.pages[req.body?.from] ? req.body.from : s.home]; // duplicate an existing page
    s.pages[slug] = { templateHtml: src.templateHtml, schema: { ...src.schema }, content: { ...src.content }, sections: [...src.sections], collections: [...src.collections] };
  }
  s.order.push(slug);
  s.pagesMeta[slug] = { title, path: `/${slug}` };
  writePage(get(req), slug, s.pages[slug]);
  writeCfg(get(req));
  saveVersion(get(req), `added page "${title}"`);
  res.json({ ok: true, slug, liveUrl: `/live/${get(req)}/${slug}` });
});

app.post('/api/pages/delete', authWrite, clientCan('canDeletePages'), (req, res) => {
  const s = need(req, res); if (!s) return;
  const slug = req.body?.slug;
  if (!s.pages[slug]) return res.status(404).json({ error: 'No such page.' });
  if (slug === s.home) return res.status(400).json({ error: "Can't delete the home page (set another page as home first)." });
  if (s.order.length <= 1) return res.status(400).json({ error: "Can't delete the only page." });
  delete s.pages[slug]; delete s.pagesMeta[slug]; delete s.draft[slug];
  s.order = s.order.filter((x) => x !== slug);
  rmSync(pageDir(get(req), slug), { recursive: true, force: true });
  writeCfg(get(req));
  saveVersion(get(req), `deleted page "${slug}"`);
  res.json({ ok: true });
});

app.post('/api/pages/home', authWrite, clientCan('canChangeHome'), (req, res) => {
  const s = need(req, res); if (!s) return;
  const slug = req.body?.slug;
  if (!s.pages[slug]) return res.status(404).json({ error: 'No such page.' });
  s.home = slug;
  s.order.forEach((sl) => { s.pagesMeta[sl].path = sl === slug ? '/' : `/${sl}`; });
  writeCfg(get(req));
  saveVersion(get(req), `set "${slug}" as home`);
  res.json({ ok: true });
});

/* ───── OWNER / ADMIN ───── */
app.post('/api/admin/handoff', requireOwner, (req, res) => {
  const name = String(req.body?.site || '').replace(/[^a-z0-9_-]/gi, '');
  const s = sites[name]; if (!s) return res.status(404).json({ error: 'Unknown site.' });
  const token = randomBytes(24).toString('base64url');
  s.access = { ...(s.access || {}), tokenHash: sha256(token), clientName: req.body?.clientName || null, customDomain: req.body?.customDomain || null, createdAt: new Date().toISOString() };
  writeFileSync(join(siteDir(name), 'access.json'), JSON.stringify(s.access, null, 2));
  auditLog(name, { role: 'owner', action: 'handoff', client: s.access.clientName });
  res.json({ ok: true, clientLink: `/client/?site=${name}&key=${token}`, liveUrl: `/live/${name}` });
});
// Owner sets a chosen PASSWORD for a site — the client types it into a login gate (never needs to be in the URL).
app.post('/api/admin/set-password', requireOwner, (req, res) => {
  const name = String(req.body?.site || '').replace(/[^a-z0-9_-]/gi, '');
  const s = sites[name]; if (!s) return res.status(404).json({ error: 'Unknown site.' });
  const pw = String(req.body?.password || '');
  if (pw.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters.' });
  // mustChangePassword: onboarding sets a TEMPORARY password and flags it, so the client is
  // forced to choose their own on first login (then the owner never holds their real password).
  s.access = { ...(s.access || {}), tokenHash: sha256(pw), clientName: req.body?.clientName || s.access?.clientName || null, requireApproval: req.body?.requireApproval != null ? !!req.body.requireApproval : !!s.access?.requireApproval, mustChangePassword: !!req.body?.mustChangePassword, mode: 'password', createdAt: new Date().toISOString() };
  writeFileSync(join(siteDir(name), 'access.json'), JSON.stringify(s.access, null, 2));
  auditLog(name, { role: 'owner', action: 'set-password', client: s.access.clientName });
  res.json({ ok: true, loginLink: `/client/?site=${name}`, liveUrl: `/live/${name}` });
});
// Rename the client's display name only — does not touch their password or capabilities.
// Kept separate from set-password so re-setting a password never overwrites this as a side effect.
app.post('/api/admin/rename-client', requireOwner, (req, res) => {
  const name = String(req.body?.site || '').replace(/[^a-z0-9_-]/gi, '');
  const s = sites[name]; if (!s) return res.status(404).json({ error: 'Unknown site.' });
  if (!s.access) return res.status(400).json({ error: 'This site has no client access set yet.' });
  s.access.clientName = String(req.body?.clientName || '').trim() || null;
  writeFileSync(join(siteDir(name), 'access.json'), JSON.stringify(s.access, null, 2));
  auditLog(name, { role: 'owner', action: 'rename-client', client: s.access.clientName });
  res.json({ ok: true, clientName: s.access.clientName });
});
// Client sets their OWN password (used for the forced first-login change). authWrite proves
// the caller holds the current/temporary password (or is the owner); we then swap the hash.
app.post('/api/client/change-password', authWrite, (req, res) => {
  const s = need(req, res); if (!s) return;
  if (!s.access?.tokenHash) return res.status(400).json({ error: 'This site has no client access set.' });
  const np = String(req.body?.newPassword || '');
  if (np.length < 6) return res.status(400).json({ error: 'Choose a password of at least 6 characters.' });
  s.access = { ...s.access, tokenHash: sha256(np), mustChangePassword: false };
  writeFileSync(join(siteDir(get(req)), 'access.json'), JSON.stringify(s.access, null, 2));
  auditLog(get(req), { role: req.role || 'client', action: 'change-password' });
  res.json({ ok: true });
});
// Set what a handed-off client may do (page add/delete). Edit-only by default.
app.post('/api/admin/capabilities', requireOwner, (req, res) => {
  const name = String(req.body?.site || '').replace(/[^a-z0-9_-]/gi, '');
  const s = sites[name]; if (!s) return res.status(404).json({ error: 'Unknown site.' });
  if (!s.access) s.access = { createdAt: new Date().toISOString() };
  s.access.capabilities = { canAddPages: !!req.body?.canAddPages, canDeletePages: !!req.body?.canDeletePages, canChangeHome: !!req.body?.canChangeHome };
  writeFileSync(join(siteDir(name), 'access.json'), JSON.stringify(s.access, null, 2));
  res.json({ ok: true, capabilities: s.access.capabilities });
});
// Permanently delete a whole site — pages, versions, access, forms, everything.
// rmSync's mirror wrapper also purges every "sites/<name>/…" doc from Mongo, so it's gone for good.
app.post('/api/admin/delete-site', requireOwner, (req, res) => {
  const name = String(req.body?.site || '').replace(/[^a-z0-9_-]/gi, '');
  if (!sites[name]) return res.status(404).json({ error: 'Unknown site.' });
  rmSync(siteDir(name), { recursive: true, force: true });
  delete sites[name];
  res.json({ ok: true, deleted: name });
});
// Toggle whether this client's changes need owner approval before going live.
app.post('/api/admin/approval', requireOwner, (req, res) => {
  const name = String(req.body?.site || '').replace(/[^a-z0-9_-]/gi, '');
  const s = sites[name]; if (!s) return res.status(404).json({ error: 'Unknown site.' });
  if (!s.access) s.access = { createdAt: new Date().toISOString() };
  s.access.requireApproval = !!req.body?.requireApproval;
  writeFileSync(join(siteDir(name), 'access.json'), JSON.stringify(s.access, null, 2));
  res.json({ ok: true, requireApproval: s.access.requireApproval });
});
// Image upload — client picks a file; we store it under the site and return a URL.
// Uploads: images everywhere; Total-mode chat can also attach PDFs, video and
// audio (brochures, menus, background loops). Type is decided by the data-URL
// MIME against a strict allowlist — never by filename.
const UPLOAD_TYPES = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg', 'image/avif': 'avif',
  'application/pdf': 'pdf', 'video/mp4': 'mp4', 'video/webm': 'webm', 'audio/mpeg': 'mp3', 'audio/wav': 'wav',
};
app.post('/api/upload', authWrite, (req, res) => {
  if (!sites[get(req)]) return res.status(404).json({ error: 'Unknown site.' });
  const m = /^data:([\w/+.-]+);base64,(.+)$/s.exec(req.body?.dataUrl || '');
  const ext = m && UPLOAD_TYPES[m[1]];
  if (!ext) return res.status(400).json({ error: 'That file type isn’t supported — images, PDF, MP4/WebM video, or MP3/WAV audio.' });
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 12 * 1024 * 1024) return res.status(400).json({ error: 'File too large (max 12MB).' });
  const dir = join(siteDir(get(req)), 'uploads');
  mkdirSync(dir, { recursive: true });
  const fn = createHash('sha256').update(buf).digest('hex').slice(0, 16) + '.' + ext;
  writeFileSync(join(dir, fn), buf);
  res.json({ ok: true, url: `/u/${get(req)}/${fn}` });
});
app.get('/u/:name/:file', (req, res) => {
  const f = join(siteDir(req.params.name), 'uploads', req.params.file.replace(/[^a-z0-9_.-]/gi, ''));
  if (!existsSync(f)) return res.sendStatus(404);
  res.sendFile(f);
});

// AI settings (OpenRouter only) — paste an API key in the console; never returns the raw key.
// Prefer OPENROUTER_API_KEY as an env var: env vars always win (see lib/config.mjs aiCreds()),
// this UI/config path is only a fallback for when no env var is set.
app.get('/api/admin/config', requireOwner, (_req, res) => {
  const c = getConfig(); const creds = aiCreds();
  res.json({ hasKey: !!creds.key, provider: creds.provider, model: c.model || creds.model });
});
app.post('/api/admin/config', requireOwner, async (req, res) => {
  const patch = {};
  if (typeof req.body?.apiKey === 'string' && req.body.apiKey.trim()) patch.apiKey = req.body.apiKey.trim();
  if (req.body?.model) patch.model = req.body.model;
  if (req.body?.clearKey) patch.apiKey = '';
  if (typeof req.body?.publicUrl === 'string') patch.publicUrl = req.body.publicUrl.trim().replace(/\/+$/, '');
  await setConfig(patch);
  res.json({ ok: true, provider: aiCreds().provider });
});

// Total mode: per-site switch — the AI may redesign layout & style, not just content.
app.post('/api/admin/site-total', requireOwner, (req, res) => {
  const name = String(req.body?.site || '').replace(/[^a-z0-9_-]/gi, '');
  const s = sites[name]; if (!s) return res.status(404).json({ error: 'Unknown site.' });
  s.totalMode = !!req.body?.totalMode;
  writeCfg(name);
  res.json({ ok: true, totalMode: s.totalMode });
});

app.post('/api/admin/site-clarity', requireOwner, (req, res) => {
  const name = String(req.body?.site || '').replace(/[^a-z0-9_-]/gi, '');
  const s = sites[name]; if (!s) return res.status(404).json({ error: 'Unknown site.' });
  s.clarity = String(req.body?.clarityId || '').trim() || null;
  writeCfg(name);
  if (s.head >= 0) buildRelease(name, s.head); // re-bake the active release so the tag is injected now
  res.json({ ok: true, clarity: s.clarity, rebuilt: s.head >= 0 });
});

// GitHub deploy: mirror edits to a branch of the site's repo; Publish merges to main.
app.post('/api/admin/site-repo', requireOwner, (req, res) => {
  const name = String(req.body?.site || '').replace(/[^a-z0-9_-]/gi, '');
  const s = sites[name]; if (!s) return res.status(404).json({ error: 'Unknown site.' });
  const repo = String(req.body?.repo || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) return res.status(400).json({ error: 'Use the owner/name form, e.g. stevewinfieldtx/ws-rain-networks-v2.' });
  s.repo = repo || null;
  s.repoBranch = String(req.body?.branch || '').trim().replace(/[^\w./-]/g, '') || null;
  writeCfg(name);
  if (s.repo && !ghToken()) return res.json({ ok: true, repo: s.repo, warning: 'No GITHUB_TOKEN set on this service yet — syncing will start once you add one.' });
  res.json({ ok: true, repo: s.repo, branch: repoBranchOf(s) });
});

// Custom domain: serve this site's published release at the domain root.
// (Point the domain at this Railway service; Publish is then instantly live.)
app.post('/api/admin/site-domain', requireOwner, (req, res) => {
  const name = String(req.body?.site || '').replace(/[^a-z0-9_-]/gi, '');
  const s = sites[name]; if (!s) return res.status(404).json({ error: 'Unknown site.' });
  const d = String(req.body?.domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (d && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) return res.status(400).json({ error: 'That doesn’t look like a domain (e.g. rainnetworks.com).' });
  s.domain = d || null;
  writeCfg(name);
  if (s.head >= 0) buildRelease(name, s.head); // sitemap/llms URLs pick up the domain
  res.json({ ok: true, domain: s.domain, rebuilt: s.head >= 0 });
});

// Custom embed snippet (chat widgets etc.) — owner-only, injected at build.
app.post('/api/admin/site-embed', requireOwner, (req, res) => {
  const name = String(req.body?.site || '').replace(/[^a-z0-9_-]/gi, '');
  const s = sites[name]; if (!s) return res.status(404).json({ error: 'Unknown site.' });
  const snippet = String(req.body?.embed || '').trim().slice(0, 4000);
  s.embed = snippet || null;
  writeCfg(name);
  if (s.head >= 0) buildRelease(name, s.head); // re-bake so the widget appears now
  res.json({ ok: true, hasEmbed: !!s.embed, rebuilt: s.head >= 0 });
});

app.post('/api/admin/site-convai', requireOwner, (req, res) => {
  const name = String(req.body?.site || '').replace(/[^a-z0-9_-]/gi, '');
  const s = sites[name]; if (!s) return res.status(404).json({ error: 'Unknown site.' });
  s.convai = String(req.body?.agentId || '').trim() || null;
  writeCfg(name);
  if (s.head >= 0) buildRelease(name, s.head); // re-bake the active release so the widget appears now
  res.json({ ok: true, convai: s.convai, rebuilt: s.head >= 0 });
});

app.post('/api/admin/export', requireOwner, (req, res) => {
  const name = String(req.body?.site || '').replace(/[^a-z0-9_-]/gi, '');
  if (!sites[name]) return res.status(404).json({ error: 'Unknown site.' });
  try { const out = join(ROOT, 'dist', name); const r = deployer.exportTo(siteDir(name), out); res.json({ ok: true, dir: out, files: r.files }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

const PORT = process.env.PORT || 4321;
app.listen(PORT, () => {
  console.log(`AI CMS (multi-site · multi-page) on http://localhost:${PORT}/`);
  console.log(`  agency console : http://localhost:${PORT}/admin/?key=${ADMIN_KEY}`);
  console.log(`Sites: ${Object.keys(sites).join(', ') || '(none)'} | Planner: ${plannerMode()}`);
});

// On redeploy Railway sends SIGTERM before killing the container. Flush any in-flight
// Mongo mirror writes first, so a site can never be left half-written in the database.
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => {
  try { await flushMirror(); } catch {}
  process.exit(0);
});

// deploy marker: self-service onboarding (crawl + client-owned passwords) — 2026-07-02
