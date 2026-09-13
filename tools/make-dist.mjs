/* ============================================================================
   Perch — tools/make-dist.mjs
   Builds dist/perch-<version>.eagleplugin — the installable Eagle package.

   The repository root *is* the plugin (there is no build step), so this does not
   compile anything: it collects the runtime files, packs them into a ZIP with
   manifest.json at the archive root, and writes it with Eagle's extension.
   Development tooling, marketing assets and version control stay out.

   Run:  node tools/make-dist.mjs
   ========================================================================== */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, rmdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createZip } from './zip.mjs';
import { packageEntries, packageName, EXCLUDED } from './package-files.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

/* ── the manifest is the source of truth for the package name ── */

const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
if (!manifest.version) {
    console.error('manifest.json has no version — refusing to build');
    process.exit(1);
}

// The runtime reports this same version in Diagnostics; drift would mean the
// plugin cannot tell the user which build they are running.
const appVersion = (readFileSync(join(root, 'js/app.js'), 'utf8').match(/const PERCH_VERSION = '([^']+)'/) || [])[1];
if (appVersion !== manifest.version) {
    console.error('version mismatch: manifest.json says ' + manifest.version +
                  ', js/app.js says ' + (appVersion || '(missing)'));
    console.error('run node tools/check.mjs for the full report');
    process.exit(1);
}

/* ── pack ── */

const entries = packageEntries(root);
const archive = createZip(entries);
const target = join(dist, packageName(manifest.version));

mkdirSync(dist, { recursive: true });

// Anything in dist/ that is not this build is a previous artefact — including
// the unpacked copy an earlier version of this tool produced. Remove the files
// individually; deleting the directory itself is unreliable under some sandboxes.
let removed = 0;
for (const name of readdirSync(dist)) {
    if (name === packageName(manifest.version)) continue;
    const full = join(dist, name);
    if (statSync(full).isDirectory()) {
        for (const inner of readdirSync(full)) unlinkSync(join(full, inner));
        try { rmdirSync(full); } catch (e) { /* ignore */ }
    } else {
        unlinkSync(full);
    }
    console.log('  removed stale ' + name);
    removed++;
}

writeFileSync(target, archive);

/* ── report ── */

console.log('dist/' + packageName(manifest.version) + '  (' + manifest.name + ' ' + manifest.version + ')');
let raw = 0;
for (const entry of entries) {
    raw += entry.data.length;
    console.log('  ' + entry.name.padEnd(24) + (entry.data.length / 1024).toFixed(1) + ' KB');
}
console.log('');
console.log(entries.length + ' files, ' + (raw / 1024).toFixed(0) + ' KB raw → ' +
            (archive.length / 1024).toFixed(0) + ' KB packed' + (removed ? ', ' + removed + ' stale item(s) removed' : ''));
console.log('excluded on purpose: ' + EXCLUDED.join(', '));
