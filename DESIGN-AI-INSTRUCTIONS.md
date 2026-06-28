# Instructions for AI Website Design — Claude CMS Compatible

You are designing a single-file, production-ready HTML website that will be managed by **Claude CMS**. Read every rule before writing a single line of HTML.

---

## How Claude CMS works (read this first)

Claude CMS ingests the rendered HTML of your page and freezes two things:

1. **Template** — the complete HTML structure, CSS, layout. This is immutable forever. Clients cannot break it.
2. **Content model** — every tagged text node, image `src`, embed URL, and link `href`. These are the only things clients can ever change.

An AI planner translates plain-English client requests into safe set-operations. A deterministic Guardian validates every change. The structure never mutates — only content slots fill in.

**Critical implication:** design for permanence. The layout you write is the layout forever. Make it excellent.

### What clients can do after you hand it off

- Edit any text field (click to select, type)
- Swap any image
- Change any link href
- Update YouTube / Vimeo embed URLs
- Adjust text color and background color per element (color picker in inspector)
- Use the AI chat to request content changes in plain English
- **Add new blocks to any section** — clients click the section background → "+ Add block" → pick from 10 block types, even if the designer left no slot there

---

## RULE 1 — No JavaScript

**Scripts are stripped at ingest. Write zero JavaScript.**

`<script>` tags are deleted when the page is imported. The served site is pure HTML + CSS.

This is not a limitation — it produces faster, more accessible, more secure sites. Every interactive pattern below has a CSS-only solution.

### CSS-only interactive patterns

| Pattern | CSS technique |
|---|---|
| Mobile hamburger menu | `<input type="checkbox">` + `<label>` + adjacent sibling selector |
| Accordion / FAQ | `<details>` + `<summary>` (native HTML — no CSS needed) |
| Tab panels | `:target` pseudo-class on `<section id>` anchors |
| Image carousel | `scroll-snap-type` + `scroll-behavior: smooth` |
| Sticky nav | `position: sticky; top: 0` |
| Modal / lightbox | `:target` pseudo-class |
| Dark mode toggle | `<input type="checkbox">` + `:has()` on `<html>` |
| Hover menus | `:hover` + `visibility` + `opacity` transition |
| Animated counters | Not possible without JS — use static numbers |

### Scroll-driven animations (pure CSS, modern)

```css
@keyframes fade-up {
  from { opacity: 0; transform: translateY(40px); }
  to   { opacity: 1; transform: translateY(0); }
}
.animate-on-scroll {
  animation: fade-up linear both;
  animation-timeline: view();
  animation-range: entry 0% entry 30%;
}
```

Supported Chrome 115+, Safari 18+, Firefox 128+.

---

## RULE 2 — Structure your HTML so content is editable

The autotagger walks the DOM looking for **leaf elements** — the deepest element that holds direct text.

**Text that WILL be editable:** `h1`–`h6`, `p`, `li`, `a`, `button`, `span`, `blockquote` — these become editable fields.

**Text that will NOT be editable:** text directly inside `div`, `section`, `nav`, `header`, `footer`, `main`, `ul`, `ol`, `article` is skipped.

**Golden rule: every piece of client-facing copy must live in a leaf phrasing element.**

---

## RULE 3 — Section landmarks with IDs (critical for block addition)

Wrap every logical section in `<section id="...">`. The `id` serves two purposes:

1. Becomes the group label in the CMS editor (`id="hero"` → group "Hero")
2. **Is the target when clients add new blocks** — the block picker inserts inside the clicked section

**Every `<section>` must have an `id`.** Without one, clients cannot target that section for block addition.

```html
<main>
  <section id="hero">...</section>
  <section id="services">...</section>
  <section id="testimonials">...</section>
  <section id="pricing">...</section>
  <section id="faq">...</section>
  <section id="contact">...</section>
</main>
```

Name IDs with lowercase kebab-case. The CMS converts hyphens to spaces and title-cases the label.

---

## RULE 4 — Images

Every `<img>` becomes an editable image slot. Always include descriptive `alt` text — it becomes the field label in the editor.

Use `<img>` (not CSS `background-image`) for anything clients may want to swap. CSS background images are NOT editable.

For full-bleed hero images:

```html
<div class="hero-wrapper">
  <img src="https://..." alt="Hero background" class="hero-bg" />
  <div class="hero-content"><h1>Headline over the image</h1></div>
</div>
```

