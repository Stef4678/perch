/* ============================================================================
   Perch — tools/package-files.mjs
   What goes into a .eagleplugin, defined once.

   Eagle's package criteria are strict about this list: runtime files only, no
   development tooling, no marketing assets, no nested archives, no version
   control. tools/make-dist.mjs builds from it and tools/check.mjs verifies
   against it, so the two can never disagree about what "the package" means.
   ========================================================================== */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Runtime files and directories, relative to the project root. */
export const RUNTIME = [
    'manifest.json',
    'index.html',
    'logo.png',
    'LICENSE',
    'README.md',
    'css',
    'js'
];

/** Present in the repository, deliberately absent from the package. */
export const EXCLUDED = ['tools/', 'assets/', 'dist/', '.gitignore', '.git/'];

/** The package filename for a given manifest version. */
export function packageName(version) {
    return 'perch-' + version + '.eagleplugin';
}

function walkFiles(dir, base, out) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walkFiles(full, base, out);
        else out.push(relative(base, full).replace(/\\/g, '/'));
    }
    return out;
}

/**
 * The exact file list the package should contain, sorted. Derived from the
 * source tree rather than hard-coded, so a new module cannot be forgotten.
 */
export function runtimeFiles(root) {
    const files = [];
    for (const item of RUNTIME) {
        const full = join(root, item);
        let stat;
        try {
            stat = statSync(full);
        } catch (e) {
            throw new Error('missing from the source tree: ' + item);
        }
        if (stat.isDirectory()) files.push(...walkFiles(full, root, []));
        else files.push(item);
    }
    return files.sort();
}

/** [{ name, data }] ready for tools/zip.mjs. */
export function packageEntries(root) {
    return runtimeFiles(root).map((name) => ({
        name,
        data: readFileSync(join(root, name))
    }));
}

/** Anything in the repository that must never appear in a package. */
export function isForbiddenEntry(name) {
    if (name.startsWith('tools/') || name.startsWith('assets/') || name.startsWith('dist/')) return true;
    if (name === '.gitignore' || name.startsWith('.git/')) return true;
    if (/\.(zip|rar|7z|tar|tgz|gz|dmg|iso)$/i.test(name)) return true;
    if (/\.(env|pem|key|p12|pfx)$/i.test(name) || /(^|\/)(credentials|secrets)\.json$/i.test(name)) return true;
    return false;
}
