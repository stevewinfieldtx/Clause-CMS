/**
 * total.mjs — Total mode: the AI edits the template itself (layout + style +
 * content), not just tagged fields. The safety model shifts from "prevent
 * anything untagged" to "sanitize + apply to the draft + one-click undo":
 *
 *   1. every op is whitelisted and shape-checked
 *   2. all AI-emitted HTML/CSS is sanitized (no scripts, handlers, javascript:
 *      URLs, non-YouTube/Vimeo iframes, forms)
 *   3. selectors must resolve unambiguously (exactly one element)
 *   4. new/replaced markup is re-autotagged so click-to-edit and future `set`
 *      ops keep working on whatever the AI just built
 *   5. the page must still render non-empty
 *
 * Nothing here ever touches the live site — the caller writes the result to
 * the page DRAFT, and publish stays the existing versioned release flow.
 */
import { load } from 'cheerio';
import { autotagSnippet } from './autotag.mjs';
import { isSafeEmbedUrl } from './sanitize.mjs';
import { render } from './render.mjs';
import { validate } from './guardian.mjs';

export const TOTAL_OPS = ['set', 'replace_section', 'insert_section', 'remove_section', 'move_section', 'set_css', 'set_style'];
const PROTECTED_TAGS = new Set(['html', 'head', 'body']);
const MAX_HTML_PER_OP = 60_000;
const MAX_CSS = 30_000;
const BAD_CSS_RE = /@import|expression\s*\(|javascript:|data:text\/html|<\/?\s*script/i;
const BAD_DECL_RE = /[{}]|\/\*|<\/?\s*style/i; // a declaration block must never itself open/close a rule or a <style> tag

/** Upsert ONE selector's rule inside a CSS text block, in place — every other
 *  rule is left untouched. This is what makes single-property style changes
 *  (font color, weight, etc.) additive instead of a fragile full-file rewrite
 *  the AI has to perfectly reproduce on every unrelated change. */
export function upsertCssRule(existingCss, selector, decl) {
  const sel = String(selector).trim();
  const body = String(decl).trim().replace(/;?\s*$/, ';');
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${esc}\\s*\\{[^}]*\\}`);
  const rule = `${sel} { ${body} }`;
  const css = String(existingCss || '');
  return re.test(css) ? css.replace(re, rule) : `${css}\n${rule}\n`;
}

/** Sanitize an AI-emitted HTML fragment. Structure/classes/inline styles are
 *  allowed (that's the point of Total mode); anything executable is not. */
export function sanitizeFragment(html) {
  const $ = load(`<rt>${String(html)}</rt>`, { decodeEntities: false }, false);
  // Forms/inputs are ALLOWED (they're normal page furniture — contact forms,
  // placeholders); the attribute pass below strips handlers and js: actions,
  // and published forms are wired to the CMS inbox at build time anyway.
  $('script, object, embed, base, link, meta').remove();
  $('rt iframe').each((_, el) => { if (!isSafeEmbedUrl(el.attribs?.src || '')) $(el).remove(); });
  $('rt style').each((_, el) => { if (BAD_CSS_RE.test($(el).html() || '')) $(el).remove(); });
  $('rt *').each((_, el) => {
    for (const [attr, v] of Object.entries(el.attribs || {})) {
      if (/^on/i.test(attr)) { $(el).removeAttr(attr); continue; }
      if (/^(href|src|srcset|poster|action|formaction|xlink:href)$/i.test(attr) && /^\s*(javascript|vbscript|data:text\/html)/i.test(String(v))) { $(el).removeAttr(attr); continue; }
      if (attr === 'style' && BAD_CSS_RE.test(v)) $(el).removeAttr('style');
    }
  });
  return ($('rt').html() || '').trim();
}

export function sanitizeCss(css) {
  const v = String(css).slice(0, MAX_CSS);
  return BAD_CSS_RE.test(v) ? null : v;
}

/** Resolve a selector to EXACTLY one non-protected element, else an error string. */
function one($, selector, what) {
  let m;
  try { m = $(String(selector)); } catch { return { error: `${what}: "${selector}" is not a valid selector.` }; }
  if (m.length === 0) return { error: `${what}: nothing on the page matches "${selector}".` };
  if (m.length > 1) return { error: `${what}: "${selector}" matches ${m.length} elements — it must match exactly one.` };
  const tag = (m.get(0).tagName || '').toLowerCase();
  if (PROTECTED_TAGS.has(tag)) return { error: `${what}: refusing to operate on <${tag}> directly.` };
  return { el: m };
}

/** Highest cms-N in use across the schema AND the template (defensive). */
function maxCmsN(schema, templateHtml) {
  let n = 0;
  for (const id of Object.keys(schema)) { const m = parseInt(String(id).replace('cms-', ''), 10); if (m > n) n = m; }
  for (const m of String(templateHtml).matchAll(/data-cms(?:-img|-embed)?="cms-(\d+)"/g)) { const v = parseInt(m[1], 10); if (v > n) n = v; }
  return n;
}

/**
 * Apply a Total-mode op list to a page state. Pure: returns a NEW state (or
 * errors) and never mutates `base`. Structural ops run first on the template;
 * `set` ops then run through the classic Guardian against the merged schema.
 */
export function applyTotalOps(base, ops) {
  const errors = [];
  const did = [];
  if (!Array.isArray(ops) || !ops.length) return { ok: false, errors: ['The request produced no operations.'], did };

  const $ = load(base.templateHtml, { decodeEntities: false });
  let schema = { ...base.schema };
  let content = { ...base.content };
  let n = maxCmsN(schema, base.templateHtml);
  const setOps = [];
  let structural = false;

  const tagIn = (html, what) => {
    const clean = sanitizeFragment(html);
    if (!clean) { errors.push(`${what}: the HTML was empty after sanitizing.`); return null; }
    if (clean.length > MAX_HTML_PER_OP) { errors.push(`${what}: HTML too large (${clean.length} chars, max ${MAX_HTML_PER_OP}).`); return null; }
    const r = autotagSnippet(clean, n);
    n += Object.keys(r.schema).length;
    schema = { ...schema, ...r.schema };
    content = { ...content, ...r.content };
    return r.snippetTagged;
  };

  for (const op of ops) {
    const kind = op?.op;
    if (!TOTAL_OPS.includes(kind)) { errors.push(`Operation "${kind}" is not allowed.`); continue; }

    if (kind === 'set') { setOps.push({ op: 'set', id: op.id, value: op.value }); continue; }

    if (kind === 'set_css') {
      const css = sanitizeCss(op.css ?? '');
      if (css == null) { errors.push('Page styles: blocked — the CSS contained something executable.'); continue; }
      let styleEl = $('head style[data-cms-total]');
      if (!styleEl.length) { $('head').append('<style data-cms-total></style>'); styleEl = $('head style[data-cms-total]'); }
      styleEl.text(css);
      did.push('updated page styles'); structural = true; continue;
    }

    if (kind === 'set_style') {
      const sel = String(op.selector || '').trim();
      const decl = String(op.css || '').trim();
      if (!sel || BAD_CSS_RE.test(sel) || sel.includes('{') || sel.includes('}')) { errors.push(`Style: "${sel}" is not a usable selector.`); continue; }
      if (!decl || BAD_CSS_RE.test(decl) || BAD_DECL_RE.test(decl)) { errors.push(`Style on "${sel}": blocked — the declaration was invalid or contained something executable.`); continue; }
      // Prove the selector actually matches something before writing a rule for it.
      let matchCount;
      try { matchCount = $(sel).length; } catch { errors.push(`Style: "${sel}" is not a valid CSS selector.`); continue; }
      if (matchCount === 0) { errors.push(`Style: nothing on the page matches "${sel}".`); continue; }
      let styleEl = $('head style[data-cms-total]');
      if (!styleEl.length) { $('head').append('<style data-cms-total></style>'); styleEl = $('head style[data-cms-total]'); }
      styleEl.text(upsertCssRule(styleEl.text(), sel, decl).slice(0, MAX_CSS));
      did.push(`styled ${sel}`); structural = true; continue;
    }

    if (kind === 'remove_section') {
      const r = one($, op.selector, 'Remove');
      if (r.error) { errors.push(r.error); continue; }
      r.el.remove();
      did.push(`removed ${op.selector}`); structural = true; continue;
    }

    if (kind === 'move_section') {
      const t = one($, op.selector, 'Move');
      if (t.error) { errors.push(t.error); continue; }
      const ref = one($, op.ref, 'Move (destination)');
      if (ref.error) { errors.push(ref.error); continue; }
      const node = t.el.remove();
      if (op.position === 'before') ref.el.before(node); else ref.el.after(node);
      did.push(`moved ${op.selector}`); structural = true; continue;
    }

    if (kind === 'replace_section') {
      const r = one($, op.selector, 'Replace');
      if (r.error) { errors.push(r.error); continue; }
      const tagged = tagIn(op.html, `Replace ${op.selector}`);
      if (tagged == null) continue;
      r.el.replaceWith(tagged);
      did.push(`rebuilt ${op.selector}`); structural = true; continue;
    }

    if (kind === 'insert_section') {
      const tagged = tagIn(op.html, 'Insert');
      if (tagged == null) continue;
      if (op.ref) {
        const ref = one($, op.ref, 'Insert (position)');
        if (ref.error) { errors.push(ref.error); continue; }
        if (op.position === 'before') ref.el.before(tagged);
        else if (op.position === 'append') ref.el.append(tagged);
        else ref.el.after(tagged);
      } else $('body').append(tagged);
      did.push('added a new section'); structural = true; continue;
    }
  }

  if (errors.length) return { ok: false, errors, did };
  if (!structural && !setOps.length) return { ok: false, errors: ['Nothing to apply.'], did };

  const templateHtml = $.html();

  // Prune schema/content entries whose elements no longer exist (removed or
  // replaced sections take their fields with them). Virtual keys (seo:/style:/
  // link:) are page-level and survive on their own.
  if (structural) {
    const $t = load(templateHtml);
    const present = new Set();
    $t('[data-cms],[data-cms-img],[data-cms-embed]').each((_, el) => {
      for (const a of ['data-cms', 'data-cms-img', 'data-cms-embed']) if (el.attribs[a]) present.add(el.attribs[a]);
    });
    for (const id of Object.keys(schema)) if (!present.has(id)) { delete schema[id]; delete content[id]; }
    if (!$t('body').children().length) return { ok: false, errors: ['Blocked: that would leave the page empty.'], did };
  }

  // Recompute landmarks + surviving collections for the classic invariants.
  const $s = load(templateHtml);
  const sections = [];
  $s('section[id], header, footer, main, nav').each((_, el) => sections.push(el.attribs?.id ? `#${el.attribs.id}` : el.tagName));
  const colIds = new Set();
  $s('[data-cms-collection]').each((_, el) => colIds.add(el.attribs['data-cms-collection']));
  const collections = (base.collections || []).filter((c) => colIds.has(c.id));

  let state = { templateHtml, schema, sections: [...new Set(sections)], collections, content };

  // Content edits go through the classic Guardian against the NEW template,
  // so they get the same sanitizing + injection checks as always.
  if (setOps.length) {
    const g = validate(setOps, state);
    if (!g.ok) return { ok: false, errors: g.errors, did };
    state = { ...state, content: g.candidate };
    did.push(...g.diff.map((d) => `set ${d.label}`));
  }

  // Final sanity: the page must still render.
  try {
    const $c = load(render(state.templateHtml, state.schema, state.content));
    if (!$c('body').children().length) return { ok: false, errors: ['Blocked: the page would render empty.'], did };
  } catch (e) {
    return { ok: false, errors: [`Blocked: the page could not be re-rendered safely (${e.message}).`], did };
  }

  return { ok: true, errors: [], did, state };
}