```css
.hero-wrapper { position: relative; height: 100vh; overflow: hidden; }
.hero-bg { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.hero-content { position: relative; z-index: 1; }
```

---

## RULE 5 — Links and buttons

Every `<a>` and `<button>` with text gets an editable text field and an editable href. Write real href values:

```html
<a href="https://example.com/contact">Get in touch</a>
<a href="mailto:hello@example.com">Email us</a>
<a href="#pricing">See pricing</a>
<button type="button">Start free trial</button>
```

---

## RULE 6 — Video embeds (YouTube / Vimeo)

To make a video embed URL editable by the client, add `data-cms-embed` to the `<iframe>`:

```html
<div class="video-wrapper">
  <iframe
    data-cms-embed
    src="https://www.youtube.com/embed/VIDEO_ID"
    title="Product demo"
    frameborder="0"
    allowfullscreen
  ></iframe>
</div>
```

Responsive 16:9 CSS:

```css
.video-wrapper {
  position: relative;
  padding-bottom: 56.25%;
  height: 0;
  overflow: hidden;
  border-radius: 12px;
}
.video-wrapper iframe {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
```

**Only `data-cms-embed` iframes become editable embed fields.** Plain iframes are frozen in the template.

The CMS only accepts YouTube (`youtube.com/embed/`, `youtu.be/`) and Vimeo (`player.vimeo.com/video/`) URLs.

**Clients who have no embed yet can add one via the block picker — you do not need to pre-place a video slot everywhere.**

---

## RULE 7 — SEO meta tags (put in `<head>`)

```html
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Page Title — Brand Name</title>
  <meta name="description" content="~155 character description for Google." />
  <link rel="icon" href="https://..." />
  <meta property="og:title" content="Page Title" />
  <meta property="og:description" content="Social share blurb." />
  <meta property="og:image" content="https://... 1200x630 image" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="Page Title" />
  <meta name="twitter:description" content="Social share blurb." />
</head>
```

All of these become editable fields in the CMS.

---

## RULE 8 — Collections (repeatable blocks)

Sibling groups with the same tag and 60%+ shared CSS classes are detected as collections (cards, pricing tiers, testimonials, FAQs).

For a "featured" visual state, use a data attribute instead of an extra class (an extra class breaks the 60% similarity threshold):

```html
<div class="pricing-card" data-featured="true">...</div>
```

```css
.pricing-card[data-featured="true"] { border: 2px solid var(--accent); transform: scale(1.03); }
```

---

## RULE 9 — Rich text fields

Put inline formatting at design time to signal that a field supports it. The editor shows a B/I/U toolbar only for fields that had inline children at ingest.

```html
<!-- Allows Bold and Italic in the editor toolbar -->
<p>We build <strong>fast</strong>, <em>beautiful</em> websites for serious businesses.</p>

<!-- Plain text only — no toolbar shown -->
<p>Simple tagline here.</p>
```

---

## Block addition — what clients can add themselves

Clients can click any section background → "+ Add block" → pick a type. No designer pre-placement required.

| Type | What gets inserted |
|---|---|
| Heading | `<h2>` editable heading |
| Paragraph | `<p>` editable body text |
| Image | `<img>` editable image slot |
| YouTube / Vimeo video | Responsive `<iframe data-cms-embed>` — URL editable in inspector |
| Button | `<a>` styled CTA button |
| Quote | `<blockquote>` pull quote |
| Divider | `<hr>` separator |
| Spacer | Vertical whitespace block |
| Two columns | Side-by-side heading + paragraph |
| Image + text | Horizontal image beside heading and paragraph |

Each block is autotagged with non-conflicting IDs and merged into the content model. Existing content is never disturbed.

**Design implication:** you do NOT need to pre-place every possible slot. Design the ideal initial state; clients can grow the page from there.

---

## Color editing (per-element, in inspector)

Every selected element shows a **Color** section in the inspector with two pickers:

- **Text color** — changes the element's foreground text color
- **Background** — changes the element's background color

Values are validated by the Guardian (hex, `rgb()`, `hsl()`, `transparent` only — no arbitrary CSS injection).

Use CSS custom properties for your initial brand palette. Clients can override per-element as needed.

---

## Cutting-edge CSS techniques (use freely)

