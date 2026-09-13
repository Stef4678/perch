/* ============================================================================
   Perch — eagle-bridge.js
   The single seam between the UI and the Eagle Plugin API.

   Every call is guarded, so a failure in one API never kills the window, and
   when the page is opened outside Eagle (plain browser) the whole UI still
   runs against generated demo data — handy for iterating on the interface.
   ========================================================================== */
window.Perch = window.Perch || {};

(function (P) {
    'use strict';

    const eagle = function () { return (typeof window.eagle !== 'undefined' && window.eagle) ? window.eagle : null; };
    const has = function () { return !!eagle(); };

    // Recent log lines, so Diagnostics can hand back real evidence instead of a
    // description of the symptoms.
    const LOG_BUFFER = [];
    const LOG_LIMIT = 60;

    function stringify(value) {
        if (value == null) return String(value);
        if (typeof value === 'string') return value;
        if (value instanceof Error) return value.message;
        try { return JSON.stringify(value); } catch (e) { return String(value); }
    }

    function log() {
        const args = Array.prototype.slice.call(arguments);
        const line = args.map(stringify).join(' ');
        try {
            LOG_BUFFER.push(new Date().toTimeString().slice(0, 8) + '  ' + line);
            if (LOG_BUFFER.length > LOG_LIMIT) LOG_BUFFER.shift();
        } catch (e) { /* never throw while logging */ }

        try {
            if (has() && window.eagle.log && window.eagle.log.add) window.eagle.log.add('[Perch] ' + line);
            else console.log('[Perch]', ...args);
        } catch (e) { /* logging must never throw */ }
    }

    /** Call an eagle API member, swallowing + reporting failures. */
    async function attempt(label, fn, fallback) {
        try {
            const out = await fn();
            return out === undefined ? fallback : out;
        } catch (err) {
            log(label + ' failed:', (err && err.message) || err);
            return fallback;
        }
    }

    /**
     * Same, for Eagle calls that return nothing: true when it resolved,
     * false when it threw. `attempt()` cannot be used here because it maps an
     * undefined result onto the fallback value.
     */
    async function attemptVoid(label, fn) {
        try {
            await fn();
            return true;
        } catch (err) {
            log(label + ' failed:', (err && err.message) || err);
            return false;
        }
    }

    /* ───────────────── nativeImage ───────────────── */
    // Clipboard image writes need an Electron NativeImage. Renderers expose
    // `nativeImage` through require('electron'), but we keep two fallbacks so
    // "copy image" works even if that path is unavailable.

    function electronModule(name) {
        try {
            if (typeof require !== 'function') return null;
            const mod = require('electron');
            return (mod && mod[name]) ? mod[name] : null;
        } catch (e) { return null; }
    }

    async function nativeImageFromPath(path) {
        if (!path) return null;

        const ni = electronModule('nativeImage');
        if (ni && ni.createFromPath) {
            try {
                const img = ni.createFromPath(path);
                if (img && !img.isEmpty()) return img;
            } catch (e) { log('nativeImage.createFromPath failed', e && e.message); }
        }

        // Eagle's own API returns a NativeImage — guaranteed available route.
        if (has() && window.eagle.app && window.eagle.app.createThumbnailFromPath) {
            return await attempt('createThumbnailFromPath', function () {
                return window.eagle.app.createThumbnailFromPath(path, { width: 2048, height: 2048 });
            }, null);
        }
        return null;
    }

    /** Build a NativeImage from a data URL (used for resized clipboard images). */
    function nativeImageFromDataUrl(dataUrl) {
        if (!dataUrl) return null;
        const ni = electronModule('nativeImage');
        if (ni && ni.createFromDataURL) {
            try {
                const img = ni.createFromDataURL(dataUrl);
                if (img && !img.isEmpty()) return img;
            } catch (e) { log('nativeImage.createFromDataURL failed', e && e.message); }
        }
        return null;
    }

    /** Read a local file as a data URL (used for in-page clipboard fallbacks). */
    function readFileDataUrl(path, mime) {
        try {
            if (typeof require !== 'function') return null;
            const fs = require('fs');
            const buf = fs.readFileSync(path);
            return 'data:' + (mime || 'application/octet-stream') + ';base64,' + buf.toString('base64');
        } catch (e) {
            log('readFileDataUrl failed', e && e.message);
            return null;
        }
    }

    function fileExists(path) {
        try {
            if (typeof require !== 'function') return true;
            return require('fs').existsSync(path);
        } catch (e) { return true; }
    }

    /* ───────────────── demo data (browser preview only) ───────────────── */

    const DEMO_NAMES = [
        ['hero-shot-4k.jpg', 'image'], ['brand-guidelines.pdf', 'doc'], ['icon-set-v3.zip', 'doc'],
        ['product-tour.mp4', 'video'], ['moodboard-dark.png', 'image'], ['logo-mark.svg', 'image'],
        ['pricing-table.xlsx', 'doc'], ['podcast-intro.mp3', 'audio'], ['wireframe-flow.fig', 'doc'],
        ['texture-paper.jpg', 'image'], ['screenshot-app.png', 'image'], ['contract-draft.docx', 'doc'],
        ['promo-loop.webm', 'video'], ['palette-study.png', 'image'], ['press-kit.zip', 'doc'],
        ['team-photo.jpg', 'image'], ['type-specimen.pdf', 'doc'], ['b-roll-clip.mov', 'video'],
        ['ambient-loop.wav', 'audio'], ['chart-export.svg', 'image'], ['roadmap-q3.png', 'image'],
        ['release-notes.md', 'doc'], ['sticker-pack.png', 'image'], ['interview-cut.mp4', 'video']
    ];

    const DEMO_PAIRS = [
        ['#8b5cf6', '#22d3ee'], ['#f472b6', '#8b5cf6'], ['#22d3ee', '#34d399'],
        ['#fbbf24', '#f472b6'], ['#60a5fa', '#8b5cf6'], ['#34d399', '#22d3ee']
    ];

    function demoSvg(name, pair, w, h) {
        const letter = (String(name).trim()[0] || '?').toUpperCase();
        const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" viewBox="0 0 100 100">' +
            '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
            '<stop offset="0" stop-color="' + pair[0] + '"/><stop offset="1" stop-color="' + pair[1] + '"/>' +
            '</linearGradient></defs>' +
            '<rect width="100" height="100" fill="url(#g)"/>' +
            '<text x="50" y="50" font-family="system-ui,sans-serif" font-size="42" font-weight="700" ' +
            'fill="rgba(255,255,255,.92)" text-anchor="middle" dominant-baseline="central">' + letter + '</text></svg>';
        return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    }

    let demoItems = null;

    function buildDemoItems() {
        if (demoItems) return demoItems;
        const now = Date.now();
        demoItems = DEMO_NAMES.map(function (entry, i) {
            const ext = P.util.extOf(entry[0]);
            const kind = entry[1];
            const pair = DEMO_PAIRS[i % DEMO_PAIRS.length];
            const dims = kind === 'image'
                ? [1600 + i * 37, 900 + i * 21]
                : kind === 'video' ? [1920, 1080] : [0, 0];
            return {
                id: 'demo-' + (i + 1),
                name: entry[0],
                ext: ext,
                size: 40000 + i * 137000,
                width: dims[0],
                height: dims[1],
                url: 'https://example.com/' + entry[0],
                tags: i % 3 === 0 ? ['demo', 'design'] : ['demo'],
                folders: [i % 2 === 0 ? 'df-1' : 'df-2'],
                modifiedAt: now - i * 3600 * 1000,
                filePath: '',
                thumbnailURL: demoSvg(entry[0], pair, 240, 240),
                fileURL: '',
                isDemo: true
            };
        });
        return demoItems;
    }

    /* ───────────────── public bridge ───────────────── */

    const api = {

        get available() { return has(); },
        log: log,
        logTail: function (n) { return LOG_BUFFER.slice(-(n || 20)); },
        attempt: attempt,
        nativeImageFromPath: nativeImageFromPath,
        nativeImageFromDataUrl: nativeImageFromDataUrl,
        hasNativeImage: function () { return !!electronModule('nativeImage'); },
        readFileDataUrl: readFileDataUrl,
        fileExists: fileExists,

        get platform() {
            const e = eagle();
            if (e && e.app && e.app.platform) return e.app.platform;
            return (navigator.platform || '').toLowerCase().indexOf('mac') > -1 ? 'darwin' : 'win32';
        },
        get isMac() { return api.platform === 'darwin'; },

        /* ── events ── */
        onPluginCreate: function (cb) { if (has() && eagle().onPluginCreate) eagle().onPluginCreate(function (plugin) { try { cb(plugin); } catch (e) { log('onPluginCreate handler', e); } }); },
        onPluginRun: function (cb) { if (has() && eagle().onPluginRun) eagle().onPluginRun(cb); },
        onPluginShow: function (cb) { if (has() && eagle().onPluginShow) eagle().onPluginShow(cb); },
        onPluginHide: function (cb) { if (has() && eagle().onPluginHide) eagle().onPluginHide(cb); },
        onPluginBeforeExit: function (cb) { if (has() && eagle().onPluginBeforeExit) eagle().onPluginBeforeExit(cb); },
        onThemeChanged: function (cb) { if (has() && eagle().onThemeChanged) eagle().onThemeChanged(cb); },
        onLibraryChanged: function (cb) { if (has() && eagle().onLibraryChanged) eagle().onLibraryChanged(cb); },

        /* ── app ── */
        app: {
            get version() { const e = eagle(); return (e && e.app && e.app.version) || 'n/a'; },
            get build() { const e = eagle(); return (e && e.app && e.app.build) || 'n/a'; },
            get locale() { const e = eagle(); return (e && e.app && e.app.locale) || (navigator.language || 'en'); },
            get theme() { const e = eagle(); return (e && e.app && e.app.theme) || 'DARK'; },
            isDarkColors: function () {
                const e = eagle();
                if (e && e.app && e.app.isDarkColors) { try { return !!e.app.isDarkColors(); } catch (err) { /* ignore */ } }
                return true;
            },
            show: function () { return has() && window.eagle.app.show ? window.eagle.app.show() : Promise.resolve(false); }
        },

        /* ── library ── */
        library: {
            get name() {
                const e = eagle();
                const explicit = (e && e.library && e.library.name) || '';
                if (explicit) return explicit;
                // Some builds expose only the path; the folder name is the library name.
                const path = (e && e.library && e.library.path) || '';
                const base = String(path).split(/[\\/]/).filter(Boolean).pop() || '';
                return base.replace(/\.library$/i, '') || (has() ? '' : 'Demo Library');
            },
            get path() { const e = eagle(); return (e && e.library && e.library.path) || ''; },
            info: function () { return attempt('library.info', function () { return window.eagle.library.info(); }, null); }
        },

        /* ── items ── */
        item: {
            /** Search the library. Falls back to demo data outside Eagle. */
            get: async function (options) {
                if (!has()) return filterDemo(options);
                const out = await attempt('item.get', function () { return window.eagle.item.get(options || {}); }, []);
                return Array.isArray(out) ? out.map(normalize) : [];
            },
            getSelected: async function () {
                if (!has()) return buildDemoItems().slice(0, 3);
                const out = await attempt('item.getSelected', function () { return window.eagle.item.getSelected(); }, []);
                return Array.isArray(out) ? out.map(normalize) : [];
            },
            getByIds: async function (ids) {
                if (!ids || !ids.length) return [];
                if (!has()) {
                    const byId = {};
                    buildDemoItems().forEach(function (it) { byId[it.id] = it; });
                    return ids.map(function (id) { return byId[id]; }).filter(Boolean);
                }
                const out = await attempt('item.getByIds', function () { return window.eagle.item.getByIds(ids); }, []);
                return Array.isArray(out) ? out.map(normalize) : [];
            },
            getById: async function (id) {
                const list = await api.item.getByIds([id]);
                return list[0] || null;
            },
            countAll: async function () {
                if (!has()) return buildDemoItems().length;
                const n = await attempt('item.countAll', function () { return window.eagle.item.countAll(); }, 0);
                return Number(n) || 0;
            },
            /** Fast id + modifiedAt listing, used to page the picker. */
            getIdsWithModifiedAt: async function () {
                if (!has()) {
                    return buildDemoItems().map(function (it) { return { id: it.id, modifiedAt: it.modifiedAt }; });
                }
                const out = await attempt('item.getIdsWithModifiedAt', function () { return window.eagle.item.getIdsWithModifiedAt(); }, []);
                return Array.isArray(out) ? out : [];
            },
            select: function (ids) {
                if (!has() || !window.eagle.item.select) return Promise.resolve(false);
                return attemptVoid('item.select', function () { return window.eagle.item.select(ids); });
            },
            open: function (id, options) {
                if (!has()) { P.util.toast({ title: 'Demo mode', sub: 'Opening items needs Eagle installed.' }); return Promise.resolve(false); }
                return attempt('item.open', function () { return window.eagle.item.open(id, options || {}); }, false);
            },
            addBookmark: function (url, options) {
                if (!has()) { P.util.toast({ title: 'Demo mode', sub: 'Saving needs Eagle installed.' }); return Promise.resolve(null); }
                return attempt('item.addBookmark', function () { return window.eagle.item.addBookmark(url, options || {}); }, null);
            },
            addFromBase64: function (base64, options) {
                if (!has()) { P.util.toast({ title: 'Demo mode', sub: 'Saving needs Eagle installed.' }); return Promise.resolve(null); }
                return attempt('item.addFromBase64', function () { return window.eagle.item.addFromBase64(base64, options || {}); }, null);
            },
            addFromPath: function (path, options) {
                if (!has()) { P.util.toast({ title: 'Demo mode', sub: 'Saving needs Eagle installed.' }); return Promise.resolve(null); }
                return attempt('item.addFromPath', function () { return window.eagle.item.addFromPath(path, options || {}); }, null);
            },
            /** Persist tag/folder edits made on an item instance. */
            save: function (item) {
                if (!has() || !item || typeof item.save !== 'function') return Promise.resolve(false);
                return attempt('item.save', function () { return item.save(); }, false);
            }
        },

        /* ── folders ── */
        folder: {
            getAll: async function () {
                if (!has()) {
                    return [
                        { id: 'df-1', name: 'Design', parent: null, childrenCount: 1, iconColor: 'blue' },
                        { id: 'df-2', name: 'References', parent: null, childrenCount: 0, iconColor: 'pink' },
                        { id: 'df-3', name: 'Design / UI', parent: 'df-1', childrenCount: 0, iconColor: 'purple' }
                    ];
                }
                const out = await attempt('folder.getAll', function () { return window.eagle.folder.getAll(); }, []);
                return Array.isArray(out) ? out.map(function (f) {
                    return { id: f.id, name: f.name, parent: f.parent || null, iconColor: f.iconColor || '', __raw: f };
                }) : [];
            }
        },

        /* ── clipboard ── */
        clipboard: {
            writeText: function (text) {
                if (!has()) return P.util.copyPlainText(text).then(function () { return true; }, function () { return false; });
                return attemptVoid('clipboard.writeText', function () { return window.eagle.clipboard.writeText(text); });
            },
            copyFiles: function (paths) {
                if (!has() || !window.eagle.clipboard.copyFiles) return Promise.resolve(false);
                return attemptVoid('clipboard.copyFiles', function () { return window.eagle.clipboard.copyFiles(paths); });
            },
            writeImage: function (image) {
                if (!has() || !image) return Promise.resolve(false);
                return attemptVoid('clipboard.writeImage', function () { return window.eagle.clipboard.writeImage(image); });
            },
            /** Read the clipboard image back — used by the attachment self-test. */
            readImage: function () {
                if (!has() || !window.eagle.clipboard.readImage) return null;
                try { return window.eagle.clipboard.readImage(); } catch (e) { return null; }
            },
            /** Write a local file to the OS clipboard as a file drop list. */
            writeFileBuffer: function (filePath) {
                if (!has() || !window.eagle.clipboard.writeBuffer) return Promise.resolve(false);
                return attemptVoid('clipboard.writeBuffer', function () {
                    const buf = Buffer.from(String(filePath) + '\u0000', 'ucs2');
                    window.eagle.clipboard.writeBuffer('FileNameW', buf);
                });
            }
        },

        /* ── shell ── */
        shell: {
            openExternal: function (url) {
                if (!has()) { window.open(url, '_blank'); return Promise.resolve(); }
                return attempt('shell.openExternal', function () { return window.eagle.shell.openExternal(url); });
            },
            openPath: function (path) {
                if (!has()) { P.util.toast({ title: 'Demo mode' }); return Promise.resolve(); }
                return attempt('shell.openPath', function () { return window.eagle.shell.openPath(path); });
            },
            showItemInFolder: function (path) {
                if (!has()) { P.util.toast({ title: 'Demo mode' }); return Promise.resolve(); }
                return attempt('shell.showItemInFolder', function () { return window.eagle.shell.showItemInFolder(path); });
            }
        },

        /* ── native drag ── */
        drag: {
            startDrag: function (paths) {
                if (!has() || !window.eagle.drag || !window.eagle.drag.startDrag) {
                    return Promise.reject(new Error('native drag unavailable'));
                }
                return window.eagle.drag.startDrag(paths);
            }
        },

        /* ── dialogs ── */
        dialog: {
            message: function (options) {
                if (!has()) return Promise.resolve({ response: 0 });
                return attempt('dialog.showMessageBox', function () { return window.eagle.dialog.showMessageBox(options); }, { response: 0 });
            },
            confirm: async function (title, message, okLabel, cancelLabel) {
                const res = await api.dialog.message({
                    type: 'question',
                    title: title,
                    message: message,
                    buttons: [okLabel || 'OK', cancelLabel || 'Cancel'],
                    defaultId: 0,
                    cancelId: 1
                });
                return !res || res.response === 0;
            },
            chooseDirectory: async function (title) {
                if (!has()) return '';
                const res = await attempt('dialog.showOpenDialog', function () {
                    return window.eagle.dialog.showOpenDialog({ title: title || 'Choose folder', properties: ['openDirectory', 'createDirectory'] });
                }, { canceled: true, filePaths: [] });
                if (!res || res.canceled || !res.filePaths || !res.filePaths.length) return '';
                return res.filePaths[0];
            }
        },

        /* ── native context menu ── */
        menu: {
            open: function (items) {
                if (!has() || !window.eagle.contextMenu || !window.eagle.contextMenu.open) return false;
                try {
                    window.eagle.contextMenu.open(items);
                    return true;
                } catch (e) {
                    log('contextMenu.open failed', e && e.message);
                    return false;
                }
            }
        },

        /* ── window ── */
        win: {
            minimize: function () { return has() && window.eagle.window.minimize ? window.eagle.window.minimize() : Promise.resolve(); },
            maximize: function () { return has() && window.eagle.window.maximize ? window.eagle.window.maximize() : Promise.resolve(); },
            unmaximize: function () { return has() && window.eagle.window.unmaximize ? window.eagle.window.unmaximize() : Promise.resolve(); },
            isMaximized: function () { return has() && window.eagle.window.isMaximized ? window.eagle.window.isMaximized() : Promise.resolve(false); },
            hide: function () { return has() && window.eagle.window.hide ? window.eagle.window.hide() : Promise.resolve(); },
            /** Screenshot the plugin window (optionally a rect) as a NativeImage. */
            capturePage: function (rect) {
                if (!has() || !window.eagle.window.capturePage) return Promise.resolve(null);
                return attempt('window.capturePage', function () { return window.eagle.window.capturePage(rect); }, null);
            },
            close: async function () {
                // No documented close() on the window API: window.close() is the
                // Electron path, with hide() as a graceful fallback.
                try { window.close(); } catch (e) { /* ignore */ }
                setTimeout(function () {
                    if (!document.hidden) api.win.hide();
                }, 350);
            }
        },

        /** Snapshot of everything useful when something goes wrong. */
        diag: function () {
            const e = eagle();
            return {
                pluginVersion: (P.App && P.App.pluginVersion) || 'unknown',
                eagleApi: has() ? 'yes' : 'no (demo mode)',
                eagleVersion: api.app.version,
                eagleBuild: api.app.build,
                platform: api.platform,
                locale: api.app.locale,
                theme: api.app.theme,
                library: api.library.name + (api.library.path ? ' — ' + api.library.path : ''),
                userAgent: navigator.userAgent,
                engine: P.Engine ? P.Engine.kind : 'unknown',
                browserUserAgent: P.Engine ? P.Engine.browserUserAgent() : 'unknown',
                uaSpoofing: P.Engine ? (P.Engine.spoofingUserAgent ? 'on' : 'off') : 'unknown',
                session: P.Engine ? (P.Engine.sessionPartition === 'perch' ? 'persist:perch' : 'Eagle default') : 'unknown',
                lastAttach: P.Actions && P.Actions.lastResult
                    ? [P.Actions.lastResult.route,
                       P.Actions.lastResult.width ? P.Actions.lastResult.width + '×' + P.Actions.lastResult.height : '',
                       P.Actions.lastResult.bytes ? Math.round(P.Actions.lastResult.bytes / 1024) + ' KB' : '',
                       P.Actions.lastResult.name || ''].filter(Boolean).join(' · ')
                    : 'nothing attached yet',
                origin: location.origin,
                nodeRequire: typeof require === 'function' ? 'yes' : 'no',
                nativeImage: electronModule('nativeImage') ? 'yes' : 'no',
                webviewTag: P.Engine ? P.Engine.probeWebview() : 'unknown',
                contextMenu: (e && e.contextMenu) ? 'yes' : 'no',
                dragApi: (e && e.drag) ? 'yes' : 'no',
                dialogApi: (e && e.dialog) ? 'yes' : 'no'
            };
        }
    };

    /* Normalise an Eagle Item instance into a plain, persistable snapshot. */
    function normalize(item) {
        if (!item || typeof item !== 'object') return null;
        return {
            id: item.id,
            name: item.name || item.id,
            ext: item.ext || P.util.extOf(item.name),
            size: item.size || 0,
            width: item.width || 0,
            height: item.height || 0,
            url: item.url || '',
            tags: Array.isArray(item.tags) ? item.tags.slice() : [],
            folders: Array.isArray(item.folders) ? item.folders.slice() : [],
            modifiedAt: item.modifiedAt || item.importedAt || 0,
            filePath: item.filePath || '',
            fileURL: item.fileURL || '',
            thumbnailURL: item.thumbnailURL || '',
            annotation: item.annotation || '',
            __raw: item
        };
    }

    function filterDemo(options) {
        const all = buildDemoItems();
        const o = options || {};
        let out = all;
        if (o.isSelected) out = all.slice(0, 3);
        if (o.folders && o.folders.length) out = out.filter(function (it) { return it.folders.some(function (f) { return o.folders.indexOf(f) > -1; }); });
        if (o.tags && o.tags.length) out = out.filter(function (it) { return it.tags.some(function (t) { return o.tags.indexOf(t) > -1; }); });
        if (o.keywords && o.keywords.length) {
            const needle = String(o.keywords[0] || '').toLowerCase();
            if (needle) out = out.filter(function (it) { return String(it.name).toLowerCase().indexOf(needle) > -1; });
        }
        return out.slice();
    }

    P.Eagle = api;
})(window.Perch);
