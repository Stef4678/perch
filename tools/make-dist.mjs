/* ============================================================================
   Perch — tools/make-dist.mjs
   Builds dist/: the plugin exactly as it should be packaged.

   An Eagle plugin has no build step — the repository root *is* the plugin — so
   dist/ is not a compilation output. It is the shipping subset: the runtime
   files only, with the development tooling and marketing assets removed, which
   is what you point Eagle at (or zip) when publishing.

   Run:  node tools/make-dist.mjs
   ========================================================================== */
import { readFileSync, mkdirSync, cpSync, statSync, readdirSync, unlinkSync, rmdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

/** Everything the plugin needs at runtime, plus its licence and readme. */
const INCLUDE = [
    'manifest.json',
    'index.html',
    'logo.png',
    'LICENSE',
    'README.md',
    'css',
    'js'
];

/** Deliberately absent: tools/ (dev checks), assets/ (cover art), .gitignore. */
const EXCLUDE_NOTE = ['tools/', 'assets/', '.gitignore', '.git/'];

/* ── sanity-check the source before building anything ── */

const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const appSource = readFileSync(join(root, 'js/app.js'), 'utf8');
const appVersion = (appSource.match(/const PERCH_VERSION = '([^']+)'/) || [])[1];

if (!manifest.version) {
    console.error('manifest.json has no version — refusing to build');
    process.exit(1);
}
if (appVersion !== manifest.version) {
    console.error('version mismatch: manifest.json says ' + manifest.version +
                  ', js/app.js says ' + (appVersion || '(missing)'));
    console.error('run node tools/check.mjs for the full report');
    process.exit(1);
}

/* ── build ── */

/**
 * Sync rather than wipe-and-recreate: deleting the dist directory outright hits
 * EPERM under some Windows sandboxes, and a sync is the better semantic anyway —
 * stale files from a previous build must not survive, but nothing else needs to
 * be destroyed. Prune to the expected set first, then copy over it.
 */

function walkFiles(dir, base, out) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walkFiles(full, base, out);
        else out.push(relative(base, full).replace(/\\/g, '/'));
    }
    return out;
}

/** The exact set of files dist/ should contain, derived from the source tree. */
const expected = new Set();
for (const entry of INCLUDE) {
    const from = join(root, entry);
    try {
        if (!statSync(from)) throw new Error('missing');
    } catch (e) {
        console.error('missing from the source tree: ' + entry);
        process.exit(1);
    }
    if (statSync(from).isDirectory()) {
        for (const rel of walkFiles(from, root, [])) expected.add(rel);
    } else {
        expected.add(entry);
    }
}

mkdirSync(dist, { recursive: true });

/* Prune anything a previous build left behind. */
if (readdirSync(dist).length) {
    let pruned = 0;
    for (const rel of walkFiles(dist, dist, [])) {
        if (!expected.has(rel)) {
            unlinkSync(join(dist, rel));
            console.log('  pruned ' + rel);
            pruned++;
        }
    }
    // Tidy directories left empty by pruning; failure here is harmless.
    const dirs = [];
    const collectDirs = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) {
                const full = join(dir, entry.name);
                collectDirs(full);
                dirs.push(full);
            }
        }
    };
    collectDirs(dist);
    for (const dir of dirs) {
        try { if (!readdirSync(dir).length) rmdirSync(dir); } catch (e) { /* ignore */ }
    }
    if (!pruned) console.log('  nothing to prune');
}

for (const entry of INCLUDE) {
    cpSync(join(root, entry), join(dist, entry), { recursive: true });
}

/** Walk dist and report what was produced. */
let files = 0;
let bytes = 0;

function walk(dir) {
    for (const name of readdirSync(dir).sort()) {
        const full = join(dir, name);
        const stat = statSync(full);
        if (stat.isDirectory()) {
            walk(full);
        } else {
            files++;
            bytes += stat.size;
            console.log('  ' + relative(dist, full).replace(/\\/g, '/') +
                        '  ' + (stat.size / 1024).toFixed(1) + ' KB');
        }
    }
}

console.log('dist/ — Perch ' + manifest.version + ' (' + manifest.name + ')');
walk(dist);
console.log('');
console.log(files + ' files, ' + (bytes / 1024).toFixed(0) + ' KB');
console.log('excluded on purpose: ' + EXCLUDE_NOTE.join(', '));
