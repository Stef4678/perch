/* ============================================================================
   Perch — tools/check.mjs
   Static sanity checks (no Eagle required):

     1. every element id the JavaScript looks up exists in index.html
     2. index.html has no duplicate ids
     3. every JS file parses (node --check is run separately by the caller)
     4. the pure helpers in util.js behave (URL normalisation, kinds, sizes)

   Run:  node tools/check.mjs
   ========================================================================== */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');

let failures = 0;
const fail = (msg) => { failures++; console.error('  ✗ ' + msg); };
const pass = (msg) => console.log('  ✓ ' + msg);

/* ── 1 + 2: ids ── */
console.log('\n[1] element ids');

const htmlIds = [];
for (const match of html.matchAll(/\bid="([^"]+)"/g)) htmlIds.push(match[1]);

const duplicates = htmlIds.filter((id, i) => htmlIds.indexOf(id) !== i);
if (duplicates.length) fail('duplicate ids in index.html: ' + [...new Set(duplicates)].join(', '));
else pass(htmlIds.length + ' unique ids in index.html');

const known = new Set(htmlIds);
const jsFiles = ['js/util.js', 'js/eagle-bridge.js', 'js/engine.js', 'js/library.js', 'js/shelf.js', 'js/browser.js', 'js/app.js'];

let lookups = 0;
for (const file of jsFiles) {
    const code = readFileSync(join(root, file), 'utf8');
    for (const match of code.matchAll(/u\.el\('([^']+)'\)|document\.getElementById\('([^']+)'\)/g)) {
        const id = match[1] || match[2];
        lookups++;
        if (!known.has(id)) fail(file + ' looks up #' + id + ', which is not in index.html');
    }
}
pass(lookups + ' id lookups across ' + jsFiles.length + ' files all resolve');

/* ── 3: referenced static assets exist ── */
console.log('\n[2] assets');

