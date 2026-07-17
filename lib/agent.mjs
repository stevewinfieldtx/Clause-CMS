/**
 * agent.mjs — the Planner. Turns a client's plain-English request into a
 * structured change-set of {op:'set', id, value} against a site's content
 * model. It can ONLY reference existing field ids; it never emits HTML/code.
 * Uses OpenRouter (key from an env var, or the Agency Console as a fallback),
 * else a deterministic local matcher.
 */
import { aiCreds, plannerMode } from './config.mjs';

export { plannerMode };

function catalogue(schema, content) {
  return Object.entries(schema).map(([id, d]) => ({
    id, label: d.label, group: d.group, type: d.type,
    rich: d.rich ? d.allow : false,
    current: String(content[id] ?? '').slice(0, 120),
  }));
}

const SYSTEM = `You are the Planner for a website CMS. A non-technical client describes a change in plain English; you translate it into a precise change-set.

HARD RULES:
- You may ONLY edit fields from the supplied catalogue, addressed by their "id".
- Output operations of the form {"op":"set","id":"<field id>","value":"<new value>"}.
- You CANNOT add, remove, reorder, or restructure anything, and you CANNOT write HTML, CSS, JS or code. Plain text only — unless a field's "rich" lists allowed inline tags, in which case use ONLY those tags and preserve existing decorative markup.
- Match intent to the right field by label, group and current value. If several match, pick the most likely or split into multiple set ops.
- Fields with "type":"image" or "type":"embed" accept ONLY a URL as their value — never words. For wording, spelling or capitalization changes, target text fields only. If the words the client wants changed are part of an image (e.g. lettering baked into a logo), return no changes and explain in "summary" that the image itself would need to be replaced.
- Keep the client's tone and rough copy length. Never invent facts (prices, stats, names) the client didn't give.
- If you can't map the request to any field, return an empty changes array and say why in "summary".

Always respond by calling emit_changeset.`;

const TOOL = {
  name: 'emit_changeset',
  description: 'Return the planned edits to the website content model.',
  input_schema: {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      changes: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, value: { type: 'string' } }, required: ['id', 'value'] } },
    },
    required: ['summary', 'changes'],
  },
};

async function openrouterPlan(command, content, schema, creds, history = []) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${creds.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: creds.model,
      messages: [
        { role: 'system', content: SYSTEM },
        ...history,
        { role: 'user', content: `Editable fields (catalogue):\n${JSON.stringify(catalogue(schema, content))}\n\nClient request: "${command}"` },
      ],
      tools: [{ type: 'function', function: { name: TOOL.name, description: TOOL.description, parameters: TOOL.input_schema } }],
      tool_choice: { type: 'function', function: { name: TOOL.name } },
    }),
  });
  const j = await res.json();
  const call = j.choices?.[0]?.message?.tool_calls?.[0];
  if (!call) return { summary: j.error?.message || "I couldn't interpret that.", changeset: [] };
  const { summary, changes = [] } = JSON.parse(call.function.arguments);
  return { summary, changeset: changes.map((c) => ({ op: 'set', id: c.id, value: c.value })) };
}

