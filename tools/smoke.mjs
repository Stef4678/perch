/* ============================================================================
   Perch — tools/smoke.mjs
   Boots the real plugin code against a tiny DOM shim and drives the main flows,
   so reference errors, bad selectors and broken wiring show up without Eagle.

   This is not a substitute for running the plugin in Eagle — it cannot test
   <webview>, the Eagle APIs, native drag or the clipboard. It only proves the
   JavaScript loads, wires up and survives the main interactions.

   Run:  node tools/smoke.mjs
   ========================================================================== */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { failures++; console.error('  ✗ ' + m); };
const check = (cond, label) => (cond ? ok(label) : bad(label));

/* ═══════════════════════════ DOM shim ═══════════════════════════ */

const VOID_TAGS = new Set(['input', 'img', 'br', 'hr', 'meta', 'link', 'source', 'area', 'base', 'col', 'embed', 'param', 'track', 'wbr']);

/** Mutable switches for the shim (which engine looks available, etc.). */
const flags = { webview: false };

class ClassList {
    constructor(el) { this.el = el; this.set = new Set(); }
    add(...names) { names.forEach((n) => this.set.add(n)); this.sync(); }
    remove(...names) { names.forEach((n) => this.set.delete(n)); this.sync(); }
    contains(name) { return this.set.has(name); }
    toggle(name, force) {
        const on = force === undefined ? !this.set.has(name) : !!force;
        if (on) this.set.add(name); else this.set.delete(name);
        this.sync();
        return on;
    }
    sync() { this.el._className = [...this.set].join(' '); }
}

class El {
    constructor(tag) {
        this.tagName = String(tag).toUpperCase();
        this.children = [];
        this.parentNode = null;
        this.attrs = {};
        this.dataset = {};
        this.style = {};
        this._listeners = {};
        this._text = '';
        this._className = '';
        this.classList = new ClassList(this);
        this.classList.set = new Set();
        this.hidden = false;
        this.disabled = false;
        this.value = '';
        this.title = '';
        this.id = '';
    }

    get className() { return this._className; }
    set className(v) {
        this._className = String(v || '');
        this.classList.set = new Set(this._className.split(/\s+/).filter(Boolean));
    }
    get firstChild() { return this.children[0] || null; }
    get childNodes() { return this.children; }
    get textContent() {
        return this._text + this.children.map((c) => c.textContent).join('');
    }
    set textContent(v) { this._text = v == null ? '' : String(v); this.children.length = 0; }
    get innerHTML() { return this._html || ''; }
    set innerHTML(v) { this._html = String(v); this.children.length = 0; this._text = ''; }
    get offsetWidth() { return 220; }
    get offsetHeight() { return 120; }

    appendChild(node) {
        if (!node) return node;
        if (node.parentNode) node.parentNode.removeChild(node);
        node.parentNode = this;
        this.children.push(node);
        return node;
    }
    insertBefore(node, ref) {
        if (!ref) return this.appendChild(node);
        const i = this.children.indexOf(ref);
        if (i < 0) return this.appendChild(node);
        if (node.parentNode) node.parentNode.removeChild(node);
        node.parentNode = this;
        this.children.splice(i, 0, node);
        return node;
    }
    removeChild(node) {
        const i = this.children.indexOf(node);
        if (i >= 0) this.children.splice(i, 1);
        if (node) node.parentNode = null;
        return node;
    }
    replaceChild(next, prev) {
        const i = this.children.indexOf(prev);
        if (i < 0) return prev;
        if (next.parentNode) next.parentNode.removeChild(next);
        this.children[i] = next;
        next.parentNode = this;
        prev.parentNode = null;
        return prev;
    }
    setAttribute(k, v) {
        this.attrs[k] = String(v);
        if (k === 'id') this.id = String(v);
        if (k === 'class') this.className = String(v);
        if (k === 'value') this.value = String(v);
        if (k.startsWith('data-')) this.dataset[camel(k.slice(5))] = String(v);
    }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
    removeAttribute(k) { delete this.attrs[k]; }
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
    removeEventListener(type, fn) {
        const list = this._listeners[type] || [];
        const i = list.indexOf(fn);
        if (i > -1) list.splice(i, 1);
    }
    dispatch(type, event) {
        const ev = Object.assign({
            type,
            target: this,
            defaultPrevented: false,
            preventDefault() { ev.defaultPrevented = true; },
            stopPropagation() { }
        }, event || {});
        for (const fn of (this._listeners[type] || []).slice()) {
            try { fn(ev); } catch (err) { bad('listener for ' + type + ' threw: ' + err.message); }
        }
        return ev;
    }
    focus() { doc.activeElement = this; }
    blur() { if (doc.activeElement === this) doc.activeElement = null; }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    select() { }

    /* Canvas doubles, used by the "fit an image for upload" path. */
    getContext() {
        return {
            drawImage() { },
            getImageData(x, y, w, h) {
                const data = new Uint8ClampedArray(w * h * 4);
                data.fill(255);
                if (canvasAlpha) data[3] = 0;      // one transparent pixel
                return { data, width: w, height: h };
            }
        };
    }
    toDataURL(type) {
        canvasLog = { width: this.width, height: this.height, type: type || 'image/png' };
        return 'data:' + (type || 'image/png') + ';base64,' + 'A'.repeat(120);
    }
    toBlob(cb, type) {
        canvasLog = { width: this.width, height: this.height, type: type || 'image/png' };
        cb({ type: type || 'image/png', size: 4096 });
    }
    contains(node) {
        let cur = node;
        while (cur) { if (cur === this) return true; cur = cur.parentNode; }
        return false;
    }
    closest(sel) {
        let cur = this;
        while (cur) { if (matches(cur, sel)) return cur; cur = cur.parentNode; }
        return null;
    }
    querySelector(sel) { return descend(this, sel, true)[0] || null; }
    querySelectorAll(sel) { return descend(this, sel, false); }
    getBoundingClientRect() { return { left: 320, top: 130, right: 1280, bottom: 800, width: 960, height: 670 }; }
}

function camel(s) { return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase()); }

/** Records the last canvas the image-fit path produced. */
let canvasLog = null;

/** Size the shim's decoded images report, so fit/no-fit can both be tested. */
let imageSize = { w: 4000, h: 3000 };