const assets = [];
for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const url = match[1];
    if (/^(https?:|data:|#)/.test(url)) continue;
    assets.push(url);
}
for (const asset of assets) {
    try {
        readFileSync(join(root, asset));
        pass('found ' + asset);
    } catch (e) {
        fail('missing asset ' + asset);
    }
}

const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const missing = [];
if (!manifest.id) missing.push('id');
if (!manifest.version) missing.push('version');
if (!manifest.name) missing.push('name');
if (!manifest.logo) missing.push('logo');
if (!manifest.main || !manifest.main.url) missing.push('main.url');
if (missing.length) fail('manifest.json is missing: ' + missing.join(', '));
else pass('manifest.json has id/version/name/logo/main.url');

try {
    readFileSync(join(root, manifest.logo.replace(/^\//, '')));
    pass('manifest logo exists on disk');
} catch (e) {
    fail('manifest logo ' + manifest.logo + ' is not on disk (run: node tools/make-logo.mjs)');
}

// The plugin version is duplicated in app.js so Diagnostics always has one to
// show. If they drift, "which code am I running?" becomes unanswerable.
const appSource = readFileSync(join(root, 'js/app.js'), 'utf8');
const versionMatch = appSource.match(/const PERCH_VERSION = '([^']+)'/);
if (!versionMatch) fail('js/app.js does not define PERCH_VERSION');
else if (versionMatch[1] !== manifest.version) {
    fail('PERCH_VERSION (' + versionMatch[1] + ') does not match manifest.json version (' + manifest.version + ')');
} else {
    pass('plugin version ' + manifest.version + ' agrees between manifest.json and app.js');
}

/* ── 3: shell grid integrity ── */
// The shell is a CSS grid. A `hidden` child generates no grid item, so any row
// that relies on child order silently shifts when a row is hidden — which shows
// up as a collapsed page pane and a giant slab at the bottom of the window.
console.log('\n[3] shell grid');

const css = readFileSync(join(root, 'css/app.css'), 'utf8');
const appRule = css.match(/\.app\s*\{([\s\S]*?)\}/);
const rowDecl = appRule && appRule[1].match(/grid-template-rows:([^;]+);/);
const shells = ['titlebar', 'tabstrip', 'toolbar', 'notice', 'workspace', 'shelf'];

if (!rowDecl) {
    fail('could not read grid-template-rows from the .app rule');
} else {
    const rows = rowDecl[1].trim().split(/\s+(?![^(]*\))/).filter(Boolean);
    pass('.app declares ' + rows.length + ' shell rows: ' + rowDecl[1].trim());

    const pinned = {};
    for (const name of shells) {
        // A selector can appear in several rules (e.g. the app-region group), so
        // scan every block that mentions it and take the one that pins the row.
        const ruleRe = new RegExp('\\.' + name + '\\s*\\{([\\s\\S]*?)\\}', 'g');
        let pin = null, m;
        while ((m = ruleRe.exec(css))) {
            const found = m[1].match(/grid-row:\s*(\d+)/);
            if (found) { pin = Number(found[1]); break; }
        }
        if (pin === null) fail('.' + name + ' has no explicit grid-row (auto-placement will shift rows)');
        else pinned[name] = pin;
    }

    const values = Object.values(pinned);
    if (values.length === shells.length) {
        if (values.every((v, i) => v === i + 1)) pass('every shell row is pinned 1…' + shells.length + ' in order');
        else fail('shell grid-rows are not sequential: ' + JSON.stringify(pinned));
        if (new Set(values).size !== values.length) fail('two shell elements share a grid-row');
        if (values.length !== rows.length) fail('shell elements (' + values.length + ') do not match declared rows (' + rows.length + ')');
    }
}

/* ── 3b: button labels must not be squashed ── */// Five actions piled into a modal footer got crushed until their labels wrapped
// onto second lines. Buttons now refuse to shrink, and rows wrap instead.
const buttonRule = css.match(/\.[^{}]*\.ghost-btn[^{}]*\{([^}]*)\}/);
if (!buttonRule) fail('could not find the shared .accent-btn/.ghost-btn rule');
else if (!/white-space:\s*nowrap/.test(buttonRule[1])) {
    fail('the shared button rule lost `white-space: nowrap` — labels will wrap when a row is tight');
} else pass('buttons keep their labels on one line (white-space: nowrap)');

if (!/\.btn-row\s*\{[^}]*flex-wrap:\s*wrap/.test(css)) fail('.btn-row must wrap rather than crush');
else pass('.btn-row wraps its actions instead of crushing them');

if (!/\.modal-foot\s*\{[^}]*flex-wrap:\s*wrap/.test(css)) fail('.modal-foot must wrap rather than crush');
else pass('.modal-foot wraps rather than crushing buttons');

/* ── 4: util.js behaviour ── */
console.log('\n[4] util.js behaviour');

const win = {};
new Function('window', readFileSync(join(root, 'js/util.js'), 'utf8'))(win);
const u = win.Perch && win.Perch.util;
if (!u) {
    fail('util.js did not expose Perch.util');
} else {
    const cases = [
        ['normalizeUrl("example.com")', u.normalizeUrl('example.com'), 'https://example.com'],
        ['normalizeUrl("https://a.io/x")', u.normalizeUrl('https://a.io/x'), 'https://a.io/x'],
        ['normalizeUrl("localhost:3000")', u.normalizeUrl('localhost:3000/'), 'http://localhost:3000/'],
        ['normalizeUrl("192.168.0.4")', u.normalizeUrl('192.168.0.4'), 'http://192.168.0.4'],
        ['normalizeUrl("hello world")', u.normalizeUrl('hello world'), 'https://duckduckgo.com/?q=hello%20world'],
        ['normalizeUrl("")', u.normalizeUrl(''), ''],
        ['extOf("a.B.PDF")', u.extOf('a.B.PDF'), 'pdf'],
        ['kindOf("PNG")', u.kindOf('PNG'), 'image'],
        ['kindOf("zip")', u.kindOf('zip'), 'doc'],
        ['kindOf("mp4")', u.kindOf('mp4'), 'video'],
        ['fmtBytes(1536)', u.fmtBytes(1536), '1.5 KB'],
        ['fmtBytes(0)', u.fmtBytes(0), ''],
        ['hostOf("https://a.com:8443/x")', u.hostOf('https://a.com:8443/x'), 'a.com:8443'],
        ['originOf("https://a.com/x?y=1")', u.originOf('https://a.com/x?y=1'), 'https://a.com'],
        ['originOf("file:///tmp/x")', u.originOf('file:///tmp/x'), ''],
        ['pathOf("https://a.com/x?y=1")', u.pathOf('https://a.com/x?y=1'), '/x?y=1'],
        ['letterOf("www.anthropic.com")', u.letterOf('www.anthropic.com'), 'A'],
        ['faviconUrl("https://a.com/x")', u.faviconUrl('https://a.com/x'), 'https://a.com/favicon.ico']
    ];

    for (const [label, actual, expected] of cases) {
        if (actual === expected) pass(label + ' → ' + JSON.stringify(actual));
        else fail(label + ' → ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected));
    }

    const tpl = u.normalizeUrl('figma', 'https://www.google.com/search?q=%s');
    if (tpl === 'https://www.google.com/search?q=figma') pass('search template override');
    else fail('search template override → ' + tpl);

    const evil = u.normalizeUrl('javascript:alert(1)');
    if (!/^javascript:/i.test(evil)) pass('javascript: URLs are neutralised → ' + evil);
    else fail('javascript: URL passed through');

    const dashes = u.normalizeUrl('data:text/html,<b>x</b>');
    if (!/^data:/i.test(dashes)) pass('data: URLs are neutralised');
    else fail('data: URL passed through');

    const icon = u.ICONS && Object.keys(u.ICONS);
    if (icon && icon.length >= 25) pass(icon.length + ' inline icons defined');
    else fail('icon set looks incomplete (' + (icon ? icon.length : 0) + ')');
}

/* ── 5: dist package integrity ── */
// dist/ is a committed copy of the runtime files, so it can drift. Everything
// here exists to make drift impossible to miss.
console.log('\n[5] dist package');

const distDir = join(root, 'dist');

function listFiles(dir, base) {
    const out = [];
    const walk = (current) => {
        for (const entry of readdirSync(current, { withFileTypes: true })) {
            const full = join(current, entry.name);
            if (entry.isDirectory()) walk(full);
            else out.push(relative(base || dir, full).replace(/\\/g, '/'));
        }
    };
    walk(dir);
    return out.sort();
}

if (!existsSync(distDir)) {
    fail('dist/ is missing — run: node tools/make-dist.mjs');
} else {
    const distFiles = listFiles(distDir);

    const forbidden = distFiles.filter((f) => f.startsWith('tools/') || f.startsWith('assets/') || f === '.gitignore');
    if (forbidden.length) fail('dist/ contains development files: ' + forbidden.join(', '));
    else pass('dist/ carries no development tooling or marketing assets');

    let drifted = 0;
    let identical = 0;
    for (const rel of distFiles) {
        const source = join(root, rel);
        if (!existsSync(source)) { fail('dist/' + rel + ' has no counterpart in the source tree'); drifted++; continue; }
        if (!readFileSync(source).equals(readFileSync(join(distDir, rel)))) {
            fail('dist/' + rel + ' differs from its source — rebuild with node tools/make-dist.mjs');
            drifted++;
        } else identical++;
    }
    if (!drifted) pass(identical + ' packaged files are byte-identical to their sources');

    // A new source file that never made it into the package is the quiet case.
    const sourceJs = listFiles(join(root, 'js')).map((f) => 'js/' + f);
    const distJs = distFiles.filter((f) => f.startsWith('js/'));
    const missingJs = sourceJs.filter((f) => distJs.indexOf(f) === -1);
    if (missingJs.length) fail('source files missing from dist/: ' + missingJs.join(', '));
    else pass('all ' + sourceJs.length + ' js modules are present in dist/');

    for (const required of ['manifest.json', 'index.html', 'logo.png', 'css/app.css']) {
        if (distFiles.indexOf(required) === -1) fail('dist/ is missing ' + required);
    }

    const distManifest = JSON.parse(readFileSync(join(distDir, 'manifest.json'), 'utf8'));
    if (distManifest.version !== manifest.version) {
        fail('dist/manifest.json is version ' + distManifest.version + ', source is ' + manifest.version);
    } else {
        pass('dist/manifest.json is version ' + distManifest.version);
    }
}

/* ── summary ── */
console.log('');
if (failures) {
    console.error(failures + ' check(s) failed');
    process.exit(1);
}
console.log('all checks passed');