All CSS is frozen in the template — 100% under your control, never touched by the client or AI.

### Design system with CSS custom properties

```css
:root {
  --brand-hue: 245;
  --brand: hsl(var(--brand-hue) 85% 55%);
  --brand-dark: hsl(var(--brand-hue) 85% 38%);
  --surface: hsl(var(--brand-hue) 15% 8%);
  --surface-mid: hsl(var(--brand-hue) 12% 14%);
  --text: hsl(var(--brand-hue) 20% 92%);
  --text-muted: hsl(var(--brand-hue) 10% 60%);
  --radius: 12px;
  --radius-lg: 24px;
}
```

### Glassmorphism

```css
.glass-card {
  background: rgba(255, 255, 255, 0.06);
  backdrop-filter: blur(24px) saturate(180%);
  -webkit-backdrop-filter: blur(24px) saturate(180%);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: var(--radius-lg);
}
```

### Glow / neon effects

```css
.glow-btn {
  background: var(--brand);
  box-shadow:
    0 0 24px color-mix(in srgb, var(--brand) 60%, transparent),
    0 0 64px color-mix(in srgb, var(--brand) 30%, transparent);
  transition: box-shadow 0.3s ease;
}
.glow-btn:hover {
  box-shadow:
    0 0 32px color-mix(in srgb, var(--brand) 80%, transparent),
    0 0 96px color-mix(in srgb, var(--brand) 50%, transparent);
}
```

### Mesh gradient backgrounds

```css
.mesh-bg {
  background-color: hsl(245 85% 8%);
  background-image:
    radial-gradient(at 20% 20%, hsl(245 85% 30%) 0%, transparent 50%),
    radial-gradient(at 80% 10%, hsl(280 85% 30%) 0%, transparent 40%),
    radial-gradient(at 60% 80%, hsl(200 85% 25%) 0%, transparent 45%);
}
```

### Animated gradient text

```css
@keyframes gradient-shift {
  0%, 100% { background-position: 0% 50%; }
  50%       { background-position: 100% 50%; }
}
.gradient-text {
  background: linear-gradient(135deg, #a78bfa, #60a5fa, #34d399, #a78bfa);
  background-size: 300%;
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  animation: gradient-shift 4s ease infinite;
}
```

### Scroll-driven reveal animations

```css
@keyframes slide-in-left {
  from { opacity: 0; transform: translateX(-60px); }
  to   { opacity: 1; transform: translateX(0); }
}
.reveal-up   { animation: fade-up       linear both; animation-timeline: view(); animation-range: entry 0% entry 25%; }
.reveal-left { animation: slide-in-left linear both; animation-timeline: view(); animation-range: entry 0% entry 25%; }
```

### Bento grid

```css
.bento { display: grid; grid-template-columns: repeat(12, 1fr); gap: 1rem; }
.bento .card-wide  { grid-column: span 8; }
.bento .card-tall  { grid-column: span 4; grid-row: span 2; }
.bento .card-small { grid-column: span 4; }
```

### Modern card hover

```css
.card { transition: transform 0.3s ease, box-shadow 0.3s ease; }
.card:hover { transform: translateY(-6px); box-shadow: 0 32px 64px rgba(0,0,0,0.4); }
```

---

## Complete page structure template

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Site Name — Tagline</title>
  <meta name="description" content="~155 chars." />
  <link rel="icon" href="https://..." />
  <meta property="og:title" content="Site Name" />
  <meta property="og:description" content="~200 chars." />
  <meta property="og:image" content="https://... 1200x630" />
  <meta name="twitter:card" content="summary_large_image" />
  <style>
    /* All CSS here — full creative freedom */
  </style>
