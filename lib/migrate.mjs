/**
 * migrate.mjs — idempotent, one-time data repairs applied on boot.
 *
 * repairEmbedTags: older imports stored a YouTube/Vimeo <iframe> as a plain text
 * field — the field id sat in data-cms with an empty/absent data-cms-embed. The
 * renderer, editor and AI planner all key off data-cms-embed="<id>" with a schema
 * entry of type "embed", so those videos could never be changed and showed up as
 * "Text N" instead of "Video N". This re-tags each such iframe to data-cms-embed,
 * drops the stray data-cms, and sets the schema type to "embed". Idempotent: a page
 * already tagged correctly is returned unchanged (changed=false), so it is safe to
 * run on every boot and across every site.
 */
import { load } from 'cheerio';

const EMBED_HOST_RE = /(?:^|\/\/)(?:www\.)?(?:youtube(?:-nocookie)?\.com\/embed\/|player\.vimeo\.com\/)/i;

export function repairEmbedTags(templateHtml, schema = {}, content = {}) {
  const $ = load(String(templateHtml || ''), { decodeEntities: false });
  let changed = false;
  let maxN = 0;
  for (const k of Object.keys(schema)) { const m = /^cms-(\d+)$/.exec(k); if (m) maxN = Math.max(maxN, +m[1]); }

  // Pass 1 (schema-driven, catches the "stored as text" case): any field the schema
  // ALREADY calls an embed must live on a data-cms-embed element, not data-cms. This
  // fixes videos whose iframe was tagged data-cms (so they rendered as "Text N") even
  // when the src doesn't match a known host pattern.
  for (const [id, def] of Object.entries(schema)) {
    if (!def || def.type !== 'embed') continue;
    const el = $(`[data-cms-embed="${id}"], [data-cms="${id}"]`).first();
    if (!el.length) continue;
    const embedOk = el.attr('data-cms-embed') === id;
    const strayCms = el.attr('data-cms') !== undefined;
    if (embedOk && !strayCms) { if (content[id] == null) { content[id] = el.attr('src') || ''; changed = true; } continue; }
    el.attr('data-cms-embed', id);
    if (strayCms) el.removeAttr('data-cms');
    if (content[id] == null) content[id] = el.attr('src') || '';
    changed = true;
  }

  // Pass 2 (src-driven, catches embeds with no field at all): a YouTube/Vimeo iframe
  // that carries no cms marker yet — tag it and register a schema entry.
  $('iframe').each((_, el) => {
    const $el = $(el);
    const src = $el.attr('src') || '';
    if ($el.attr('data-cms-embed') !== undefined || $el.attr('data-cms') !== undefined) return; // already a field
    if (!EMBED_HOST_RE.test(src)) return;
    const id = `cms-${++maxN}`;
    $el.attr('data-cms-embed', id);
    schema[id] = { type: 'embed', label: 'Video embed URL', group: 'Media', rich: false, allow: [] };
    content[id] = src;
    changed = true;
  });

  return { changed, templateHtml: changed ? $.html() : templateHtml, schema, content };
}
