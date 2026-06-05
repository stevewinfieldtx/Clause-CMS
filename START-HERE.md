# Claude CMS — Start Here

**One dashboard to manage every website you build — and hand any of them to a client with just a password.**

The client edits their own site by clicking text or chatting in plain English. The AI never writes code, so they can't break the design. Every change is version-controlled and publishes straight to their live domain.

You set this up **once**. Every website you ever manage lives inside it.

---

## Run it (2 minutes)

You'll need [Node.js](https://nodejs.org) installed. Then, in this folder:

```bash
npm install
ADMIN_KEY=your-secret npm start
```

Open your dashboard:

```
http://localhost:4321/admin/?key=your-secret
```

> `ADMIN_KEY` is your **master key** — pick anything, keep it private. It's the only thing that unlocks the owner dashboard.

That's the whole install. No database required to start (it runs on your local filesystem). Scale up later by connecting MongoDB — see *Optional connections* below.

---

## The process — 4 steps

### 1 · Ingest a website
In the dashboard, click **➕ Add a website**, give it a short name, and paste the URL of a site you've **already built and deployed** (or paste its raw HTML).

The CMS fetches it and automatically:
- makes every heading, paragraph, button, image and link **editable**,
- locks the layout and structure so they **can't be broken**,
- generates SEO fields, a sitemap and robots.txt.

The site now shows up as a card in your dashboard.

### 2 · Edit it
Open the editor. **Click any text, button or image and type** — changes preview instantly. Or use the chat: *"make the headline punchier."*

Click-to-edit needs nothing. The chat needs an AI key (see below).

### 3 · Hand it to the client
On the site's card, **set a password** and send the client the editor link. They log in with just that password — no account, no username — edit **only their own site**, and never see anyone else's.

Optionally tick **"require my approval"** so nothing they change goes live until you sign off.

### 4 · Publish
Hit **Publish**. With Vercel connected, it deploys a fresh production build **straight to that site's live domain** — no Git, no rebuild, live in seconds. Without Vercel, Publish just updates the local preview.

**That's the entire workflow. It isn't more complicated than that.**

---

## Optional connections (all set in the dashboard)

- **🤖 AI editing** — paste an **Anthropic** (`sk-ant-…`) or **OpenRouter** (`sk-or-…`) key to turn on natural-language chat editing. Click-to-edit works perfectly without it; your key is stored on your own server and never shown again.
- **▲ Vercel hosting** — paste a Vercel token from [vercel.com/account/tokens](https://vercel.com/account/tokens) to publish sites live. Each site links to its own Vercel project.
- **🍃 MongoDB** *(optional)* — set a `MONGODB_URI` environment variable to keep every site, version, password and form submission in one central, portable database. Leave it unset and everything lives on the local filesystem — great for trying it out.

---

## Why a client can never break it

- **The AI never writes code.** It only fills content slots against a frozen template — the layout is literally unreachable.
- **The Guardian.** Every single change is validated by deterministic code before it's allowed. It's plain logic — no AI, no API key, no cost.
- **Draft → Publish.** Nothing goes live until you (or the client) Publish. Saving keeps a private draft.
- **Version control + rollback.** Every publish is an immutable snapshot. One click restores any previous version, and an activity log shows who changed what, when.

---

## Roles

| | **You — the owner** | **The client** |
|---|---|---|
| Access | Master key — sees & controls everything | One password — their site only |
| Can | Add sites, edit anything, set passwords, connect AI + hosting, read the audit log | Edit their own content, publish (or submit for approval) |
| Cannot | — | See or touch any other site |

---

## Where to go deeper

- **`HANDOVER.md`** — the full product walkthrough.
- **`how-it-works.html`** / **`SETUP.html`** — visual guides (open in a browser).
- **`README.md`** — architecture + project structure.

---

*Build it in Claude. Hand it to the client. Never touch it again.*