</head>
<body>

  <header>
    <nav>
      <a href="/" class="logo-link"><span class="logo-text">Brand</span></a>
      <ul class="nav-links">
        <li><a href="#features">Features</a></li>
        <li><a href="#pricing">Pricing</a></li>
        <li><a href="#contact">Contact</a></li>
      </ul>
      <a href="#contact" class="btn-nav">Get started</a>
    </nav>
  </header>

  <main>
    <section id="hero">
      <h1>Your compelling headline</h1>
      <p class="hero-sub">Supporting subheadline that clarifies the value prop.</p>
      <div class="hero-ctas">
        <a href="#contact" class="btn btn-primary">Primary action</a>
        <a href="#features" class="btn btn-ghost">Learn more</a>
      </div>
      <img src="https://..." alt="Hero illustration" class="hero-img" />
    </section>

    <section id="features">
      <h2>Section heading</h2>
      <p class="section-sub">Optional section subtext.</p>
      <div class="features-grid">
        <div class="feature-card">
          <img src="https://..." alt="Feature icon" class="feature-icon" />
          <h3>Feature name</h3>
          <p>Feature description goes here.</p>
        </div>
        <!-- Repeat .feature-card with identical classes for collection detection -->
      </div>
    </section>

    <!-- Add data-cms-embed to make the video URL swappable by the client -->
    <section id="demo">
      <h2>See it in action</h2>
      <div class="video-wrapper">
        <iframe
          data-cms-embed
          src="https://www.youtube.com/embed/dQw4w9WgXcQ"
          title="Product demo"
          frameborder="0"
          allowfullscreen
        ></iframe>
      </div>
    </section>

    <section id="testimonials">
      <h2>What clients say</h2>
      <div class="testimonials-grid">
        <div class="testimonial-card">
          <blockquote>The exact quote from the client goes here verbatim.</blockquote>
          <p class="testimonial-author">Jane Smith, CEO of Acme</p>
          <img src="https://..." alt="Jane Smith" class="avatar" />
        </div>
        <!-- Repeat .testimonial-card -->
      </div>
    </section>

    <section id="pricing">
      <h2>Simple, transparent pricing</h2>
      <div class="pricing-grid">
        <div class="pricing-card">
          <h3>Plan name</h3>
          <p class="price">$XX/mo</p>
          <p class="price-sub">Billed annually</p>
          <ul class="feature-list">
            <li>Feature one</li>
            <li>Feature two</li>
            <li>Feature three</li>
          </ul>
          <a href="#contact" class="btn btn-primary">Get started</a>
        </div>
        <!-- Repeat .pricing-card -->
      </div>
    </section>

    <section id="faq">
      <h2>Frequently asked questions</h2>
      <div class="faq-list">
        <details>
          <summary>Question text here?</summary>
          <p>Answer goes here.</p>
        </details>
        <!-- Repeat details -->
      </div>
    </section>

    <section id="contact">
      <h2>Get in touch</h2>
      <p>A short invitation to reach out.</p>
      <a href="mailto:hello@example.com" class="btn btn-primary">Email us</a>
    </section>
  </main>

  <footer>
    <p class="footer-brand">Brand Name</p>
    <p class="footer-copy">2025 Brand Name. All rights reserved.</p>
    <nav class="footer-links">
      <a href="/privacy">Privacy</a>
      <a href="/terms">Terms</a>
    </nav>
  </footer>

</body>
</html>
```

---

## Checklist before finalizing

- [ ] Zero `<script>` tags
- [ ] Every piece of copy lives in a leaf phrasing element (`h1`–`h6`, `p`, `li`, `a`, `button`, `span`, `blockquote`)
- [ ] No raw text directly in `<div>`, `<section>`, `<nav>`, `<header>`, `<footer>`, `<main>`
- [ ] Every `<section>` has a meaningful `id="..."` — required for block addition targeting
- [ ] All repeating card/item blocks use identical class names across siblings
- [ ] All images have descriptive `alt` text
- [ ] All links have real `href` values
- [ ] Full SEO `<head>` with title, description, og:*, twitter:*
- [ ] All interactive patterns (menu, FAQ, tabs) use CSS-only techniques
- [ ] Responsive — works on mobile (375px) and desktop (1440px) with no JS
- [ ] Viewport meta tag present
- [ ] All asset URLs are absolute (`https://...`)
- [ ] YouTube/Vimeo iframes that clients should update have `data-cms-embed` attribute
- [ ] Decorative/non-editable iframes do NOT have `data-cms-embed`


---

## Multi-page sites

Claude CMS is a full multi-page CMS. Each page has its own frozen template and content model.

### How pages work

- **Each page is a separate HTML file.** Ingest them one at a time via the dashboard.
- **The home page drives the visual DNA of all other pages.** When you add a new page, the CMS strips the home page main content and replaces it with a starter layout — keeping the header, footer, nav, and all CSS intact. Design the home page first; everything inherits from it.
- **Each page has its own content model** — editable fields are per-page, independently versioned.
- **Live URLs:** home page at `/live/<site-name>`, other pages at `/live/<site-name>/<slug>`.

