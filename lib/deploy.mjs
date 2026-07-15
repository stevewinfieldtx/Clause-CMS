/**
 * deploy.mjs — the deploy seam. Publishing = render a static bundle, STAGE it
 * immutably (keyed by version), then ATOMICALLY activate it (flip one pointer).
 * The live site is just "read pointer → serve that immutable release", so it can
 * never half-deploy and rollback is an instant pointer flip.
 *
 * LocalAdapter implements this on disk today (Railway). A different adapter
 * could implement the SAME interface (stage = upload bundle, activate =
 * re-alias the production domain) with zero pipeline changes.
 *
 *   interface DeployAdapter {
 *     stage(siteDir, versionId, files)  // write release, NO cutover
 *     activate(siteDir, versionId)       // atomic pointer flip → live
 *     current(siteDir)                   // active versionId or null
 *     exportTo(siteDir, destDir)         // standalone static export (eject)
 *   }
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, cpSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export class LocalAdapter {
  releasesDir(siteDir) { return join(siteDir, 'releases'); }

  // files: [{ path, content }]  — path relative to the release root
  stage(siteDir, versionId, files) {
    const dir = join(this.releasesDir(siteDir), String(versionId));
    mkdirSync(dir, { recursive: true });
    for (const f of files) {
      const dest = join(dir, f.path);
      mkdirSync(join(dest, '..'), { recursive: true });
      writeFileSync(dest, f.content);
    }
    return { releaseRef: String(versionId), path: dir };
  }

  // The ONLY "go live" step — atomic single-pointer write.
  activate(siteDir, versionId) {
    mkdirSync(this.releasesDir(siteDir), { recursive: true });
    writeFileSync(join(this.releasesDir(siteDir), 'current.json'), JSON.stringify({ versionId: String(versionId), at: new Date().toISOString() }));
  }

  current(siteDir) {
    const p = join(this.releasesDir(siteDir), 'current.json');
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf8')).versionId;
  }

  // Serve a file from the active release (index.html, or <slug>.html for a page).
  liveHtml(siteDir, file = 'index.html') {
    const v = this.current(siteDir);
    if (v == null) return null;
    const p = join(this.releasesDir(siteDir), String(v), file);
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
  }

  hasRelease(siteDir, versionId) {
    return existsSync(join(this.releasesDir(siteDir), String(versionId), 'index.html'));
  }

  // Eject: copy the active release + local assets into a standalone folder the
  // agency can hand over or deploy anywhere static hosting is accepted.
  exportTo(siteDir, destDir) {
    const v = this.current(siteDir);
    if (v == null) throw new Error('Nothing published to export.');
    mkdirSync(destDir, { recursive: true });
    cpSync(join(this.releasesDir(siteDir), String(v)), destDir, { recursive: true });
    const assets = join(siteDir, '..', '..', 'site', 'assets'); // legacy local assets
    if (existsSync(assets)) cpSync(assets, join(destDir, 'assets'), { recursive: true });
    return { destDir, files: readdirSync(destDir) };
  }
}

export const deployer = new LocalAdapter();
