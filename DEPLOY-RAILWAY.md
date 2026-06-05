# Deploy Claude CMS to Railway

**Goal:** one Railway project running two services — this **Node app** (your dashboard + every client's live site) and a **MongoDB** database (persistent storage). No Vercel. No MongoDB Atlas.

Why MongoDB on Railway and not just files: Railway wipes a container's local disk on every redeploy. The database keeps your sites, versions, passwords and form submissions safe across redeploys. Your code already supports this — it switches to MongoDB automatically the moment `MONGODB_URI` is set.

---

## What you need
- A Railway account → https://railway.com (sign in with GitHub or email).
- This folder pushed to a GitHub repo *(recommended path)* **or** the Railway CLI installed.

---

## Path A — Deploy from GitHub (recommended, auto-redeploys)

1. Push this folder to a new GitHub repo (private is fine).
2. Railway → **New Project → Deploy from GitHub repo** → pick the repo. Railway auto-detects Node and builds it.
3. In the project, click **+ New → Database → Add MongoDB**. Railway provisions it with a persistent volume.
4. Open the **MongoDB service → Variables/Connect** and copy its connection string (`MONGO_URL` / `MONGO_PUBLIC_URL`).
5. Open the **app service → Variables** and add:
   | Variable | Value |
   |---|---|
   | `MONGODB_URI` | *(paste the Mongo connection string)* |
   | `ADMIN_KEY` | *(your private master key — make one up)* |
   | `OPENROUTER_API_KEY` | *(optional — enables chat editing)* |
   | `OPENROUTER_MODEL_ID` | *(optional — e.g. `anthropic/claude-sonnet-4.5`)* |
   - Tip: instead of pasting, you can reference the DB service: `MONGODB_URI = ${{MongoDB.MONGO_URL}}`.
6. App service → **Settings → Networking → Generate Domain** to get a public URL.
7. Visit `https://<your-domain>/admin/?key=<your ADMIN_KEY>` — that's your dashboard.

Future code changes: just `git push` → Railway redeploys automatically. Content/site edits don't touch git — they live in MongoDB.

---

## Path B — Deploy with the Railway CLI (no GitHub)

```bash
npm i -g @railway/cli
railway login
railway init                 # create a new project
railway add --database mongo  # add MongoDB
railway up                   # upload & deploy this directory
```
Then set the same variables as above:
```bash
railway variables --set "ADMIN_KEY=<your-secret>"
railway variables --set "MONGODB_URI=${{MongoDB.MONGO_URL}}"
# optional:
railway variables --set "OPENROUTER_API_KEY=sk-or-..."
railway variables --set "OPENROUTER_MODEL_ID=anthropic/claude-sonnet-4.5"
railway domain              # generate a public URL
```

---

## Verify it worked
- Railway app **Deploy Logs** should show the boot line and storage mode `mongodb` (not `filesystem`).
- Open `…/admin/?key=<ADMIN_KEY>` → add a test site → edit → Publish.
- Trigger a redeploy (or `railway up` again) and reload — your test site should still be there. That proves persistence is working without Atlas.

## Required env vars (summary)
| Var | Required | Purpose |
|---|---|---|
| `MONGODB_URI` | ✅ on Railway | Persistent storage (Railway Mongo) |
| `ADMIN_KEY` | ✅ | Owner dashboard master key |
| `OPENROUTER_API_KEY` | optional | Natural-language chat editing (OpenRouter) |
| `OPENROUTER_MODEL_ID` | optional | Model slug (default `anthropic/claude-sonnet-4.5`) |
| `MONGODB_DB` | optional | DB name (default `claude_cms`) |
| `PORT` | auto | Railway sets this; the app already reads it |
