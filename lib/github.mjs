/**
 * github.mjs — GitHub deploy adapter. The CMS mirrors a site's rendered pages
 * into a working BRANCH of the site's own repo as the client edits; Publish
 * merges that branch into main, and the site's host (e.g. Railway watching
 * main) redeploys. Uses the git data API so each sync is ONE commit no matter
 * how many files changed.
 *
 * Auth: GITHUB_TOKEN env var on the CMS service (fine-grained PAT with
 * contents read/write on the site repos). No token or no repo configured on a
 * site ⇒ every function is a silent no-op, and the CMS's own /live serving
 * still works as before.
 */
import { getConfig } from './config.mjs';

const API = 'https://api.github.com';

export function ghToken() { return process.env.GITHUB_TOKEN || getConfig().githubToken || ''; }

async function gh(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${ghToken()}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

const refPath = (repo, branch) => `/repos/${repo}/git/ref/${encodeURIComponent(`heads/${branch}`)}`;

async function headSha(repo, branch) {
  const r = await gh('GET', refPath(repo, branch));
  return r.status === 200 ? r.json.object.sha : null;
}

/** Commit `files` ([{path, content}] for text, or [{path, base64}] for binary
 *  — e.g. an uploaded image) onto `branch` (created from `base` if missing)
 *  as ONE commit. Returns {ok, sha} or {ok:false, error}. */
export async function pushFilesToBranch({ repo, branch, base = 'main', files, message }) {
  if (!ghToken() || !repo || !files?.length) return { ok: false, error: 'not configured', skipped: true };
  try {
    let head = await headSha(repo, branch);
    if (!head) {
      const baseSha = await headSha(repo, base);
      if (!baseSha) return { ok: false, error: `Base branch "${base}" not found on ${repo}.` };
      const c = await gh('POST', `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: baseSha });
      if (c.status !== 201) return { ok: false, error: `Could not create branch: ${c.json.message || c.status}` };
      head = baseSha;
    }
    const headCommit = await gh('GET', `/repos/${repo}/git/commits/${head}`);
    if (headCommit.status !== 200) return { ok: false, error: `Could not read branch head: ${headCommit.json.message || headCommit.status}` };
    // Binary files (base64) must become blob objects first — the trees API's
    // inline "content" field is always interpreted as UTF-8 text and would
    // corrupt anything else.
    const treeEntries = [];
    for (const f of files) {
      if (f.base64 != null) {
        const b = await gh('POST', `/repos/${repo}/git/blobs`, { content: f.base64, encoding: 'base64' });
        if (b.status !== 201) return { ok: false, error: `Could not upload "${f.path}": ${b.json.message || b.status}` };
        treeEntries.push({ path: f.path, mode: '100644', type: 'blob', sha: b.json.sha });
      } else {
        treeEntries.push({ path: f.path, mode: '100644', type: 'blob', content: f.content });
      }
    }
    const tree = await gh('POST', `/repos/${repo}/git/trees`, { base_tree: headCommit.json.tree.sha, tree: treeEntries });
    if (tree.status !== 201) return { ok: false, error: `Could not build tree: ${tree.json.message || tree.status}` };
    const commit = await gh('POST', `/repos/${repo}/git/commits`, { message, tree: tree.json.sha, parents: [head] });
    if (commit.status !== 201) return { ok: false, error: `Could not create commit: ${commit.json.message || commit.status}` };
    const upd = await gh('PATCH', refPath(repo, branch).replace('/ref/', '/refs/'), { sha: commit.json.sha });
    if (upd.status !== 200) return { ok: false, error: `Could not move branch: ${upd.json.message || upd.status}` };
    return { ok: true, sha: commit.json.sha };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** Merge `branch` into `base` (Publish). On a conflict (main changed under
 *  us), the branch is force-reset to main, the files recommitted, and the
 *  merge retried — the CMS's rendered output is the source of truth for the
 *  files it owns. */
export async function mergeBranchToMain({ repo, branch, base = 'main', files, message }) {
  if (!ghToken() || !repo) return { ok: false, error: 'not configured', skipped: true };
  try {
    const attempt = () => gh('POST', `/repos/${repo}/merges`, { base, head: branch, commit_message: message });
    let m = await attempt();
    if (m.status === 409 && files?.length) {
      const baseSha = await headSha(repo, base);
      const rs = await gh('PATCH', refPath(repo, branch).replace('/ref/', '/refs/'), { sha: baseSha, force: true });
      if (rs.status !== 200) return { ok: false, error: `Conflict, and branch reset failed: ${rs.json.message || rs.status}` };
      const p = await pushFilesToBranch({ repo, branch, base, files, message });
      if (!p.ok) return p;
      m = await attempt();
    }
    if (m.status === 201) return { ok: true, sha: m.json.sha };
    if (m.status === 204) return { ok: true, sha: null, upToDate: true }; // nothing to merge
    return { ok: false, error: m.json.message || `merge failed (${m.status})` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
