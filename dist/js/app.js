/* ============================================================================
   Perch — app.js
   Bootstrap: theme, frameless-window controls, layout toggles, keyboard
   shortcuts, settings and diagnostics. Loaded last; it wires the modules.
   ========================================================================== */
window.Perch = window.Perch || {};

(function (P) {
    'use strict';

    const u = P.util;
    const E = P.Eagle;

    const DEFAULTS = {
        theme: 'auto',          // auto | dark | light
        engine: 'auto',         // auto | webview | iframe
        spoofUserAgent: true,   // present the guest as Chrome rather than Electron
        sessionPartition: 'perch', // 'perch' (persistent jar) | 'default' (inherit)
        popupMode: 'window',    // window | tab | same — how window.open() is handled
        search: 'duckduckgo',
        home: ''
    };

    // Kept in step with manifest.json by tools/check.mjs. Diagnostics always has
    // a version to show, even if Eagle never reports the manifest back to us —
    // which is how you confirm a reload actually picked up new code.
    const PERCH_VERSION = '1.0.12';

    const settings = Object.assign({}, DEFAULTS, u.storageGet('settings', {}));

    function saveSettings() { u.storageSet('settings', settings); }

    function engineOptions() {
        return {
            spoofUserAgent: settings.spoofUserAgent,
            sessionPartition: settings.sessionPartition
        };
    }

    /** The engine pill in the title bar is the honest status light — make it clickable. */
    function elsEnginePillClick() {
        const pill = u.el('enginePill');
        if (!pill) return;
        pill.style.cursor = 'pointer';
        pill.style.webkitAppRegion = 'no-drag';
        pill.addEventListener('click', openSettings);
    }

    function reinitEngine() {
        P.Engine.init(settings.engine, engineOptions());
        P.Browser.rebuildForEngine();
    }

    /* ═══════════════════════════ theme ═══════════════════════════ */

    function resolveTheme(pref) {
        if (pref === 'dark' || pref === 'light') return pref;
        if (E.available) return E.app.isDarkColors() ? 'dark' : 'light';
        return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }

    function applyTheme(pref) {
        const resolved = resolveTheme(pref);
        document.body.dataset.theme = resolved;
        const btn = u.el('btnTheme');
        if (btn) {
            u.clear(btn);
            btn.appendChild(u.svgIcon(resolved === 'dark' ? 'moon' : 'sun', 16));
            btn.title = resolved === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme';
        }
    }

    function toggleTheme() {
        const next = resolveTheme(settings.theme) === 'dark' ? 'light' : 'dark';
        settings.theme = next;
        saveSettings();
        applyTheme(next);
    }

    /* ═══════════════════════════ window controls ═══════════════════════════ */

    function toggleMaximize() {
        E.win.isMaximized().then(function (isMax) {
            if (isMax) E.win.unmaximize(); else E.win.maximize();
        });
    }

    function bindWindow() {
        ['btnMinWin', 'btnMinMac'].forEach(function (id) {
            const node = u.el(id); if (node) node.addEventListener('click', function () { E.win.minimize(); });
        });
        ['btnMaxWin', 'btnMaxMac'].forEach(function (id) {
            const node = u.el(id); if (node) node.addEventListener('click', toggleMaximize);
        });
        ['btnCloseWin', 'btnCloseMac'].forEach(function (id) {
            const node = u.el(id); if (node) node.addEventListener('click', function () { E.win.close(); });
        });

        ['titlebar', 'dragRegion'].forEach(function (id) {
            const node = u.el(id);
            if (node) node.addEventListener('dblclick', function (e) {
                if (e.target.closest('button')) return;
                toggleMaximize();
            });
        });

        document.body.dataset.platform = E.isMac ? 'darwin' : 'win32';
    }

    /* ═══════════════════════════ layout ═══════════════════════════ */

    function setLibrary(open) {
        const app = u.el('app');
        app.dataset.lib = open ? 'open' : 'closed';
        const btn = u.el('btnToggleLibrary');
        if (btn) btn.classList.toggle('is-active', open);
    }

    function setShelf(open) {
        const app = u.el('app');
        app.dataset.shelf = open ? 'open' : 'closed';
        const btn = u.el('btnToggleShelf');
        if (btn) btn.classList.toggle('is-active', open);

        const chev = u.el('btnShelfCollapse');
        const svg = chev && chev.querySelector('svg');
        if (svg) svg.style.transform = open ? '' : 'rotate(-90deg)';
    }

    function toggleLibrary() { setLibrary(u.el('app').dataset.lib !== 'open'); }
    function toggleShelf() { setShelf(u.el('app').dataset.shelf !== 'open'); }

    function bindLayout() {
        u.el('btnToggleLibrary').addEventListener('click', toggleLibrary);
        u.el('btnToggleShelf').addEventListener('click', toggleShelf);
        setLibrary(true);
        setShelf(true);
    }

    /* ═══════════════════════════ shortcuts ═══════════════════════════ */

    function isTypingTarget(target) {
        if (!target) return false;
        const tag = target.tagName;
        return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
    }

    function bindShortcuts() {
        window.addEventListener('keydown', function (e) {
            const mod = E.isMac ? e.metaKey : e.ctrlKey;
            const key = e.key;
            const lower = key.length === 1 ? key.toLowerCase() : key;
            const typing = isTypingTarget(e.target);

            // Always available
            if (key === 'Escape') {
                if (!u.el('quickMenu').hidden) { u.el('quickMenu').hidden = true; return; }
                if (u.isModalOpen()) { u.closeModal(); return; }
                if (P.Browser.isLoading()) { P.Browser.stop(); return; }
                return;
            }

            if (mod && lower === 'l') { e.preventDefault(); P.Browser.focusAddress(); return; }
            if (mod && lower === 'k') { e.preventDefault(); P.Browser.focusAddress(); return; }
            if (mod && lower === 't') { e.preventDefault(); P.Browser.createTab(); return; }
            if (mod && lower === 'w') { e.preventDefault(); P.Browser.closeActiveTab(); return; }
            if (mod && lower === 'r') { e.preventDefault(); P.Browser.reload(e.shiftKey); return; }
            if (mod && e.shiftKey && lower === 'o') {
                e.preventDefault();
                P.Browser.openExternal(P.Browser.currentUrl());
                return;
            }
            if (mod && key === ',') { e.preventDefault(); openSettings(); return; }
            if (mod && key === '/') { e.preventDefault(); openHelp(); return; }
            if (key === 'F5') { e.preventDefault(); P.Browser.reload(e.shiftKey); return; }
            if (key === 'F1') { e.preventDefault(); openHelp(); return; }

            if (typing) return;   // do not steal plain keystrokes from fields

            if (mod && lower === 'b') { e.preventDefault(); toggleLibrary(); return; }
            if (mod && e.shiftKey && lower === 'a') { e.preventDefault(); toggleShelf(); return; }
            if (mod && key === 'Tab') { e.preventDefault(); P.Browser.cycleTab(e.shiftKey ? -1 : 1); return; }
            if (mod && key >= '1' && key <= '9') {
                e.preventDefault();
                P.Browser.activateTabByIndex(Number(key) - 1);
                return;
            }
            if (e.altKey && key === 'ArrowLeft') { e.preventDefault(); P.Browser.goBack(); return; }
            if (e.altKey && key === 'ArrowRight') { e.preventDefault(); P.Browser.goForward(); return; }
        });
    }

    /* ═══════════════════════════ settings ═══════════════════════════ */

    function segmented(options, current, onPick) {
        const wrap = u.h('div', { class: 'seg' });
        options.forEach(function (opt) {
            const btn = u.h('button', { class: opt.value === current ? 'active' : '', text: opt.label });
            btn.addEventListener('click', function () {
                u.qsa('button', wrap).forEach(function (b) { b.classList.remove('active'); });
                btn.classList.add('active');
                onPick(opt.value);
            });
            wrap.appendChild(btn);
        });
        return wrap;
    }

    function kvList(pairs) {
        const dl = u.h('dl', { class: 'kv' });
        Object.keys(pairs).forEach(function (key) {
            dl.appendChild(u.h('dt', { text: key }));
            dl.appendChild(u.h('dd', { text: String(pairs[key]) }));
        });
        return dl;
    }

    function openSettings() {
        const body = function (host) {
            const engineProbe = P.Engine.probeWebview();

            host.appendChild(u.h('div', { class: 'field' }, [
                u.h('label', { text: 'Appearance' }),
                segmented([
                    { value: 'auto', label: 'Auto' },
                    { value: 'dark', label: 'Dark' },
                    { value: 'light', label: 'Light' }
                ], settings.theme, function (value) {
                    settings.theme = value; saveSettings(); applyTheme(value);
                })
            ]));

            const engineSelect = u.h('select', { class: 'select' });
            [['auto', 'Auto — use webview when available'], ['webview', 'Webview — full browser engine'], ['iframe', 'Iframe — fallback, no site restrictions bypass']]
                .forEach(function (pair) {
                    engineSelect.appendChild(u.h('option', { attrs: { value: pair[0] }, text: pair[1] }));
                });
            engineSelect.value = settings.engine;
            engineSelect.addEventListener('change', function () {
                settings.engine = engineSelect.value;
                saveSettings();
                reinitEngine();
            });
            host.appendChild(u.h('div', { class: 'field' }, [
                u.h('label', { text: 'Browser engine' }),
                engineSelect,
                u.h('div', { class: 'help', text: 'webview support detected: ' + engineProbe + '. ' + P.Engine.describe().note })
            ]));

            host.appendChild(u.h('div', { class: 'field' }, [
                u.h('label', { text: 'Guest identity' }),
                segmented([
                    { value: 'spoof', label: 'Present as Chrome' },
                    { value: 'native', label: 'Native Electron UA' }
                ], settings.spoofUserAgent ? 'spoof' : 'native', function (value) {
                    settings.spoofUserAgent = value === 'spoof';
                    saveSettings();
                    reinitEngine();
                }),
                u.h('div', { class: 'help', text:
                    'An Electron user agent makes Google and Cloudflare serve bot checks, so Perch presents a plain ' +
                    'Chrome one by default. Not free: the UA string and the browser\u2019s Sec-CH-UA hints then disagree, ' +
                    'and a site that cross-checks them can be harder on us. Switch to the native UA and reload if a ' +
                    'Google service misbehaves with the spoof on.' })
            ]));

            host.appendChild(u.h('div', { class: 'field' }, [
                u.h('label', { text: 'Browsing session' }),
                segmented([
                    { value: 'perch', label: 'Persistent' },
                    { value: 'default', label: 'Eagle default' }
                ], settings.sessionPartition, function (value) {
                    settings.sessionPartition = value;
                    saveSettings();
                    reinitEngine();
                }),
                u.h('div', { class: 'help', text:
                    'Cookies and logins live in a persistent Perch session by default. If a site keeps showing its ' +
                    'cookie banner after you accept it, that is a cookie that is not being stored — this is the ' +
                    'setting for it. Choose “Eagle default” only if the persistent session causes trouble.' })
            ]));

            host.appendChild(u.h('div', { class: 'field' }, [
                u.h('label', { text: 'Pop-up windows' }),
                segmented([
                    { value: 'window', label: 'Real window' },
                    { value: 'tab', label: 'New tab' },
                    { value: 'same', label: 'Same tab' }
                ], settings.popupMode, function (value) {
                    settings.popupMode = value;
                    saveSettings();
                }),
                u.h('div', { class: 'help', text:
                    'Consent screens and sign-in flows report back to the page that opened them. A new tab severs ' +
                    'that link, and a webview pop-up window does not reliably provide an opener either — either way the ' +
                    'page keeps re-opening the same dialog. If a cookie banner or login window repeats forever, try ' +
                    '“Same tab”: the flow then completes in place instead of looping.' })
            ]));

            const searchSelect = u.h('select', { class: 'select' });
            Object.keys(P.Browser.SEARCH_ENGINES).forEach(function (key) {
                searchSelect.appendChild(u.h('option', { attrs: { value: key }, text: P.Browser.SEARCH_ENGINES[key].name }));
            });
            searchSelect.value = settings.search;
            searchSelect.addEventListener('change', function () {
                settings.search = searchSelect.value; saveSettings();
            });
            host.appendChild(u.h('div', { class: 'field' }, [
                u.h('label', { text: 'Search engine (used when the address bar is not a URL)' }),
                searchSelect
            ]));

            const homeInput = u.h('input', { class: 'input', attrs: { value: settings.home, placeholder: 'Leave empty to show the Perch start page' } });
            homeInput.addEventListener('change', function () {
                settings.home = homeInput.value.trim(); saveSettings();
            });
            host.appendChild(u.h('div', { class: 'field' }, [
                u.h('label', { text: 'Home page' }), homeInput
            ]));

            host.appendChild(u.h('div', { class: 'field' }, [
                u.h('label', { text: 'Diagnostics' }),
                kvList(E.diag())
            ]));

            // The actions used to be piled into the modal footer, which crushed
            // five buttons until their labels wrapped. They belong in their own
            // labelled row, where they can flow onto a second line cleanly.
            host.appendChild(u.h('div', { class: 'field' }, [
                u.h('label', { text: 'Maintenance' }),
                u.h('div', { class: 'help', text:
                    'Copy diagnostics builds a report to paste into a bug report. Run attachment self-test proves the ' +
                    'clipboard half of attaching works on this machine. Probe this page reads the loaded page’s own ' +
                    'storage permissions.' }),
                u.h('div', { class: 'btn-row' }, [copyDiagBtn, probeBtn, selfTestBtn, rebuildBtn, reloadBtn])
            ]));
        };

        const reloadBtn = u.h('button', { class: 'ghost-btn', text: 'Reload plugin window' });
        reloadBtn.addEventListener('click', function () { location.reload(); });

        const rebuildBtn = u.h('button', { class: 'ghost-btn', text: 'Rebuild tab views' });
        rebuildBtn.addEventListener('click', function () {
            u.closeModal();
            P.Browser.recreateAllTabs();
        });

        const selfTestBtn = u.h('button', { class: 'ghost-btn', text: 'Run attachment self-test' });        selfTestBtn.addEventListener('click', async function () {
            const rows = await P.Actions.selfTest();
            u.openModal({
                title: 'Attachment self-test',
                body: function (host) {
                    host.appendChild(u.h('div', { class: 'help', text:
                        'Builds a small image, writes it to the system clipboard exactly as an attach does, then reads ' +
                        'it back. If every row is ok, the bytes left Perch correctly and any remaining failure is on ' +
                        'the site side.' }));
                    const kv = u.h('dl', { class: 'kv' });
                    rows.forEach(function (row) {
                        kv.appendChild(u.h('dt', { text: row[0] }));
                        kv.appendChild(u.h('dd', { text: String(row[1]) }));
                    });
                    host.appendChild(kv);
                    host.appendChild(u.h('div', { class: 'help', text: 'Now press “Copy diagnostics” to send the report.' }));
                }
            });
        });

        const copyDiagBtn = u.h('button', { class: 'accent-btn', text: 'Copy diagnostics' });
        copyDiagBtn.addEventListener('click', async function () {
            const text = P.Actions.report();
            const ok = await E.clipboard.writeText(text);
            u.toast({
                title: ok ? 'Diagnostics copied to the clipboard' : 'Could not copy diagnostics',
                sub: ok ? 'Paste it wherever you need it.' : 'Select the text in this window instead.',
                kind: ok ? 'success' : 'error',
                timeout: 6000
            });
        });

        const probeBtn = u.h('button', { class: 'ghost-btn', text: 'Probe this page' });
        probeBtn.addEventListener('click', async function () {
            const result = await P.Browser.probePage();
            P.Actions.lastProbe = result;
            if (!result) {
                u.toast({ title: 'Nothing to probe', sub: 'Open a page first.', kind: 'warn' });
                return;
            }
            u.openModal({
                title: 'Page storage probe',
                body: function (host) {
                    host.appendChild(u.h('div', { class: 'help', text:
                        'Runs a small read-only check inside the page. A consent banner loops when the page cannot ' +
                        'store a cookie — this says whether it can.' }));
                    const kv = u.h('dl', { class: 'kv' });
                    Object.keys(result).forEach(function (key) {
                        kv.appendChild(u.h('dt', { text: key }));
                        kv.appendChild(u.h('dd', { text: String(result[key]) }));
                    });
                    host.appendChild(kv);
                    const verdict = result.canWriteCookie === false
                        ? 'Verdict: this page cannot store a first-party cookie, so Accept can never stick. That is ' +
                          'below Perch — the browser session is denying storage.'
                        : result.canWriteCookie === true
                            ? 'Verdict: cookies work here. If the banner still repeats, the loop is the site’s own ' +
                              'pop-up/consent logic — try Settings → Pop-up windows → Same tab.'
                            : 'Verdict: inconclusive.';
                    host.appendChild(u.h('div', { class: 'help', text: verdict }));
                }
            });
        });

        const clearBtn = u.h('button', { class: 'ghost-btn danger', text: 'Reset preferences' });
        clearBtn.addEventListener('click', function () {
            u.storageSet('settings', null);
            u.storageSet('session', null);
            location.reload();
        });

        const closeBtn = u.h('button', { class: 'accent-btn', text: 'Close' });
        closeBtn.addEventListener('click', u.closeModal);

        u.openModal({ title: 'Perch settings', body: body, actions: [clearBtn, closeBtn] });
    }

    /* ═══════════════════════════ help ═══════════════════════════ */

    function openHelp() {
        const rows = [
            ['New tab', ['Ctrl/⌘', 'T']],
            ['Close tab', ['Ctrl/⌘', 'W']],
            ['Next / previous tab', ['Ctrl/⌘', 'Tab']],
            ['Jump to tab 1–9', ['Ctrl/⌘', '1…9']],
            ['Focus the address bar', ['Ctrl/⌘', 'L']],
            ['Reload / hard reload', ['Ctrl/⌘', 'R']],
            ['Back / forward', ['Alt', '← →']],
            ['Toggle the Eagle library', ['Ctrl/⌘', 'B']],
            ['Toggle the attachment shelf', ['Ctrl/⌘', '⇧', 'A']],
            ['Settings', ['Ctrl/⌘', ',']],
            ['This help', ['Ctrl/⌘', '/']]
        ];

        const body = function (host) {
            const grid = u.h('div', { class: 'help-grid' });
            rows.forEach(function (row) {
                grid.appendChild(u.h('div', { text: row[0] }));
                const keys = u.h('div', { class: 'kbd-row' });
                row[1].forEach(function (k) { keys.appendChild(u.h('kbd', { text: k })); });
                grid.appendChild(keys);
            });
            host.appendChild(grid);

            host.appendChild(u.h('div', { class: 'field' }, [
                u.h('label', { text: 'Attaching files into a page' }),
                u.h('div', { class: 'help', text:
                    '0. Sign in to the site first. A signed-out web app shows its drop zone and then silently ' +
                    'discards whatever you attach — Gemini, ChatGPT and Drive all need a session before an ' +
                    'attachment means anything. ' +
                    '1. Pick items in the Eagle library panel — click + to shelve them, or drag them out. ' +
                    '2. On the shelf, press Attach to copy the real files, then click the page and press Ctrl/⌘ + V. ' +
                    'Or drag a shelf card straight onto the page, which works with any drop zone or file field.' })
            ]));

            host.appendChild(u.h('div', { class: 'field' }, [
                u.h('label', { text: 'Engine' }),
                u.h('div', { class: 'help', text: P.Engine.describe().note })
            ]));
        };

        u.openModal({ title: 'Perch — shortcuts & tips', body: body });
    }

    /* ═══════════════════════════ drop guard ═══════════════════════════ */

    /**
     * A file dropped anywhere on Perch's own chrome (toolbar, shelf, panel)
     * would otherwise make the plugin window navigate to that file — Chromium's
     * default for an unhandled file drop — and the whole app would vanish,
     * replaced by the picture. Swallow drops on our chrome; the page area is a
     * separate renderer and still receives them normally.
     */
    function guardWindowDrops() {
        window.addEventListener('dragover', function (e) { e.preventDefault(); }, false);
        window.addEventListener('drop', function (e) {
            const transfer = e.dataTransfer;
            const files = transfer && transfer.files ? transfer.files.length : 0;
            e.preventDefault();
            if (files) {
                u.toast({
                    title: 'Drop files onto the page, not onto Perch',
                    sub: 'Drag a shelf card into the page area and it attaches there.',
                    kind: 'warn',
                    icon: 'paperclip'
                });
            }
        }, false);
    }

    /* ═══════════════════════════ boot ═══════════════════════════ */

    let booted = false;
    let started = false;

    /**
     * Start the parts that need Eagle.
     *
     * This must NOT run at script time. Eagle's own documentation is explicit:
     * the item/folder APIs "can only be used after the plugin-create event".
     * Starting early produced two failures that looked like something else
     * entirely — the library came back empty ("no items yet"), and the
     * <webview> tag was probed before it was registered, so Perch settled on the
     * iframe engine and lost the ability to display most of the web.
     */
    function start() {
        if (started) return;
        started = true;

        P.Engine.init(settings.engine, engineOptions());
        applyTheme(settings.theme);

        P.Browser.init();
        P.Library.init();
        P.Shelf.init();

        reportEngine();
        retryEngineProbe();
        elsEnginePillClick();

        if (!u.storageGet('welcomed', false)) {
            u.storageSet('welcomed', true);
            setTimeout(function () {
                u.toast({
                    title: 'Welcome to Perch',
                    sub: 'Browse on the right, pick Eagle files on the left, attach them with drag or Ctrl/⌘ + V.',
                    kind: 'info',
                    icon: 'sparkle',
                    timeout: 9000
                });
            }, 700);
        }

        if (!E.available) {
            u.toast({
                title: 'Running outside Eagle',
                sub: 'Showing demo library data. Open this plugin from Eagle for the real thing.',
                kind: 'warn',
                timeout: 7000
            });
        }
    }

    /** Say out loud when the requested engine was not granted. */
    function reportEngine() {
        const state = P.Engine.engineReport();
        if (state.downgraded) {
            u.toast({
                title: 'Webview engine not available',
                sub: 'Perch asked for the full browser engine and did not get it, so it stays on the iframe engine. ' +
                     'Sites that forbid embedding cannot be shown here.',
                kind: 'warn',
                icon: 'shield',
                timeout: 11000
            });
        }
        E.log('Perch ready — plugin ' + P.App.pluginVersion +
              ', engine ' + state.granted +
              ' (requested ' + state.requested + ', webview ' + (state.webviewAvailable ? 'available' : 'unavailable') + ')');
    }

    /**
     * The <webview> element can be registered a beat after the plugin starts.
     * Probing exactly once is what pinned Perch to the iframe engine even though
     * the tag was there, so keep looking for a moment and upgrade if it appears.
     */
    function retryEngineProbe() {
        if (settings.engine === 'iframe' || P.Engine.kind === 'webview') return;

        [200, 600, 1400, 2600].forEach(function (delay) {
            setTimeout(function () {
                if (P.Engine.kind === 'webview') return;
                P.Engine.init(settings.engine, engineOptions());
                if (P.Engine.kind !== 'webview') return;

                E.log('webview tag appeared after ' + delay + 'ms — upgrading to the full browser engine');
                P.Browser.rebuildForEngine();
                P.Browser.updateEnginePill();
                u.toast({
                    title: 'Full browser engine enabled',
                    sub: 'The webview tag became available, so sites that forbid embedding now load.',
                    kind: 'success',
                    icon: 'sparkle',
                    timeout: 7000
                });
            }, delay);
        });
    }

    function boot() {
        if (booted) return;
        booted = true;

        // UI that does not touch Eagle can come up immediately.
        u.hydrateIcons();
        bindWindow();
        bindLayout();
        bindShortcuts();
        guardWindowDrops();

        applyTheme(settings.theme);
        u.el('brandVersion').textContent = 'v' + PERCH_VERSION + ' · Eagle browser';
        u.el('btnTheme').addEventListener('click', toggleTheme);
        u.el('btnSettings').addEventListener('click', openSettings);
        u.el('btnShortcuts').addEventListener('click', openHelp);

        E.onThemeChanged(function () { if (settings.theme === 'auto') applyTheme('auto'); });
        E.onPluginShow(function () { /* window became visible */ });

        E.onPluginCreate(function (plugin) {
            const manifest = (plugin && plugin.manifest) || {};
            if (manifest.version) P.App.pluginVersion = manifest.version;
            start();
        });

        window.addEventListener('error', function (event) {
            E.log('uncaught error', event.message, event.filename + ':' + event.lineno);
        });

        if (E.available) {
            // Eagle is present: wait for plugin-create, with a safety net so the
            // window can never sit there empty if the event does not arrive.
            setTimeout(start, 5000);
        } else {
            start();   // browser preview: nothing to wait for
        }
    }

    P.App = {
        settings: settings,
        pluginVersion: PERCH_VERSION,
        saveSettings: saveSettings,
        applyTheme: applyTheme,
        setLibrary: setLibrary,
        setShelf: setShelf,
        openShelf: function () { setShelf(true); },
        toggleShelf: toggleShelf,
        openSettings: openSettings,
        openHelp: openHelp,
        boot: boot,
        start: start
    };

    boot();
})(window.Perch);