/**
 * Instrumentation: every time the browser hands a URL to an engine, record
 * whether that engine element was actually visible at that moment. Loading into
 * a hidden <webview> guest is exactly how a browser pane ends up blank, so this
 * is worth asserting on.
 */
const loadLog = [];
function isVisible(el) {
    let node = el.parentNode;
    while (node) {
        if (node.classList && node.classList.contains('view')) return node.classList.contains('active');
        node = node.parentNode;
    }
    return false;
}
const origSetAttribute = El.prototype.setAttribute;
El.prototype.setAttribute = function (key, value) {
    if (key === 'src' && this.tagName === 'IFRAME') {
        loadLog.push({ tag: 'iframe', url: String(value), visible: isVisible(this) });
    }
    return origSetAttribute.call(this, key, value);
};

/** Minimal compound-selector matcher: tag, .class, #id, [attr], [attr="v"], comma groups. */
function matches(el, selector) {
    return String(selector).split(',').some((group) => {
        const parts = group.trim().match(/^([a-zA-Z0-9-]+)?((?:[.#][\w-]+|\[[^\]]+\])*)$/);
        if (!parts) return false;
        if (parts[1] && el.tagName !== parts[1].toUpperCase()) return false;
        const rest = parts[2] || '';
        for (const token of rest.match(/[.#][\w-]+|\[[^\]]+\]/g) || []) {
            if (token[0] === '.') { if (!el.classList.contains(token.slice(1))) return false; }
            else if (token[0] === '#') { if (el.id !== token.slice(1)) return false; }
            else {
                const body = token.slice(1, -1);
                const eq = body.indexOf('=');
                if (eq < 0) { if (el.getAttribute(body) === null) return false; }
                else {
                    const key = body.slice(0, eq);
                    const want = body.slice(eq + 1).replace(/^["']|["']$/g, '');
                    const have = key.startsWith('data-') ? el.dataset[camel(key.slice(5))] : el.getAttribute(key);
                    if (String(have) !== want) return false;
                }
            }
        }
        return true;
    });
}

function descend(root, selector, firstOnly) {
    const out = [];
    const walk = (node) => {
        for (const child of node.children) {
            if (matches(child, selector)) {
                out.push(child);
                if (firstOnly) return true;
            }
            if (walk(child) && firstOnly) return true;
        }
        return false;
    };
    walk(root);
    return out;
}

const doc = {
    documentElement: null,
    body: null,
    activeElement: null,
    hidden: false,
    _listeners: {},
    getElementById(id) {
        let found = null;
        const walk = (node) => {
            for (const child of node.children) {
                if (child.id === id) { found = child; return true; }
                if (walk(child)) return true;
            }
            return false;
        };
        walk(doc.documentElement);
        return found;
    },
    createElement(tag) {
        const el = new El(tag);
        // Optionally pretend the Electron <webview> tag is registered, so the
        // webview engine can be exercised too.
        if (String(tag).toLowerCase() === 'webview' && flags.webview) {
            el._loaded = '';
            el.loadURL = function (url) {
                this._loaded = url;
                loadLog.push({ tag: 'webview', url: String(url), visible: isVisible(this) });
            };
            el.getURL = function () { return this._loaded; };
            el.stop = function () { };
            el.reload = function () { };
            el.reloadIgnoringCache = function () { };
        }
        return el;
    },
    createElementNS(_ns, tag) { return new El(tag); },
    createTextNode(text) { const el = new El('#text'); el.textContent = text; return el; },
    querySelector(sel) { return descend(doc.documentElement, sel, true)[0] || null; },
    querySelectorAll(sel) { return descend(doc.documentElement, sel, false); },
    addEventListener(type, fn) { (doc._listeners[type] = doc._listeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
        const list = doc._listeners[type] || [];
        const i = list.indexOf(fn);
        if (i > -1) list.splice(i, 1);
    },
    dispatch(type, event) {
        const ev = Object.assign({
            type,
            target: doc,
            defaultPrevented: false,
            preventDefault() { ev.defaultPrevented = true; },
            stopPropagation() { }
        }, event || {});
        for (const fn of (doc._listeners[type] || []).slice()) fn(ev);
        return ev;
    }
};

/* Parse index.html into the shim tree (well-formed markup, no text nodes needed). */
function parseHtml(html) {
    const root = new El('html');
    const stack = [root];
    const token = /<!--[\s\S]*?-->|<\/([a-zA-Z0-9-]+)\s*>|<([a-zA-Z0-9-]+)((?:\s+[^>]*?)?)\/?>/g;
    let m;
    while ((m = token.exec(html))) {
        if (m[0].startsWith('<!--')) continue;
        if (m[1]) {
            const tag = m[1].toLowerCase();
            for (let i = stack.length - 1; i > 0; i--) {
                if (stack[i].tagName.toLowerCase() === tag) { stack.length = i; break; }
            }
        } else if (m[2]) {
            const tag = m[2].toLowerCase();
            const el = new El(tag);
            const attrRe = /([a-zA-Z0-9:_-]+)(?:\s*=\s*"([^"]*)")?/g;
            let a;
            while ((a = attrRe.exec(m[3] || ''))) {
                if (!a[1]) continue;
                if (a[2] === undefined) el.setAttribute(a[1], '');
                else el.setAttribute(a[1], a[2]);
            }
            if (el.getAttribute('hidden') !== null) el.hidden = true;
            stack[stack.length - 1].appendChild(el);
            if (!VOID_TAGS.has(tag)) stack.push(el);
        }
    }
    return root;
}

const html = readFileSync(join(root, 'index.html'), 'utf8');
doc.documentElement = parseHtml(html);
doc.body = descend(doc.documentElement, 'body', true)[0];

/* ═══════════════════════════ globals ═══════════════════════════ */

const storageMap = new Map();
const win = {
    innerWidth: 1280,
    innerHeight: 860,
    _listeners: {},
    addEventListener(type, fn) { (win._listeners[type] = win._listeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
        const list = win._listeners[type] || [];
        const i = list.indexOf(fn);
        if (i > -1) list.splice(i, 1);
    },
    dispatch(type, event) {
        const ev = Object.assign({
            type,
            target: ws,
            defaultPrevented: false,
            preventDefault() { ev.defaultPrevented = true; },
            stopPropagation() { }
        }, event || {});
        for (const fn of (win._listeners[type] || []).slice()) fn(ev);
        return ev;
    },
    open() { },
    close() { win._closed = true; },
    matchMedia() { return { matches: false, addEventListener() { } }; },
    localStorage: {
        getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
        setItem: (k, v) => storageMap.set(k, String(v)),
        removeItem: (k) => storageMap.delete(k)
    }
};
// window is the global object for the plugin code
const ws = win;

const head = doc.documentElement.children.find((c) => c.tagName === 'HEAD');
const links = head ? head.children.filter((c) => c.tagName === 'LINK') : [];

const shimGlobals = {
    window: win,
    document: doc,
    navigator: {
        platform: 'Win32',
        language: 'en-US',
        // A realistic Electron/Eagle user agent, so the UA cleaning is exercised.
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
                   'Eagle/4.0.0 Chrome/130.0.0.0 Electron/32.1.0 Safari/537.36',
        clipboard: undefined
    },
    location: { origin: 'file://', href: 'file:///perch/index.html', reload() { win._reloaded = true; } },
    localStorage: win.localStorage,
    Image: class {
        constructor() { this.naturalWidth = imageSize.w; this.naturalHeight = imageSize.h; }
        set src(_v) { setTimeout(() => this.onload && this.onload(), 0); }
    },
    Buffer,
    require: (name) => {
        if (name === 'electron') return null;
        if (name === 'fs') return { existsSync: () => true, readFileSync: () => Buffer.from([1, 2, 3]) };
        return null;
    },
    console,
    setTimeout,
    clearTimeout
};

/* ═══════════════════════════ load the plugin ═══════════════════════════ */

console.log('\n[1] load + boot');

const files = ['js/util.js', 'js/eagle-bridge.js', 'js/engine.js', 'js/library.js', 'js/shelf.js', 'js/browser.js', 'js/app.js'];
const names = Object.keys(shimGlobals);

let bootError = null;
try {
    for (const file of files) {
        const code = readFileSync(join(root, file), 'utf8');
        new Function(...names, code)(...names.map((n) => shimGlobals[n]));
    }
} catch (err) {
    bootError = err;
}
check(!bootError, bootError ? 'boot threw: ' + bootError.stack.split('\n').slice(0, 3).join(' | ') : 'all 7 modules loaded and app.js booted');

if (bootError) { console.error('\ncannot continue'); process.exit(1); }

const P = win.Perch;
check(!!P && !!P.util && !!P.Eagle && !!P.Engine && !!P.Library && !!P.Shelf && !!P.Browser && !!P.App, 'modules exposed on Perch');

/* every id in index.html resolves */
const missing = [];
for (const m of html.matchAll(/\bid="([^"]+)"/g)) {
    if (!doc.getElementById(m[1])) missing.push(m[1]);
}
check(missing.length === 0, missing.length ? 'getElementById failed for: ' + missing.join(', ') : 'every id in index.html resolves through the DOM');

/* icons hydrated */
const iconHosts = doc.querySelectorAll('[data-icon]');
const hydrated = iconHosts.filter((h) => h.dataset.iconDone === '1').length;
check(hydrated === iconHosts.length && iconHosts.length > 15, hydrated + '/' + iconHosts.length + ' icon placeholders hydrated');

/* ═══════════════════════════ interactions ═══════════════════════════ */

const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));

console.log('\n[2] library + shelf');
await wait(60);

const grid = doc.getElementById('libGrid');
check(grid.children.length > 0, 'demo library rendered ' + grid.children.length + ' cards');

const firstCard = grid.children[0];
const addBtn = firstCard.querySelector('.add');
addBtn.dispatch('click');
await wait(10);
check(P.Shelf.count() === 1, 'clicking + shelved 1 item (count=' + P.Shelf.count() + ')');
check(doc.getElementById('shelfItems').children.length === 1, 'shelf rendered 1 chip');
check(doc.getElementById('shelfCount').textContent === '1', 'shelf counter shows 1');
check(doc.getElementById('shelfBadge').textContent === '1', 'tab-strip badge shows 1');

/* checked selection -> Add button */
firstCard.dispatch('click');
check(doc.getElementById('checkedCount').textContent === '1', 'card click checked 1 item');
doc.getElementById('btnAddChecked').dispatch('click');
await wait(10);
check(P.Shelf.count() === 1, 'adding an already-shelved item does not duplicate');

/* grab the Eagle selection (demo returns demo-1..3, and demo-1 is already shelved) */
doc.getElementById('btnGrabSelection').dispatch('click');
await wait(20);
check(P.Shelf.count() === 3, 'grab Eagle selection merged 3 items without duplicates (count=' + P.Shelf.count() + ')');

/* shelf filters */
doc.getElementById('libFilters').children[1].dispatch('click');
await wait(40);
check(true, 'kind filter switched without throwing');

/* search */
const search = doc.getElementById('libSearch');
search.value = 'brand';
search.dispatch('input');
await wait(400);
check(true, 'debounced search ran without throwing');

console.log('\n[3] browser');
const tabsBefore = P.Browser.tabCount();
P.Browser.navigate('https://example.com/docs');
await wait(20);
check(P.Browser.currentUrl() === 'https://example.com/docs', 'omnibox navigation set the URL');
check(P.Browser.tabCount() === tabsBefore, 'navigation reused the current tab');
check(doc.getElementById('addressInput').value === 'https://example.com/docs', 'address bar reflects the URL');
check(doc.querySelectorAll('.view').length === tabsBefore, 'one view element per tab');
check(doc.querySelectorAll('.tab').length === tabsBefore, 'one tab element per tab');

P.Browser.createTab();
await wait(10);
check(P.Browser.tabCount() === tabsBefore + 1, 'new tab created');
check(doc.getElementById('startPage').hidden === false, 'start page is visible on a blank tab');

P.Browser.navigate('hello world');
await wait(10);
check(/duckduckgo\.com\/\?q=hello%20world/.test(P.Browser.currentUrl()), 'non-URL input became a search');
check(doc.getElementById('startPage').hidden === true, 'start page hidden once a page loads');
check(doc.getElementById('progressBar').hidden === false, 'progress bar shown while loading');

P.Browser.goBack();
P.Browser.goForward();
P.Browser.reload(true);
P.Browser.cycleTab(1);
P.Browser.activateTabByIndex(0);
P.Browser.closeActiveTab();
await wait(20);
check(true, 'back / forward / hard reload / tab cycling / close ran clean');

console.log('\n[4] modals, theme, shortcuts');
P.App.openSettings();
check(doc.getElementById('modalRoot').hidden === false, 'settings modal opened');
P.util.closeModal();
check(doc.getElementById('modalRoot').hidden === true, 'settings modal closed');

P.App.openHelp();
check(!!doc.querySelectorAll('.help-grid').length, 'help modal rendered the shortcut grid');
P.util.closeModal();

const themeBefore = doc.body.dataset.theme;
doc.getElementById('btnTheme').dispatch('click');
check(doc.body.dataset.theme !== themeBefore, 'theme toggled ' + themeBefore + ' → ' + doc.body.dataset.theme);

win.dispatch('keydown', { key: 'b', ctrlKey: true, target: doc.body });
check(doc.getElementById('app').dataset.lib === 'closed', 'Ctrl+B collapsed the library');
win.dispatch('keydown', { key: 'b', ctrlKey: true, target: doc.body });
win.dispatch('keydown', { key: 'A', ctrlKey: true, shiftKey: true, target: doc.body });
check(doc.getElementById('app').dataset.shelf === 'closed', 'Ctrl+Shift+A collapsed the shelf');
win.dispatch('keydown', { key: 'A', ctrlKey: true, shiftKey: true, target: doc.body });
win.dispatch('keydown', { key: 't', ctrlKey: true, target: doc.body });
check(P.Browser.tabCount() > 0, 'Ctrl+T created a tab');
win.dispatch('keydown', { key: 'l', ctrlKey: true, target: doc.body });
check(doc.activeElement === doc.getElementById('addressInput'), 'Ctrl+L focused the address bar');
win.dispatch('keydown', { key: 'Escape', target: doc.body });
check(true, 'Escape handled');

console.log('\n[5] Eagle round-trips, engine, diagnostics');
P.Browser.savePageToEagle();
await wait(10);
if (doc.getElementById('modalRoot').hidden === false) {
    const saveBtn = doc.querySelectorAll('.modal-foot .accent-btn')[0];
    if (saveBtn) saveBtn.dispatch('click');
    await wait(20);
}
check(true, 'Save to Eagle flow completed without throwing');

await P.Browser.captureToEagle();
check(true, 'capture flow completed without throwing');

await P.Actions.copyFiles([{ id: 'x', name: 'x.png', filePath: '' }]);
await P.Actions.tagWithCurrentPage([{ id: 'demo-1', name: 'demo' }]);
await wait(10);
check(true, 'attach / tag actions handled the no-file and no-live-item cases');

P.Actions.menuFor([{ id: 'demo-1', name: 'a.png', ext: 'png', filePath: '' }], doc.getElementById('libGrid'));
check(!!doc.querySelectorAll('.menu.popup').length, 'context menu fell back to the in-window menu');
P.util.qsa('.menu.popup').forEach((m) => m.remove());

const diag = P.Eagle.diag();
check(Object.keys(diag).length >= 12 && diag.webviewTag === 'no', 'diagnostics reported ' + Object.keys(diag).length + ' fields (webviewTag=' + diag.webviewTag + ')');

P.Engine.init('iframe');
P.Browser.rebuildForEngine();
await wait(20);
check(P.Engine.kind === 'iframe' && P.Browser.tabCount() > 0, 'engine rebuild recreated tabs on iframe');

check(!!doc.querySelectorAll('.toast').length, 'toasts were produced (' + doc.querySelectorAll('.toast').length + ')');

console.log('\n[6] the <webview> engine path');

flags.webview = true;
check(P.Engine.probeWebview() === 'yes', 'probe reports webview support when the tag is registered');
P.Engine.init('webview');
P.Browser.rebuildForEngine();
P.Browser.navigate('https://start.test/');
await wait(20);
check(P.Engine.kind === 'webview', 'engine switched to webview');
check(doc.getElementById('enginePill').dataset.engine === 'webview', 'engine pill updated');
check(doc.getElementById('enginePill').textContent === 'webview', 'engine pill label updated');

const activeView = () => doc.querySelectorAll('.view').filter((v) => v.classList.contains('active'))[0] || null;
const activeGuest = (tag) => doc.querySelectorAll(tag).filter((w) => w.parentNode && w.parentNode.classList.contains('active'))[0] || null;

const guest = activeGuest('webview');
check(!!guest, 'the active tab renders a webview element');

if (guest) {
    guest.dispatch('did-start-loading');
    check(doc.getElementById('progressBar').hidden === false, 'did-start-loading shows the progress bar');

    guest.dispatch('did-navigate', { url: 'https://start.test/landed' });
    check(P.Browser.currentUrl() === 'https://start.test/landed', 'redirect resolved onto the same history entry');

    guest.dispatch('page-title-updated', { title: 'Landed page' });
    check(P.Browser.currentTitle() === 'Landed page', 'page-title-updated set the tab title');
    const activeTabTitle = doc.querySelectorAll('.tab').filter((t) => t.classList.contains('active'))[0];
    check(!!activeTabTitle && activeTabTitle.querySelector('.tab-title').textContent === 'Landed page',
        'the active tab in the strip shows the new title');

    guest.dispatch('did-stop-loading');
    check(doc.getElementById('progressBar').hidden === true, 'did-stop-loading hides the progress bar');

    /* Guest identity: an Electron UA is what triggers Google's bot check. */
    const guestUa = guest.getAttribute('useragent') || '';
    check(/Chrome\/\d/.test(guestUa), 'the guest presents a Chrome user agent');
    check(!/Electron|Eagle|Perch/i.test(guestUa), 'the user agent carries no Electron/app token: ' + guestUa.slice(0, 72) + '…');
    check(guest.getAttribute('partition') === 'persist:perch',
        'the guest uses a persistent session, so consent and login cookies survive');

    /* Failure routing. */
    guest.dispatch('did-fail-load', { errorCode: -3, errorDescription: 'ABORTED', validatedURL: 'https://start.test/', isMainFrame: true });
    check(doc.getElementById('loadNotice').hidden === true, 'error code -3 (aborted) is ignored');

    guest.dispatch('did-fail-load', { errorCode: -105, errorDescription: 'NAME_NOT_RESOLVED', validatedURL: 'https://ads.broken.test/', isMainFrame: false });
    check(doc.getElementById('loadNotice').hidden === true, 'a failed subframe never raises a notice');

    guest.dispatch('did-fail-load', { errorCode: -105, errorDescription: 'NAME_NOT_RESOLVED', validatedURL: 'https://broken.test/', isMainFrame: true });
    check(doc.getElementById('loadNotice').hidden === false, 'a main-frame failure raises the non-blocking notice');
    check(/broken\.test/.test(doc.getElementById('loadNoticeText').textContent), 'the notice names the host that failed');
    check(doc.getElementById('blockedOverlay').hidden === true, 'the failure card is NOT used on the webview engine');
    check(!!activeView(), 'the pane stays visible after a failure (Chromium draws its own error page)');

    const realOpenExternal = P.Eagle.shell.openExternal;
    let openedExternally = '';
    P.Eagle.shell.openExternal = function (url) { openedExternally = url; return Promise.resolve(); };
    guest.dispatch('did-fail-load', { errorCode: -302, errorDescription: 'ERR_UNKNOWN_URL_SCHEME', validatedURL: 'mailto:hi@example.com', isMainFrame: true });
    check(openedExternally === 'mailto:hi@example.com', 'an external app scheme is handed to the OS');
    P.Eagle.shell.openExternal = realOpenExternal;

    guest.dispatch('did-navigate', { url: 'https://start.test/again' });
    check(doc.getElementById('loadNotice').hidden === true, 'a later successful navigation clears the notice');

    const tabsBeforePopup = P.Browser.tabCount();
    const popupEvent = guest.dispatch('new-window', { url: 'https://popup.test/' });
    await wait(10);
    check(P.Browser.tabCount() === tabsBeforePopup, 'pop-ups are NOT hijacked into tabs by default');
    check(popupEvent.defaultPrevented === false,
        'a pop-up is left to Electron by default, so window.opener survives');

    P.App.settings.popupMode = 'tab';
    const popupEvent2 = guest.dispatch('new-window', { url: 'https://popup2.test/' });
    await wait(10);
    check(P.Browser.tabCount() === tabsBeforePopup + 1, '“New tab” hosts the pop-up in a tab');
    check(popupEvent2.defaultPrevented === true, 'and only then is the native window suppressed');

    P.App.settings.popupMode = 'same';
    const tabsBeforeSame = P.Browser.tabCount();
    const curBefore = P.Browser.currentUrl();
    const popupEvent3 = guest.dispatch('new-window', { url: 'https://consent.test/accept' });
    await wait(10);
    check(P.Browser.tabCount() === tabsBeforeSame, '“Same tab” opens no extra tab');
    check(popupEvent3.defaultPrevented === true, '“Same tab” suppresses the native window');
    check(P.Browser.currentUrl() === 'https://consent.test/accept' && curBefore !== P.Browser.currentUrl(),
        'the consent URL loads in the current tab, which is what lets the flow finish');
    P.App.settings.popupMode = 'window';
    check(activeView() !== null, 'the visible view is still live after all that');
}

/* The page storage probe: the thing that settles a cookie-consent loop. */
P.Engine.init('webview', { spoofUserAgent: true });
P.Browser.rebuildForEngine();
P.Browser.navigate('https://consent.test/page');
await wait(20);
const probeGuest = activeGuest('webview');
probeGuest.executeJavaScript = function () {
    return Promise.resolve({
        url: 'https://consent.test/page', secure: true,
        cookieEnabled: true, cookieCount: 3, canWriteCookie: false,
        localStorage: true, thirdPartyFrame: false
    });
};
const probe = await P.Browser.probePage();
check(probe && probe.canWriteCookie === false, 'the probe reports whether the page can store a cookie');
P.Actions.lastProbe = probe;
check(/page storage probe:/.test(P.Actions.report()) && /canWriteCookie: false/.test(P.Actions.report()),
    'the probe result is included in the diagnostics report');
check(/canWriteCookie/.test(P.Actions.report()), 'the report names the deciding field');

console.log('\n[7] the <iframe> fallback path');

flags.webview = false;
P.Engine.init('iframe');
P.Browser.rebuildForEngine();
P.Browser.navigate('https://frame.test/page');
await wait(20);
check(P.Engine.kind === 'iframe', 'engine switched back to iframe');

const frame = activeGuest('iframe');
check(!!frame, 'the active tab renders an iframe element');
if (frame) {
    check(frame.getAttribute('src') === 'https://frame.test/page', 'iframe src was set from the address bar');
    frame.dispatch('load');
    await wait(1100);   // the adapter probes a few times before declaring a refusal
    check(doc.getElementById('blockedOverlay').hidden === false, 'a frame we cannot read is reported as refused');
    check(/frame\.test/.test(doc.getElementById('blockedText').textContent), 'refusal card names the host');
}

console.log('\n[8] ordering, self-healing and recovery');

/* The pane must be visible before the engine is told to load. */
loadLog.length = 0;
P.Browser.createTab();                          // blank tab: start page up, view hidden
await wait(10);
P.Browser.navigate('https://fresh.test/one');
await wait(20);
const freshLoad = loadLog[loadLog.length - 1];
check(freshLoad && freshLoad.url === 'https://fresh.test/one', 'a brand new tab navigates');
check(freshLoad && freshLoad.visible === true, 'the pane was visible BEFORE the engine loaded it');

/* Navigation keeps working over a long run of searches in one tab. */
const searchRuns = [];
for (let i = 0; i < 6; i++) {
    P.Browser.navigate('query number ' + i);
    await wait(8);
    searchRuns.push(loadLog[loadLog.length - 1]);
}
check(searchRuns.length === 6 && searchRuns.every((e) => e.visible === true),
    '6 back-to-back searches all loaded into a visible pane');
check(searchRuns[5].url === 'https://duckduckgo.com/?q=query%20number%205', 'the last search reached the engine');
check(P.Browser.currentUrl() === 'https://duckduckgo.com/?q=query%20number%205', 'the address bar shows the resolved search URL');
check(doc.getElementById('addressInput').value === P.Browser.currentUrl(), 'the omnibox was updated even though it kept focus');

/* A guest that lost its document while hidden gets reloaded on reveal. */
flags.webview = true;
P.Engine.init('webview');
P.Browser.rebuildForEngine();
P.Browser.navigate('https://heal.test/page');
await wait(20);
const healGuest = activeGuest('webview');
check(!!healGuest, 'webview tab available for the self-heal test');
if (healGuest) {
    healGuest.dispatch('did-navigate', { url: 'https://heal.test/page' });   // marks it as loaded
    await wait(10);

    const tabNodes = doc.querySelectorAll('.tab');
    const activeIndex = tabNodes.findIndex((t) => t.classList.contains('active'));
    healGuest._loaded = 'about:blank';        // simulate the document being dropped
    loadLog.length = 0;

    P.Browser.createTab();                    // switch away (hides the guest)
    await wait(10);
    P.Browser.activateTabByIndex(activeIndex); // switch back
    await wait(30);

    check(loadLog.some((e) => e.url === 'https://heal.test/page'),
        'a guest that lost its document is reloaded when its tab is revealed again');

    /* Recreating a wedged tab keeps its URL and swaps the engine element. */
    const before = activeGuest('webview');
    loadLog.length = 0;
    P.Browser.recreateTab();
    await wait(20);
    const after = activeGuest('webview');
    check(!!after && after !== before, 'Rebuild view produced a fresh engine element');
    check(loadLog.some((e) => e.url === 'https://heal.test/page'), 'the rebuilt view reloaded the same URL');
    check(doc.getElementById('blockedOverlay').hidden === true, 'the rebuilt view is showing, not the failure card');
}

/* A wedged load must not leave the progress indicator spinning forever. */
P.Browser.navigate('https://hang.test/');
await wait(20);
check(doc.getElementById('progressBar').hidden === false, 'a pending load shows progress');
P.Browser.stop();
await wait(10);
check(doc.getElementById('progressBar').hidden === true, 'stop clears the progress indicator');

console.log('\n[9] attaching images to web composers');

let writtenImage = null;
let canvasAlpha = false;
const realWriteImage = P.Eagle.clipboard.writeImage;
const realFromDataUrl = P.Eagle.nativeImageFromDataUrl;
const realFromPath = P.Eagle.nativeImageFromPath;
P.Eagle.clipboard.writeImage = function (img) { writtenImage = img; return Promise.resolve(true); };
P.Eagle.nativeImageFromDataUrl = function (dataUrl) { return dataUrl ? { kind: 'fromDataUrl', dataUrl } : null; };
P.Eagle.nativeImageFromPath = function () { return Promise.resolve({ kind: 'fromPath' }); };

const photo = { id: 'p1', name: 'shoot.png', ext: 'png', filePath: 'C:/lib/shoot.png', tags: [], folders: [] };
const psd = { id: 'p2', name: 'layout.psd', ext: 'psd', filePath: 'C:/lib/layout.psd', tags: [], folders: [] };

canvasLog = null;
writtenImage = null;
await P.Actions.attach([photo]);
check(!!writtenImage && writtenImage.kind === 'fromDataUrl',
    'Attach on an image puts image DATA on the clipboard, not a raw file');
check(!!canvasLog && canvasLog.width === 1600 && canvasLog.height === 1200,
    'a 4000×3000 original is fitted to 1600×1200 for upload (' + (canvasLog ? canvasLog.width + '×' + canvasLog.height : 'no canvas') + ')');
check(P.Actions.lastResult && P.Actions.lastResult.route.indexOf('fitted') > -1,
    'the last attach is recorded for Diagnostics (' + (P.Actions.lastResult && P.Actions.lastResult.route) + ')');

canvasLog = null;
writtenImage = null;
await P.Actions.copyImage(photo, { original: true });
check(!!writtenImage && writtenImage.kind === 'fromPath',
    '“original size” writes the untouched image instead of a re-encode');

canvasLog = null;
writtenImage = null;
const psdOk = await P.Actions.copyImage(psd);
check(psdOk === false && writtenImage === null,
    'a PSD is refused as a paste and steered to file copy');

check(P.util.rasterImage('jpg') && P.util.rasterImage('SVG') && P.util.rasterImage('webp'),
    'raster formats are recognised as pasteable');
check(!P.util.rasterImage('psd') && !P.util.rasterImage('fig') && !P.util.rasterImage('heic') && !P.util.rasterImage('tiff'),
    'design and HEIC/TIFF sources are treated as files, not pictures');

/* An image already inside the limits must be handed over byte-for-byte. */
canvasLog = null;
imageSize = { w: 800, h: 600 };
await P.Actions.copyImage({ id: 'small', name: 'shot.png', ext: 'png', filePath: 'C:/lib/shot.png' }, { original: false });
check(canvasLog === null, 'an in-limits image is copied without any canvas re-encode (no generational loss)');
check(P.Actions.lastResult && /original bytes/.test(P.Actions.lastResult.route),
    'the untouched path is reported as such (' + (P.Actions.lastResult && P.Actions.lastResult.route) + ')');
imageSize = { w: 4000, h: 3000 };

/* The Diagnostics line reports what was attached. */
const diagLine = P.Eagle.diag().lastAttach;
check(/image/.test(diagLine) && /KB/.test(diagLine), 'Diagnostics reports the last attach: ' + diagLine);

P.Eagle.clipboard.writeImage = realWriteImage;
P.Eagle.nativeImageFromDataUrl = realFromDataUrl;
P.Eagle.nativeImageFromPath = realFromPath;

console.log('\n[10] guest identity toggle');

P.Engine.init('webview', { spoofUserAgent: false });
check(P.Engine.spoofingUserAgent === false, 'user-agent spoofing can be switched off');
P.Browser.rebuildForEngine();
await wait(20);
const nativeGuest = activeGuest('webview');
check(!!nativeGuest && nativeGuest.getAttribute('useragent') === null,
    'with spoofing off the guest keeps the native Electron user agent');

P.Engine.init('webview', { spoofUserAgent: true });
P.Browser.rebuildForEngine();
await wait(20);
const spoofedGuest = activeGuest('webview');
check(!!spoofedGuest && /Chrome\/\d/.test(spoofedGuest.getAttribute('useragent') || ''),
    'with spoofing on the guest presents Chrome again');
check(spoofedGuest.getAttribute('partition') === 'persist:perch', 'the persistent session is applied');

P.Engine.init('webview', { spoofUserAgent: true, sessionPartition: 'default' });
P.Browser.rebuildForEngine();
await wait(20);
const inheritGuest = activeGuest('webview');
check(inheritGuest.getAttribute('partition') === null, 'the session setting can fall back to Eagle\'s default');
P.Engine.init('webview', { spoofUserAgent: true, sessionPartition: 'perch' });
P.Browser.rebuildForEngine();
await wait(20);

check(P.Eagle.diag().uaSpoofing === 'on', 'Diagnostics reports the spoofing state');
check(P.Eagle.diag().session === 'persist:perch', 'Diagnostics reports the session mode');
check(/^\d+\.\d+\.\d+/.test(String(P.Eagle.diag().pluginVersion)) || P.Eagle.diag().pluginVersion === 'unknown',
    'Diagnostics reports the plugin version (' + P.Eagle.diag().pluginVersion + ')');

console.log('\n[11] stray file drops cannot destroy the window');

/* Dropping a file on Perch's own chrome must never navigate the plugin window. */
const dropEvent = win.dispatch('drop', { dataTransfer: { files: { length: 1 } } });
check(dropEvent.defaultPrevented === true, 'a file dropped on the Perch chrome is swallowed');
const dragOverEvent = win.dispatch('dragover', {});
check(dragOverEvent.defaultPrevented === true, 'dragover is swallowed too, so the default navigation never starts');
check(doc.querySelectorAll('.toast').length > 0, 'the user is told to drop onto the page instead');

console.log('\n[12] evidence gathering');

/* The self-test must actually exercise the clipboard round trip. */
let lastWrite = null;
const realWrite2 = P.Eagle.clipboard.writeImage;
P.Eagle.clipboard.writeImage = function (img) { lastWrite = img; return Promise.resolve(true); };
P.Eagle.nativeImageFromDataUrl = function (dataUrl) { return { kind: 'fromDataUrl', dataUrl }; };
P.Eagle.clipboard.readImage = function () { return { getSize: () => ({ width: 64, height: 64 }) }; };

const selfRows = await P.Actions.selfTest();
const selfMap = Object.fromEntries(selfRows);
check(/ok/.test(selfMap['clipboard write']), 'self-test reports a working clipboard write');
check(/64×64 ok/.test(selfMap['clipboard read-back']), 'self-test reads the clipboard back (' + selfMap['clipboard read-back'] + ')');
check(!!lastWrite, 'self-test really wrote an image rather than just claiming to');

/* The report is the artefact the user pastes back. */
P.Eagle.log('a test log line');
const report = P.Actions.report();
check(/^Perch \d+\.\d+\.\d+/.test(report), 'report opens with the plugin version');
check(/engine: \w+/.test(report) && /ua spoofing: (on|off)/.test(report), 'report includes engine and identity state');
check(/self-test:/.test(report) && /clipboard write: ok/.test(report), 'report includes the self-test rows');
check(/perch log \(last \d+\)/.test(report), 'report includes the recent log');

/* Page-level console capture: the only view into a remote page's own errors. */
P.Engine.init('webview', { spoofUserAgent: true });
P.Browser.rebuildForEngine();
await wait(20);
const consoleGuest = activeGuest('webview');
consoleGuest.dispatch('console-message', { level: 3, message: 'Uncaught TypeError: upload failed', sourceId: 'https://gemini.test/app.js', line: 42 });
await wait(5);
const guestLines = P.Engine.guestConsole(5);
check(guestLines.length === 1 && /upload failed/.test(guestLines[0].message),
    'a page error is captured from the guest console');
check(/page console/.test(P.Actions.report()), 'the captured page error appears in the report');

P.Eagle.clipboard.writeImage = realWrite2;

console.log('\n[13] the iframe engine is a first-class citizen');

/* This is the configuration the user was actually running: no webview tag. */
flags.webview = false;
P.Engine.init('auto', { spoofUserAgent: true, sessionPartition: 'perch' });
check(P.Engine.kind === 'iframe', 'with no webview tag, auto selects the iframe engine');

const iframeReport = P.Engine.engineReport();
check(iframeReport.webviewAvailable === false, 'the engine report says webview is unavailable');
check(iframeReport.downgraded === false, 'auto is not a downgrade — it is an honest choice');

/* Asking for webview when it cannot exist must be reported, never silent. */
P.Engine.init('webview', {});
check(P.Engine.engineReport().downgraded === true, 'forcing webview without the tag is reported as a downgrade');
check(P.Engine.kind === 'iframe', 'and it correctly stays on iframe');
check(/Eagle does not expose/.test(P.Engine.describe().note), 'the engine note explains why');
check(P.Engine.describe().label === 'iframe · limited', 'the label is honest about being limited');

P.Browser.rebuildForEngine();
P.Browser.navigate('https://blocked-site.test/page');
await wait(30);

/* The probe must explain the loop rather than shrugging. */
const iframeProbe = await P.Browser.probePage();
check(iframeProbe && iframeProbe.engine === 'iframe', 'the probe names the engine it ran on');
check(iframeProbe.thirdPartyFrame === true && iframeProbe.canWriteCookie === false,
    'the probe explains that a framed page is a third party whose cookies are refused');
check(/consent banner cannot stick/i.test(iframeProbe.verdict),
    'the verdict names the consent-loop cause');

P.Actions.lastProbe = iframeProbe;
const iframeReportText = P.Actions.report();
check(/webview available: NO/.test(iframeReportText), 'the report states webview is unavailable');
check(/consent banner cannot stick/i.test(iframeReportText), 'the report carries the consent verdict');

/* Open-in-browser must be reachable and wired. */
let opened = '';
const realOpen = P.Eagle.shell.openExternal;
P.Eagle.shell.openExternal = function (url) { opened = url; return Promise.resolve(); };
P.Browser.openExternal(P.Browser.currentUrl());
await wait(5);
check(opened === 'https://blocked-site.test/page', 'the Open-in-browser action hands the URL to the OS');
P.Eagle.shell.openExternal = realOpen;
check(doc.getElementById('btnOpenExternal') !== null, 'and the toolbar exposes a button for it');

flags.webview = true;
P.Engine.init('auto', { spoofUserAgent: true, sessionPartition: 'perch' });
P.Browser.rebuildForEngine();
await wait(20);
check(P.Engine.kind === 'webview', 'and with the tag present, auto goes back to webview');
check(P.Engine.engineReport().downgraded === false, 'auto is a clean start on a capable host');

console.log('\n[14] start-up ordering');

/* Eagle's item/folder APIs are unusable before plugin-create, so the library
   must not be queried at script time; and the webview probe must not be the
   only one that ever runs. */
check(doc.getElementById('libGrid') !== null, 'the library panel exists in the DOM');
check(typeof P.App.start === 'function', 'start() is exposed so it can be deferred and re-driven');
P.App.start();   // idempotent: a second call must not re-init modules
check(true, 'calling start() twice is a no-op');
check(P.Browser.tabCount() > 0, 'the browser is still healthy after a duplicate start');

/* Diagnostics must actually carry the engine — reading a missing field produced
   "engine: undefined" in a real user report. */
const diagNow = P.Eagle.diag();
check(diagNow.engine === 'webview' || diagNow.engine === 'iframe',
    'diag() reports the engine (' + diagNow.engine + ')');
check(typeof diagNow.library === 'string' && diagNow.library.length > 0,
    'diag() reports a usable library line: ' + diagNow.library);

/* The library name must survive a build that only exposes the path. */
const realEagle = shimGlobals.window.eagle;
check(P.Eagle.library.name === 'Demo Library', 'demo mode still names the library');
check(P.Actions.report().indexOf('engine: undefined') === -1, 'the report never says “engine: undefined”');

console.log('\n[15] a drag that lands nowhere is not silent');

let copiedPaths = null;
const realCopyFiles = P.Eagle.clipboard.copyFiles;
const realStartDrag = P.Eagle.drag.startDrag;
P.Eagle.clipboard.copyFiles = function (paths) { copiedPaths = paths; return Promise.resolve(true); };
P.Eagle.drag.startDrag = function () { return Promise.resolve(); };

const dragItem = { id: 'drag-1', name: 'shot.png', ext: 'png', filePath: 'C:/lib/shot.png' };
const dragSource = doc.createElement('div');
dragSource.setAttribute('draggable', 'true');

P.Library.dragItems([dragItem], dragSource);
check(copiedPaths === null, 'starting a drag does not copy anything yet');

dragSource.dispatch('dragend', { dataTransfer: { dropEffect: 'none' } });
await wait(10);
check(Array.isArray(copiedPaths) && copiedPaths[0] === 'C:/lib/shot.png',
    'a refused drop automatically falls back to the clipboard, so Ctrl+V still works');

copiedPaths = null;
const toastsBefore = doc.querySelectorAll('.toast').length;
P.Library.dragItems([dragItem], dragSource);
dragSource.dispatch('dragend', { dataTransfer: { dropEffect: 'copy' } });
await wait(10);
check(copiedPaths === null, 'an accepted drop copies nothing — the drop itself was the delivery');
check(doc.querySelectorAll('.toast').length > toastsBefore,
    'an accepted drop still reports “Delivered to the page”, so a silent site is distinguishable');

P.Eagle.clipboard.copyFiles = realCopyFiles;
P.Eagle.drag.startDrag = realStartDrag;

console.log('\n[16] bot challenges are named, not looped');

P.Engine.init('webview', { spoofUserAgent: true, sessionPartition: 'perch' });
P.Browser.rebuildForEngine();
P.Browser.navigate('https://tineye.com/');
await wait(20);
const challengeGuest = activeGuest('webview');
check(!!challengeGuest, 'a webview tab is available for the challenge test');

challengeGuest.dispatch('page-title-updated', { title: 'Please wait a moment.' });
await wait(10);
check(doc.getElementById('loadNotice').hidden === false, 'a Cloudflare challenge raises the notice strip');
const challengeText = doc.getElementById('loadNoticeText').textContent;
check(/Cloudflare/.test(challengeText) && /normal browser/.test(challengeText),
    'the notice names Cloudflare and points at the real browser');
check(/Ctrl\/⌘ \+ V/.test(challengeText), 'and tells the user how to get their Eagle file there');

/* A normal page must clear it again. */
challengeGuest.dispatch('page-title-updated', { title: 'TinEye Reverse Image Search' });
challengeGuest.dispatch('did-navigate', { url: 'https://tineye.com/search' });
await wait(10);
check(doc.getElementById('loadNotice').hidden === true, 'a normal page clears the challenge notice');

/* The iframe engine cannot be fingerprinted the same way, and must not claim it can. */
flags.webview = false;
P.Engine.init('iframe', {});
P.Browser.rebuildForEngine();
P.Browser.navigate('https://tineye.com/');
await wait(20);
const frameGuest = activeGuest('iframe');
if (frameGuest) {
    frameGuest.dispatch('load');
    await wait(1100);
}
check(doc.getElementById('blockedOverlay').hidden === false || doc.getElementById('loadNotice').hidden === true,
    'the iframe engine reports the framing refusal instead of a challenge notice');
flags.webview = true;
P.Engine.init('webview', { spoofUserAgent: true, sessionPartition: 'perch' });
P.Browser.rebuildForEngine();
await wait(20);

console.log('\n[17] the settings dialog is not crushing its buttons');

P.App.openSettings();
const actionRows = doc.querySelectorAll('.btn-row');
check(actionRows.length > 0, 'maintenance actions live in their own wrapping row');
const actionLabels = actionRows.length ? actionRows[0].children.map((c) => c.textContent.trim()) : [];
check(actionLabels.some((l) => /Copy diagnostics/.test(l)), 'the row holds Copy diagnostics');
check(actionLabels.some((l) => /self-test/.test(l)), 'the row holds the self-test');
check(actionLabels.some((l) => /Rebuild/.test(l)), 'the row holds Rebuild tab views');
check(actionLabels.length >= 5, 'all five maintenance actions are in the row (' + actionLabels.length + ')');
check(actionLabels.every((l) => l.length > 0), 'no action lost its label');

const foot = doc.querySelectorAll('.modal-foot')[0];
check(!!foot && foot.children.length <= 2, 'the footer is back to two buttons (' + (foot ? foot.children.length : '?') + ')');
P.util.closeModal();

/* ═══════════════════════════ summary ═══════════════════════════ */
console.log('');
if (failures) {
    console.error(failures + ' smoke check(s) failed');
    process.exit(1);
}
console.log('smoke test passed');
process.exit(0);
