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

  $('iframe').each((_, el) => {
    const $el = $(el);
    const src = $el.attr('src') || '';
    const embedAttr = $el.attr('data-cms-embed');       // undefined = absent, '' = present-but-empty
    const looksEmbed = EMBED_HOST_RE.test(src);
    if (embedAttr === undefined && !looksEmbed) return;  // not a video embed — leave it alone

    // Resolve the field id: a real data-cms-embed id wins, else the data-cms id, else mint one.
    let id = (embedAttr && embedAttr.trim()) || ($el.attr('data-cms') || '').trim();
    if (!id) id = `cms-${++maxN}`;

    const strayCms = $el.attr('data-cms') !== undefined;
    const tagOk = embedAttr === id && !strayCms;
    const schemaOk = schema[id] && schema[id].type === 'embed';
    if (tagOk && schemaOk && content[id] != null) return; // already correct — no-op

    $el.attr('data-cms-embed', id);
    if (strayCms) $el.removeAttr('data-cms');
    const prev = schema[id] || {};
    schema[id] = { type: 'embed', label: prev.label || 'Video embed URL', group: prev.group || 'Media', rich: false, allow: [] };
    if (content[id] == null) content[id] = src;
    changed = true;
  });

  return { changed, templateHtml: changed ? $.html() : templateHtml, schema, content };
}