---

### RULE MP1 — Design the home page as the master template

The header, footer, nav, and `<style>` block from the home page are cloned into every new page the CMS creates. This means:

- Put your **entire CSS** in the home page `<style>` block — it propagates to all pages automatically.
- Put your **nav** and **footer** in the home page — they appear on every page.
- Design the home page as if it is the only file you control. It is.

---

### RULE MP2 — Navigation links between pages

Use the page slug as the href. The CMS maps slugs to live paths:

```html
<a href="/">Home</a>
<a href="/about">About</a>
<a href="/services">Services</a>
<a href="/contact">Contact</a>
<a href="/blog">Blog</a>
```

Slugs are lowercase kebab-case, auto-derived from the page title at creation time
(e.g., "Our Services" becomes `/our-services`).

In the editor, inter-page links navigate the editor to that page.
External links and anchor links (`#section`) are intercepted to prevent leaving the editor.

---

### RULE MP3 — The nav must list all pages

Put all page links in the main nav at design time. The number of nav items is frozen in the template — clients can edit the text and href of each link, but cannot add or remove nav items.

```html
<nav>
  <a href="/" class="logo-link"><span class="logo-text">Brand</span></a>
  <ul class="nav-links">
    <li><a href="/">Home</a></li>
    <li><a href="/about">About</a></li>
    <li><a href="/services">Services</a></li>
    <li><a href="/blog">Blog</a></li>
    <li><a href="/contact">Contact</a></li>
  </ul>
  <a href="/contact" class="btn-nav">Get started</a>
</nav>
```

---

### RULE MP4 — Each page needs its own SEO meta

Every page file must have its own `<title>` and `<meta name="description">`. These become separately editable SEO fields per page.

```html
<!-- Home page -->
<title>Brand Name — Tagline</title>
<meta name="description" content="Home page description." />

<!-- About page -->
<title>About Us — Brand Name</title>
<meta name="description" content="Learn about our team and mission." />

<!-- Services page -->
<title>Services — Brand Name</title>
<meta name="description" content="What we offer and how we work." />
```

---

### RULE MP5 — Each non-home page must be a complete HTML file

When handing Steve pre-built page files (rather than using the dashboard's "add page"), each file must be complete and self-contained — same header, same CSS, same footer as the home page.

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Page Title — Brand Name</title>
  <meta name="description" content="Page-specific description." />
  <style>/* EXACT same CSS as the home page */</style>
</head>
<body>

  <!-- IDENTICAL header/nav as home page -->
  <header>
    <nav>...</nav>
  </header>

  <main>
    <section id="page-hero">
      <h1>Page heading</h1>
      <p class="hero-sub">Page subheading.</p>
    </section>

    <section id="content">
      <!-- Page body here -->
    </section>
  </main>

  <!-- IDENTICAL footer as home page -->
  <footer>...</footer>

</body>
</html>
```

---

### RULE MP6 — Section IDs are scoped per page

Two different pages can both have `<section id="hero">` — that is fine. Each page has its own content model. Section IDs only need to be unique within a single page.

---

### Common page types and suggested section structure

| Page | Suggested sections |
|---|---|
| **Home** | hero, features, testimonials, pricing, faq, contact |
| **About** | about-hero, team, story, values, contact |
| **Services** | services-hero, services-list, process, pricing, contact |
| **Blog index** | blog-hero, posts (collection of .post-card items) |
| **Blog post** | article (single article with h1, subhead, paragraphs, img) |
| **Contact** | contact-hero, contact-info |
| **Pricing** | pricing-hero, pricing-grid, faq, cta |

---

### Multi-page checklist

- [ ] Home page has the complete CSS, nav, and footer that all other pages will inherit
- [ ] Nav contains a link for every page using slug-based hrefs (`/about`, `/services`, etc.)
- [ ] Every non-home page is a complete standalone HTML file (same header, CSS, footer)
- [ ] Every page has its own unique `<title>` and `<meta name="description">`
- [ ] Section IDs are unique within each page (repeating across pages is fine)
- [ ] All pages follow Rules 1–9 (no JS, leaf elements, section IDs, data-cms-embed, etc.)
- [ ] Cross-page links use the slug path (`/about`), not absolute URLs or `/live/...` paths
