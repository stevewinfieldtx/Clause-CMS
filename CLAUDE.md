# CLAUDE.md — guidance for the AI assistant

> ## ⛔ STANDING RULE — READ FIRST (Steve's environment)
> **Production is Railway. ONLY Railway.** Steve does not use Vercel and has not for months.
> - **Never** suggest, mention, configure, or default to Vercel (or Netlify) for hosting, publishing, or deploys.
> - This CMS is hosted as a single Node service on **Railway**, with a **Railway-hosted MongoDB** for storage. No MongoDB Atlas.
> - The CMS server serves the live client sites itself (`/live/:name`, `/s/:name`) — there is no separate static host. "Publish" activates a release that this same Railway app serves.
> - If any file, doc, or template still references Vercel, treat it as legacy and convert to the Railway model.

---

You are helping Steve, who runs **Claude CMS** and deploys everything on Railway. This file tells you what the project is and how to guide him. The human-facing version is **`START-HERE.md`**.

## What this project is

Claude CMS is an AI-native client CMS (Node + Express). One dashboard to manage every website Steve builds. He drops in a site he's already built, hands it to a client with a password, and the client edits their own content — by clicking text or chatting in plain English. **The AI never writes code** — it only fills content slots against a frozen template, and every change is validated by a deterministic **Guardian**, so the layout can't break. Changes are version-controlled and served live by this same app on Railway.

## Run it locally (for testing)

```bash
npm install
ADMIN_KEY=<secret> npm start
```
Then open the dashboard: `http://localhost:4321/admin/?key=<secret>`

- `ADMIN_KEY` is the owner master key (defaults to `owner-dev` if unset — always override it).
- No database is required locally — it runs on the filesystem. `MONGODB_URI` (env) switches to central MongoDB storage. **On Railway, MONGODB_URI must be set** (container filesystem is wiped on every redeploy).

## Production model — Railway

- **One Railway service** runs this Node app (dashboard + every client's live site).
- **One Railway MongoDB service** holds all site data, versions, passwords, forms — the persistent source of truth. Set `MONGODB_URI` on the app from the Mongo service.
- The app reads `process.env.PORT` (Railway injects it) — no change needed.
- AI editing uses **OpenRouter** by default. Set `OPENROUTER_API_KEY` (and optionally `OPENROUTER_MODEL_ID`) as **env vars** so they survive redeploys, rather than only the UI (`cms-config.json` lives on the ephemeral fs and resets on redeploy).

### Required Railway env vars
| Var | Purpose |
|---|---|
| `MONGODB_URI` | Railway Mongo connection string — persistent storage (required) |
| `ADMIN_KEY` | Owner master key for the dashboard (required — don't leave default) |
| `OPENROUTER_API_KEY` | Natural-language chat editing (optional; click-to-edit works without it) |
| `OPENROUTER_MODEL_ID` | Optional model slug (defaults to `anthropic/claude-sonnet-4.5`) |
| `MONGODB_DB` | Optional DB name override (defaults to `claude_cms`) |

## The process — 4 steps

1. **Ingest** — Dashboard → **➕ Add a website** → paste a live URL (or raw HTML). Backend: `POST /api/ingest {name, url}`.
2. **Edit** — Open the editor; click any text/image to edit, or use the chat (chat needs an AI key).
3. **Hand off** — On the site's card, set a password; send the client the editor link. They edit only their own site.
4. **Publish** — Activates an immutable release; this Railway app immediately serves it live at `/live/<name>`. No external host, no tokens.

## Architecture / key files

```
server.mjs        # Express app: routes, multi-site/page model, persistence, serving live sites
lib/store.mjs     # storage layer — MongoDB (prod) or filesystem (local)
lib/autotag.mjs   # ingest: tag editable content, freeze structure
lib/render.mjs    # deterministic render of template + content
lib/guardian.mjs  # validates EVERY change (the safety layer — plain code, no AI)
lib/agent.mjs     # AI planner: chat → safe changeset (optional; Anthropic/OpenRouter)
lib/deploy.mjs    # release staging + activation (LocalAdapter serves live; legacy Vercel fn unused)
lib/fields.mjs    # SEO + bounded style + link virtual fields
admin/index.html  # owner dashboard (Agency Console)
editor/index.html # in-browser editor (owner + client)
sites/<name>/     # per-site content/versions (local cache; canonical copy in Mongo in prod)
```

## Rules for you (the assistant)

- **Railway only — never Vercel.** (See standing rule at top.)
- **Never commit, print, or paste secrets.** `cms-config.json` and `.env` are gitignored.
- **Don't bypass the Guardian.** The AI must only emit structured content ops against the frozen content model — never raw HTML/CSS to the live site.
- Click-to-edit and the Guardian need no API key and cost nothing. Only the chat uses a model.
- Run behind HTTPS in production (Railway provides this on its domains).

## Read more

- `START-HERE.md` — human getting-started guide.
- `HANDOVER.md` — full product walkthrough.
- `DEPLOY-RAILWAY.md` — step-by-step Railway deploy (app + MongoDB).
