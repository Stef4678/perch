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
import { dirname, join } from 'node:path';

import { readZip } from './zip.mjs';
import { packageName, runtimeFiles, isForbiddenEntry } from './package-files.mjs';

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

// Eagle rejects a plugin id that is not a UUID. The manifest docs still show
// examples like "LBCZE8V6LPCKD", which is stale — the validator wants a UUID.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (typeof manifest.id !== 'string' || !manifest.id.trim()) {
    fail('manifest.json has no id');
} else if (!UUID.test(manifest.id)) {
    fail('manifest id "' + manifest.id + '" is not a UUID — Eagle rejects any other format');
} else if (/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(manifest.id)) {
    fail('manifest id is the nil UUID');
} else {
    pass('manifest id is a UUID (' + manifest.id + ')');
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

/* ── 5: package integrity ── */
// dist/ holds one committed .eagleplugin, so it can drift from the source it was
// built from. Everything here makes that drift impossible to miss — and opening
// the archive also proves it is a readable package and not a corrupt file.
console.log('\n[5] .eagleplugin package');

const distDir = join(root, 'dist');
const pkgName = packageName(manifest.version);
const pkgPath = join(distDir, pkgName);

if (!existsSync(distDir)) {
    fail('dist/ is missing — run: node tools/make-dist.mjs');
} else {
    const distEntries = readdirSync(distDir);
    if (distEntries.length !== 1 || distEntries[0] !== pkgName) {
        fail('dist/ should contain only ' + pkgName + ', found: ' + distEntries.join(', ') +
             ' — run: node tools/make-dist.mjs');
    } else {
        pass('dist/ contains exactly one artefact: ' + pkgName);
    }
}

if (!existsSync(pkgPath)) {
    fail(pkgName + ' is missing — run: node tools/make-dist.mjs');
} else {
    let entries = null;
    try {
        entries = readZip(readFileSync(pkgPath));
    } catch (e) {
        fail(pkgName + ' is not a readable archive: ' + e.message);
    }

    if (entries) {
        const names = entries.map((e) => e.name);
        pass(pkgName + ' is a valid archive — ' + entries.length + ' entries, ' +
             (readFileSync(pkgPath).length / 1024).toFixed(0) + ' KB');

        if (names.indexOf('manifest.json') === -1) fail('manifest.json is not at the package root');
        else pass('manifest.json sits at the package root');

        // Eagle rejects development artefacts, nested archives and credentials.
        const forbidden = names.filter(isForbiddenEntry);
        if (forbidden.length) fail('package carries files that must not ship: ' + forbidden.join(', '));
        else pass('no tooling, marketing assets, nested archives or credentials inside');

        const expected = runtimeFiles(root);
        const missing = expected.filter((n) => names.indexOf(n) === -1);
        const extra = names.filter((n) => expected.indexOf(n) === -1);
        if (missing.length) fail('missing from the package: ' + missing.join(', '));
        if (extra.length) fail('unexpected in the package: ' + extra.join(', '));
        if (!missing.length && !extra.length) {
            pass('exactly the ' + expected.length + ' runtime files, nothing else');
        }

        let drift = 0;
        let identical = 0;
        for (const entry of entries) {
            const source = join(root, entry.name);
            if (!existsSync(source)) { fail('packaged ' + entry.name + ' has no source file'); drift++; continue; }
            if (!readFileSync(source).equals(entry.data)) {
                fail('packaged ' + entry.name + ' differs from its source — rebuild with node tools/make-dist.mjs');
                drift++;
            } else identical++;
        }
        if (!drift) pass(identical + ' packaged files are byte-identical to their sources');

        const packagedManifest = entries.filter((e) => e.name === 'manifest.json')[0];
        if (packagedManifest) {
            const version = JSON.parse(packagedManifest.data.toString('utf8')).version;
            if (version !== manifest.version) fail('packaged manifest is version ' + version + ', source is ' + manifest.version);
            else pass('packaged manifest.json is version ' + version);
        }
    }
}

/* ── summary ── */
console.log('');
if (failures) {
    console.error(failures + ' check(s) failed');
    process.exit(1);
}
console.log('all checks passed');