const STOP = new Set(['the', 'to', 'a', 'an', 'and', 'change', 'make', 'set', 'update', 'edit', 'please', 'say', 'says', 'it', 'our', 'my', 'is', 'be', 'should', 'into', 'on', 'for', 'of', 'this', 'that', 'with']);
function extractValue(command) {
  const m =
    command.match(/(?:to|say|says|reads?|=|:)\s+["“](.+?)["”]\s*$/i) ||
    command.match(/["“](.+?)["”]/) ||
    command.match(/(?:change|set|make|update)\b.*?\b(?:to|say|says|reads?)\s+(.+)$/i) ||
    command.match(/(?:to|=|:)\s+(.+)$/i);
  return m ? m[1].trim().replace(/[.\s]+$/, '') : null;
}
function localPlan(command, content, schema) {
  const value = extractValue(command);
  const words = command.toLowerCase().replace(/["“”]/g, '').split(/\W+/).filter((w) => w && !STOP.has(w));
  let best = null;
  for (const [id, d] of Object.entries(schema)) {
    const hay = `${d.label} ${d.group} ${String(content[id] ?? '')}`.toLowerCase();
    let score = 0;
    for (const w of words) if (hay.includes(w)) score += w.length > 3 ? 2 : 1;
    if (score > (best?.score ?? 0)) best = { id, score, def: d };
  }
  if (!best || best.score < 3 || !value) {
    return { summary: `(Local mode) Couldn't confidently match that. Add an AI key in the Agency Console for full natural-language editing — or quote the exact text, e.g. change "old text" to "new text".`, changeset: [] };
  }
  return { summary: `Set ${best.def.label} to "${value}".`, changeset: [{ op: 'set', id: best.id, value }] };
}

export async function plan(command, content, schema, history = []) {
  const creds = aiCreds();
  try {
    if (creds.provider === 'openrouter') return await openrouterPlan(command, content, schema, creds, history);
    return localPlan(command, content, schema);
  } catch (e) {
    return { summary: `Planner error: ${e.message}. Falling back to local matching.`, changeset: localPlan(command, content, schema).changeset };
  }
}

/* ───────────────────────── Total mode ─────────────────────────
   The planner sees the page's actual template HTML and may restructure it:
   replace/insert/remove/move whole sections, restyle the page, and still do
   plain content `set` ops. It NEVER emits scripts — everything it returns is
   sanitized and re-validated server-side (lib/total.mjs), applied only to the
   draft, and undoable. */

const TOTAL_SYSTEM = `You are the AI designer for a website CMS in TOTAL MODE. The logged-in site owner describes any change in plain English; you reshape their page to match.

You receive the page's full HTML. Elements carry data-cms/data-cms-img/data-cms-embed ids — those are editable content slots.

OPERATIONS you may emit (in "ops"):
- {"op":"set","id":"cms-N","value":"..."} — change one content slot's text/image URL/embed URL. PREFER this for pure copy/image changes: it is the most precise tool. Slots on data-cms-img / data-cms-embed elements accept ONLY URLs — for wording or capitalization changes, target data-cms TEXT slots only; if the words are baked into an image (logo lettering), say so in "summary" instead of emitting an op.
- {"op":"replace_section","selector":"...","html":"..."} — replace one element (and everything inside it) with new HTML.
- {"op":"insert_section","html":"...","ref":"...","position":"before|after|append"} — add new HTML relative to an existing element (omit ref to append to <body>).
- {"op":"remove_section","selector":"..."} — delete one element.
- {"op":"move_section","selector":"...","ref":"...","position":"before|after"} — move one element.
- {"op":"set_style","selector":"...","css":"prop: value; prop2: value2;"} — set CSS properties on elements matching a selector (can match many, e.g. "p" or ".card"). PREFER this for any request about ONE property on ONE kind of element — font color, size, weight, spacing, a background tint on a specific section, etc. It only touches that selector's rule; every other style you've set stays intact.
- {"op":"set_css","css":"..."} — replace the ENTIRE page stylesheet. Only for a broad redesign (new color scheme, new type scale for the whole page) — never for a single-property tweak, since you must reproduce every prior rule exactly or earlier style changes vanish. You get the current stylesheet's contents; emit the FULL replacement.

HARD RULES:
- Selectors must be CSS selectors that match EXACTLY ONE element on the page (use ids, or precise paths like "main > section:nth-of-type(2)"). Never target html/head/body directly.
- NO <script>, event handlers (onclick=…), javascript: URLs, or iframes other than YouTube/Vimeo embeds. They will be stripped.
- Form fields (inputs, placeholders, labels, selects) are NOT content slots — there is no "set" op for a placeholder. To change one (e.g. a placeholder's wording or capitalization), use replace_section on the smallest element containing that form field and re-emit it identically except for the requested tweak. Never drop form fields, their name attributes, or required flags in the process.
- Match the site's existing look: reuse its CSS classes, colors, spacing and tone unless the user asks for a new look. New sections should feel native to the page.
- Do not put data-cms attributes in HTML you write — the CMS tags new content automatically.
- Never invent facts (prices, phone numbers, names) the user didn't give.
- Keep the change as small as the request allows: don't rebuild a section to change one line (use "set").
- When the request lists uploaded files (e.g. "photo.jpg — /u/site/abc123.jpg"), use those URLs VERBATIM: images go in <img src> or image-slot set ops, PDFs become links, videos become <video src> elements. Never rewrite or invent upload URLs.
- If the request is unclear or impossible, return an empty ops array and explain in "summary".

"summary" must be one or two short plain-English sentences describing what you did, written for a non-technical site owner.

Always respond by calling emit_total_ops.`;

const TOTAL_TOOL = {
  name: 'emit_total_ops',
  description: 'Return the planned operations to apply to the page.',
  input_schema: {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      ops: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            op: { type: 'string', enum: ['set', 'replace_section', 'insert_section', 'remove_section', 'move_section', 'set_css', 'set_style'] },
            id: { type: 'string' },
            value: { type: 'string' },
            selector: { type: 'string' },
            html: { type: 'string' },
            css: { type: 'string' },
            ref: { type: 'string' },
            position: { type: 'string', enum: ['before', 'after', 'append'] },
          },
          required: ['op'],
        },
      },
    },
    required: ['summary', 'ops'],
  },
};

const MAX_TEMPLATE_CHARS = 200_000;

export async function planTotal(command, page, history = []) {
  const creds = aiCreds();
  if (creds.provider !== 'openrouter') {
    return { summary: 'Total mode needs an AI key — add one in the Agency Console (or set OPENROUTER_API_KEY).', ops: [] };
  }
  const tpl = String(page.templateHtml).slice(0, MAX_TEMPLATE_CHARS);
  const currentCss = (tpl.match(/<style data-cms-total>([\s\S]*?)<\/style>/) || [])[1] || '';
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${creds.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: creds.model,
      messages: [
        { role: 'system', content: TOTAL_SYSTEM },
        ...history,
        { role: 'user', content: `Current page HTML:\n\`\`\`html\n${tpl}\n\`\`\`\n\nCurrent custom stylesheet (set_css replaces this):\n\`\`\`css\n${currentCss}\n\`\`\`\n\nOwner's request: "${command}"` },
      ],
      tools: [{ type: 'function', function: { name: TOTAL_TOOL.name, description: TOTAL_TOOL.description, parameters: TOTAL_TOOL.input_schema } }],
      tool_choice: { type: 'function', function: { name: TOTAL_TOOL.name } },
    }),
  });
  const j = await res.json();
  const call = j.choices?.[0]?.message?.tool_calls?.[0];
  if (!call) return { summary: j.error?.message || "I couldn't interpret that.", ops: [] };
  try {
    const { summary, ops = [] } = JSON.parse(call.function.arguments);
    return { summary, ops };
  } catch {
    return { summary: 'The AI returned an unreadable plan — try rephrasing.', ops: [] };
  }
}
