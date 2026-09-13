/* ============================================================================
   Perch — shelf.js
   The attachment shelf plus P.Actions, the shared "what can I do with this
   Eagle item" layer used by both the library cards and the shelf chips.

   Attaching into a web page has four routes, in order of fidelity:
     1. native drag-out      eagle.drag.startDrag   → drop onto the page
     2. copy file            eagle.clipboard.copyFiles → Ctrl/⌘+V in the page
     3. copy image           eagle.clipboard.writeImage → rich paste
     4. copy path / name     eagle.clipboard.writeText
   ========================================================================== */
window.Perch = window.Perch || {};

(function (P) {
    'use strict';

    const u = P.util;
    const E = P.Eagle;

    const MIME = {
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
        webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', avif: 'image/avif'
    };

    // Upload-friendly ceiling. Chat and form uploaders start refusing camera-sized
    // originals; 1600px is plenty for a model or a document.
    const FIT_MAX_EDGE = 1600;
    const FIT_MAX_BYTES = 3.5 * 1024 * 1024;

    /** What the last attach actually put on the clipboard, for Diagnostics. */
    function recordLast(entry) {
        Actions.lastResult = Object.assign({ at: Date.now() }, entry);
    }

    /* ═══════════════════════════ item actions ═══════════════════════════ */

    const Actions = {

        /** What the last attach put on the clipboard (shown in Diagnostics). */
        lastResult: null,

        /** Rows from the last attachment self-test. */
        lastSelfTest: null,

        /** Result of the last page storage probe. */
        lastProbe: null,

        /** Do we have a usable local file for this item? */
        fileOf: function (item) { return (item && item.filePath) || ''; },

        /** Live Eagle Item instance (falls back to a fresh lookup). */
        liveItem: async function (item) {
            if (item && item.__raw && typeof item.__raw.save === 'function') return item.__raw;
            const fresh = await E.item.getById(item.id);
            return (fresh && fresh.__raw) || null;
        },

        copyText: async function (value, label) {
            const ok = await E.clipboard.writeText(String(value));
            if (ok) {
                u.toast({ title: 'Copied ' + (label || 'text'), sub: String(value).slice(0, 90), kind: 'success' });
            } else {
                u.toast({ title: 'Could not copy ' + (label || 'text'), kind: 'error' });
            }
        },

        /** Copy real files so they can be pasted into a page or a file manager. */
        copyFiles: async function (items) {
            const paths = items.map(Actions.fileOf).filter(Boolean);
            if (!paths.length) {
                u.toast({ title: 'No file path available', sub: 'This item has no local file.', kind: 'warn' });
                return false;
            }
            let ok = await E.clipboard.copyFiles(paths);
            if (!ok && paths.length === 1) ok = await E.clipboard.writeFileBuffer(paths[0]);
            if (!ok) {
                // Last resort: put the paths on the clipboard as text.
                await E.clipboard.writeText(paths.join('\n'));
                u.toast({ title: 'File copy unavailable', sub: 'The path was copied as text instead.', kind: 'warn' });
                return false;
            }
            u.toast({
                title: paths.length === 1 ? '1 file copied' : paths.length + ' files copied',
                sub: 'Click the page, then press Ctrl/⌘ + V to attach.',
                kind: 'success',
                icon: 'paperclip'
            });
            recordLast({
                route: 'file',
                name: items.map(function (i) { return i.name; }).join(', ').slice(0, 60),
                count: paths.length
            });
            if (P.Browser && P.Browser.focusContent) setTimeout(function () { P.Browser.focusContent(); }, 120);
            return true;
        },

        /**
         * Copy a single image as image *data*.
         *
         * Web composers (Gemini, ChatGPT, Claude, Docs, Slack) accept a pasted
         * picture. They are far less reliable about a pasted *file*, and a raw
         * Eagle original is often a multi-megabyte PNG straight off a camera,
         * which uploaders reject. So by default the image is fitted to a sane
         * upload size first; `original: true` skips that.
         */
        copyImage: async function (item, options) {
            const opts = options || {};
            const path = Actions.fileOf(item);
            const ext = String(item.ext || '').toLowerCase();

            if (!u.rasterImage(ext)) {
                u.toast({
                    title: 'Cannot paste a ' + (ext || '?').toUpperCase() + ' as a picture',
                    sub: 'Browsers cannot decode it. Use “Copy file” instead.',
                    kind: 'warn'
                });
                return false;
            }
            if (!path) {
                u.toast({ title: 'No file path available', kind: 'warn' });
                return false;
            }

            const mime = MIME[ext] || 'image/png';

            // 1. fitted image data — the reliable route for AI chats and editors
            if (!opts.original) {
                const prepared = await prepareImage(path, mime, FIT_MAX_EDGE, FIT_MAX_BYTES);
                if (prepared) {
                    const ok = await writeImageData(prepared);
                    if (ok) {
                        recordLast({
                            route: prepared.untouched ? 'image (original bytes)' : 'image (fitted)',
                            name: item.name,
                            type: prepared.type,
                            width: prepared.width,
                            height: prepared.height,
                            bytes: prepared.bytes
                        });
                        u.toast({
                            title: prepared.resized ? 'Image copied (fitted)' : 'Image copied',
                            sub: prepared.width + '×' + prepared.height + ' · ' + (u.fmtBytes(prepared.bytes) || '?') +
                                 (prepared.resized ? ' — resized so upload fields accept it' : '') +
                                 '. Paste with Ctrl/⌘ + V.',
                            kind: 'success',
                            icon: 'image'
                        });
                        focusPageSoon();
                        return true;
                    }
                }
            }

            // 2. original bytes through the OS clipboard
            const native = await E.nativeImageFromPath(path);
            if (native) {
                const ok = await E.clipboard.writeImage(native);
                if (ok) {
                    u.toast({ title: 'Image copied', sub: 'Paste it with Ctrl/⌘ + V.', kind: 'success', icon: 'image' });
                    focusPageSoon();
                    return true;
                }
            }

            // 3. last resort: hand the bytes to the web clipboard
            const fallback = await prepareImage(path, mime, 0, 0);
            if (fallback && await writeImageViaWebClipboard(fallback)) {
                u.toast({ title: 'Image copied', sub: 'Paste it with Ctrl/⌘ + V.', kind: 'success', icon: 'image' });
                return true;
            }

            u.toast({
                title: 'Could not copy the image',
                sub: 'Drag the shelf card onto the page instead — that always works.',
                kind: 'error'
            });
            return false;
        },

        /**
         * Prove the plugin's own half of the pipeline without involving a web
         * page: build a known image, put it on the clipboard the same way an
         * attach does, then read the clipboard back and measure it. If this
         * passes, the bytes left the machine correctly and any remaining failure
         * belongs to the site.
         */
        selfTest: async function () {
            const rows = [];
            const add = function (label, value) { rows.push([label, value]); };

            add('eagle api', E.available ? 'yes' : 'no (demo mode)');
            add('nativeImage module', E.hasNativeImage() ? 'yes' : 'no');

            let canvas = null;
            try {
                canvas = document.createElement('canvas');
                canvas.width = 64;
                canvas.height = 64;
                const ctx = canvas.getContext('2d');
                ctx.fillStyle = '#7c5cff';
                ctx.fillRect(0, 0, 64, 64);
                add('canvas', 'ok');
            } catch (err) {
                add('canvas', 'FAILED — ' + (err && err.message));
            }

            let dataUrl = '';
            try {
                dataUrl = canvas ? canvas.toDataURL('image/png') : '';
                add('test image', dataUrl ? Math.round(dataUrl.length * 0.75 / 1024) + ' KB png' : 'none');
            } catch (err) {
                add('test image', 'FAILED — ' + (err && err.message));
            }

            const prepared = {
                dataUrl: dataUrl, blob: null, type: 'image/png',
                width: 64, height: 64, resized: false, untouched: true,
                bytes: Math.round(dataUrl.length * 0.75)
            };
            const wrote = dataUrl ? await writeImageData(prepared) : false;
            add('clipboard write', wrote ? 'ok' : 'FAILED — no clipboard route worked');

            let readBack = 'skipped';
            if (wrote) {
                const image = E.clipboard.readImage();
                if (!image) readBack = 'unavailable (no readImage)';
                else {
                    try {
                        const size = image.getSize ? image.getSize() : null;
                        readBack = size && size.width ? size.width + '×' + size.height + ' ok' : 'image was empty';
                    } catch (err) {
                        readBack = 'FAILED — ' + (err && err.message);
                    }
                }
            }
            add('clipboard read-back', readBack);

            Actions.lastSelfTest = rows;
            const failed = rows.some(function (row) { return /FAILED/.test(String(row[1])); });
            u.toast({
                title: failed ? 'Attachment self-test found a problem' : 'Attachment pipeline works',
                sub: 'Copy diagnostics (Settings) to send the details.',
                kind: failed ? 'error' : 'success',
                icon: failed ? 'shield' : 'check'
            });
            return rows;
        },

        /** Plain-text report: the thing to paste into a bug report. */
        report: function () {
            const diag = E.diag();
            const lines = [];
            lines.push('Perch ' + diag.pluginVersion + ' · Eagle ' + diag.eagleVersion + ' (build ' + diag.eagleBuild + ') · ' + diag.platform);
            lines.push('engine: ' + diag.engine + ' · webview tag: ' + diag.webviewTag + ' · ua spoofing: ' + diag.uaSpoofing);
            const engineState = P.Engine.engineReport();
            lines.push('engine detail: requested ' + engineState.requested + ' → granted ' + engineState.granted +
                       ' · webview available: ' + (engineState.webviewAvailable ? 'yes' : 'NO (Eagle does not expose it)'));
            lines.push('session: ' + diag.session + ' · pop-ups: ' + ((P.App && P.App.settings && P.App.settings.popupMode) || 'window'));

            if (Actions.lastProbe) {
                lines.push('page storage probe:');
                Object.keys(Actions.lastProbe).forEach(function (key) {
                    lines.push('  ' + key + ': ' + Actions.lastProbe[key]);
                });
            } else {
                lines.push('page storage probe: not run (Settings → Probe this page)');
            }
            lines.push('library: ' + diag.library);
            lines.push('browser ua: ' + diag.browserUserAgent);
            lines.push('last attach: ' + diag.lastAttach);
            if (Actions.lastSelfTest) {
                lines.push('self-test:');
                Actions.lastSelfTest.forEach(function (row) { lines.push('  ' + row[0] + ': ' + row[1]); });
            } else {
                lines.push('self-test: not run (Settings → Run attachment self-test)');
            }

            const guest = (P.Engine.guestConsole ? P.Engine.guestConsole(6) : []);
            if (guest.length) {
                lines.push('page console (last ' + guest.length + '):');
                guest.forEach(function (entry) {
                    lines.push('  [' + entry.level + '] ' + entry.message + '  @' + entry.source);
                });
            } else {
                lines.push('page console: nothing captured');
            }

            lines.push('perch log (last 12):');
            E.logTail(12).forEach(function (line) { lines.push('  ' + line); });
            return lines.join('\n');
        },

        reveal: function (item) {
            const path = Actions.fileOf(item);
            if (!path) return u.toast({ title: 'No file path available', kind: 'warn' });
            E.shell.showItemInFolder(path);
        },

        openFile: function (item) {
            const path = Actions.fileOf(item);
            if (!path) return u.toast({ title: 'No file path available', kind: 'warn' });
            E.shell.openPath(path);
        },

        openInEagle: function (item) { E.item.open(item.id); },

        /** Tag every item with the domain of the page currently open. */
        tagWithCurrentPage: async function (items) {
            const url = (P.Browser && P.Browser.currentUrl && P.Browser.currentUrl()) || '';
            const host = u.hostOf(url);
            if (!host) {
                u.toast({ title: 'No page to tag with', sub: 'Open a website first.', kind: 'warn' });
                return;
            }
            let tagged = 0;
            for (const item of items) {
                try {
                    const live = await Actions.liveItem(item);
                    if (!live) continue;
                    const tags = Array.isArray(live.tags) ? live.tags.slice() : [];
                    if (tags.indexOf(host) > -1) continue;
                    tags.push(host);
                    live.tags = tags;
                    await live.save();
                    item.tags = tags;
                    tagged++;
                } catch (err) {
                    E.log('tag failed', err && err.message);
                }
            }
            u.toast({
                title: tagged ? 'Tagged ' + tagged + ' item' + (tagged === 1 ? '' : 's') : 'Already tagged',
                sub: host,
                kind: tagged ? 'success' : 'info',
                icon: 'tag'
            });
        },

        /** Primary attach action — what the shelf's Attach button does. */
        attach: async function (items) {
            if (!items || !items.length) return;

            // A single image pastes best as picture data; everything else has to
            // travel as a file (and so does a batch).
            if (items.length === 1 && u.rasterImage(items[0].ext)) {
                await Actions.copyImage(items[0]);
                return;
            }
            if (items.length === 1 && u.kindOf(items[0].ext) === 'image') {
                u.toast({
                    title: 'This one cannot be pasted as a picture',
                    sub: 'Copying the file instead — then paste it into the page.',
                    kind: 'info',
                    icon: 'file'
                });
            }
            await Actions.copyFiles(items);
        },

        /** Native right-click menu, with an in-page fallback menu. */
        menuFor: function (items, anchor) {
            if (!items || !items.length) return;
            const single = items.length === 1 ? items[0] : null;
            const pasteable = !!single && u.rasterImage(single.ext);

            const entries = [
                {
                    id: 'attach',
                    label: items.length === 1
                        ? (pasteable ? 'Attach — copy image for pasting' : 'Attach — copy file for pasting')
                        : 'Attach — copy ' + items.length + ' files',
                    click: function () { Actions.attach(items); }
                },
                pasteable ? {
                    id: 'copy-image-fitted',
                    label: 'Copy image — fitted to ' + FIT_MAX_EDGE + 'px',
                    click: function () { Actions.copyImage(single); }
                } : null,
                pasteable ? {
                    id: 'copy-image-original',
                    label: 'Copy image — original size',
                    click: function () { Actions.copyImage(single, { original: true }); }
                } : null,
                {
                    id: 'copy-file',
                    label: items.length === 1 ? 'Copy file' : 'Copy files',
                    click: function () { Actions.copyFiles(items); }
                },
                {
                    id: 'copy-name',
                    label: items.length === 1 ? 'Copy name' : 'Copy names',
                    click: function () { Actions.copyText(items.map(function (i) { return i.name; }).join('\n'), 'name'); }
                },
                {
                    id: 'copy-path',
                    label: 'Copy file path',
                    click: function () { Actions.copyText(items.map(Actions.fileOf).filter(Boolean).join('\n'), 'path'); }
                },
                { id: 'sep-1', type: 'separator', label: '' },
                {
                    id: 'reveal',
                    label: 'Reveal in file manager',
                    enabled: !!single,
                    click: function () { Actions.reveal(single); }
                },
                {
                    id: 'open-file',
                    label: 'Open file',
                    enabled: !!single,
                    click: function () { Actions.openFile(single); }
                },
                {
                    id: 'open-eagle',
                    label: 'Open in Eagle',
                    enabled: !!single,
                    click: function () { Actions.openInEagle(single); }
                },
                { id: 'sep-2', type: 'separator', label: '' },
                {
                    id: 'tag-page',
                    label: 'Tag with current page',
                    click: function () { Actions.tagWithCurrentPage(items); }
                },
                {
                    id: 'shelf-remove',
                    label: 'Remove from shelf',
                    click: function () { items.forEach(function (it) { P.Shelf.remove(it.id); }); }
                }
            ].filter(Boolean);

            if (E.menu.open(entries)) return;
            showHtmlMenu(anchor, entries);
        }
    };

    /**
     * Decode a local file and (optionally) fit it to upload-friendly limits.
     * Returns image data plus a blob, or null when the format cannot be decoded.
     */
    async function prepareImage(path, mime, maxEdge, maxBytes) {
        try {
            const source = E.readFileDataUrl(path, mime);
            if (!source) return null;
            const sourceBytes = Math.round(source.length * 0.75);

            const image = await new Promise(function (resolve, reject) {
                const img = new Image();
                img.onload = function () { resolve(img); };
                img.onerror = function () { reject(new Error('decode failed')); };
                img.src = source;
            });

            const width = image.naturalWidth || image.width || 0;
            const height = image.naturalHeight || image.height || 0;
            if (!width || !height) return null;

            const needsFit = !!maxEdge && Math.max(width, height) > maxEdge;

            // Already within limits: hand over the original bytes completely
            // untouched. No re-encode, no generation loss — this is the common
            // case, and it keeps screenshots crisp (a JPEG round-trip wrecks text).
            if (!needsFit && (!maxBytes || sourceBytes <= maxBytes)) {
                return {
                    dataUrl: source, blob: null, type: mime,
                    width: width, height: height, resized: false,
                    untouched: true, bytes: sourceBytes
                };
            }

            const scale = needsFit ? maxEdge / Math.max(width, height) : 1;
            const outW = Math.max(1, Math.round(width * scale));
            const outH = Math.max(1, Math.round(height * scale));

            const canvas = document.createElement('canvas');
            canvas.width = outW;
            canvas.height = outH;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(image, 0, 0, outW, outH);

            const isJpeg = /jpe?g/i.test(String(mime || ''));
            let type = isJpeg ? 'image/jpeg' : 'image/png';
            let quality = isJpeg ? 0.92 : undefined;
            let dataUrl = canvas.toDataURL(type, quality);

            // Still too heavy for an upload field. Photography can move to JPEG,
            // but only when there is no transparency to destroy.
            if (maxBytes && Math.round(dataUrl.length * 0.75) > maxBytes) {
                const alt = canvas.toDataURL('image/jpeg', 0.9);
                if (alt.length < dataUrl.length && (isJpeg || !hasAlpha(ctx, outW, outH))) {
                    dataUrl = alt;
                    type = 'image/jpeg';
                    quality = 0.9;
                }
            }

            const blob = await new Promise(function (resolve) {
                canvas.toBlob(resolve, type, quality);
            });

            return {
                dataUrl: dataUrl,
                blob: blob || null,
                type: type,
                width: outW,
                height: outH,
                resized: needsFit,
                untouched: false,
                bytes: Math.round(dataUrl.length * 0.75)
            };
        } catch (err) {
            E.log('could not prepare image', err && err.message);
            return null;
        }
    }

    /** True when any pixel is not fully opaque. Assumes yes if it cannot tell. */
    function hasAlpha(ctx, width, height) {
        try {
            const data = ctx.getImageData(0, 0, width, height).data;
            for (let i = 3; i < data.length; i += 4) {
                if (data[i] < 255) return true;
            }
            return false;
        } catch (e) {
            return true;   // unreadable canvas: keep the lossless format
        }
    }

    /** Prefer the OS clipboard (most compatible); fall back to the web one. */
    async function writeImageData(prepared) {
        const native = E.nativeImageFromDataUrl(prepared.dataUrl);
        if (native) {
            const ok = await E.clipboard.writeImage(native);
            if (ok) return true;
        }
        return writeImageViaWebClipboard(prepared);
    }

    async function writeImageViaWebClipboard(prepared) {
        try {
            if (!navigator.clipboard || !window.ClipboardItem || !prepared.blob) return false;
            const type = prepared.blob.type || 'image/png';
            await navigator.clipboard.write([new window.ClipboardItem({ [type]: prepared.blob })]);
            return true;
        } catch (err) {
            E.log('web clipboard write failed', err && err.message);
            return false;
        }
    }

    function focusPageSoon() {
        if (P.Browser && P.Browser.focusContent) setTimeout(function () { P.Browser.focusContent(); }, 120);
    }

    /** Fallback context menu drawn inside the plugin window. */
    function showHtmlMenu(anchor, entries) {
        u.qsa('.menu.popup').forEach(function (m) { m.remove(); });
        const menu = u.h('div', { class: 'menu popup', style: { position: 'fixed', zIndex: 120 } });

        entries.forEach(function (entry) {
            if (entry.type === 'separator') { menu.appendChild(u.h('div', { class: 'menu-sep' })); return; }
            const item = u.h('button', { class: 'menu-item' + (entry.id === 'shelf-remove' ? ' danger' : '') }, [
                u.h('span', { class: 'mi-label', text: entry.label })
            ]);
            if (entry.enabled === false) { item.style.opacity = '0.4'; item.style.pointerEvents = 'none'; }
            item.addEventListener('click', function () {
                menu.remove();
                try { entry.click && entry.click(); } catch (e) { E.log('menu action failed', e && e.message); }
            });
            menu.appendChild(item);
        });

        document.body.appendChild(menu);
        const rect = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: 40, top: 80, right: 40, bottom: 80 };
        const mw = menu.offsetWidth, mh = menu.offsetHeight;
        menu.style.left = u.clamp(Math.round(rect.left), 8, window.innerWidth - mw - 8) + 'px';
        menu.style.top = u.clamp(Math.round(rect.bottom + 4), 8, window.innerHeight - mh - 8) + 'px';

        const dismiss = function (e) {
            if (menu.contains(e.target)) return;
            menu.remove();
            document.removeEventListener('mousedown', dismiss, true);
        };
        setTimeout(function () { document.addEventListener('mousedown', dismiss, true); }, 0);
    }

    /* ═══════════════════════════ the shelf ═══════════════════════════ */

    const state = { items: [] };
    let els = {};

    function init() {
        els = {
            root: u.el('shelf'),
            items: u.el('shelfItems'),
            empty: u.el('shelfEmpty'),
            count: u.el('shelfCount'),
            badge: u.el('shelfBadge'),
            hint: u.el('shelfHint'),
            collapse: u.el('btnShelfCollapse'),
            clear: u.el('btnShelfClear'),
            copyAll: u.el('btnShelfCopyAll'),
            tagPage: u.el('btnShelfTagPage')
        };

        els.clear.addEventListener('click', clearAll);
        els.copyAll.addEventListener('click', function () { Actions.copyFiles(state.items); });
        els.tagPage.addEventListener('click', function () { Actions.tagWithCurrentPage(state.items); });
        els.collapse.addEventListener('click', function () {
            if (P.App && P.App.toggleShelf) P.App.toggleShelf();
        });

        restore();
    }

    function persist() {
        u.storageSet('shelf', state.items.map(function (it) {
            return {
                id: it.id, name: it.name, ext: it.ext, size: it.size,
                width: it.width, height: it.height, filePath: it.filePath,
                thumbnailURL: it.thumbnailURL, url: it.url, tags: it.tags,
                modifiedAt: it.modifiedAt
            };
        }));
    }

    async function restore() {
        const saved = u.storageGet('shelf', []);
        if (!Array.isArray(saved) || !saved.length) { render(); return; }
        state.items = saved;
        render();

        // Refresh against the live library so moved/deleted files drop out.
        if (!E.available) return;
        try {
            const fresh = await E.item.getByIds(saved.map(function (it) { return it.id; }));
            const byId = {};
            fresh.forEach(function (it) { if (it) byId[it.id] = it; });
            const kept = state.items.filter(function (it) { return !!byId[it.id]; });
            const dropped = state.items.length - kept.length;
            state.items = kept.map(function (it) { return Object.assign({}, it, byId[it.id]); });
            persist();
            render();
            if (dropped) u.toast({ title: dropped + ' shelf item' + (dropped === 1 ? '' : 's') + ' no longer in the library', kind: 'warn' });
        } catch (err) {
            E.log('shelf refresh failed', err && err.message);
        }
    }

    function has(id) { return state.items.some(function (it) { return it.id === id; }); }

    function add(items, opts) {
        const options = opts || {};
        let added = 0;
        items.forEach(function (item) {
            if (!item || has(item.id)) return;
            state.items.push(item);
            added++;
        });
        if (!added) {
            if (!options.silent && items.length) u.toast({ title: 'Already on the shelf', kind: 'info' });
            return;
        }
        persist();
        render();
        if (!options.silent) {
            u.toast({
                title: 'Added ' + added + ' to the shelf',
                sub: 'Drag a card into the page, or press Attach and paste.',
                kind: 'success',
                icon: 'paperclip'
            });
            if (P.App && P.App.openShelf) P.App.openShelf();
        }
        if (P.Library) P.Library.onShelfChanged();
    }

    function remove(id) {
        state.items = state.items.filter(function (it) { return it.id !== id; });
        persist();
        render();
        if (P.Library) P.Library.onShelfChanged();
    }

    async function clearAll() {
        if (!state.items.length) return;
        const ok = await E.dialog.confirm('Clear the shelf?', 'Remove all ' + state.items.length + ' attachments? Your Eagle library is not touched.', 'Clear shelf', 'Keep');
        if (!ok) return;
        state.items = [];
        persist();
        render();
        u.toast({ title: 'Shelf cleared', kind: 'success', icon: 'trash' });
        if (P.Library) P.Library.onShelfChanged();
    }

    function render() {
        u.clear(els.items);
        const n = state.items.length;

        els.count.textContent = String(n);
        els.badge.textContent = String(n);
        els.badge.classList.toggle('hot', n > 0);
        els.empty.hidden = n > 0;
        els.items.hidden = n === 0;
        els.copyAll.disabled = n === 0;
        els.tagPage.disabled = n === 0;
        els.clear.disabled = n === 0;
        els.hint.textContent = n === 0
            ? 'Drag a card into the page, or press Attach and paste with Ctrl/⌘ + V'
            : 'Images paste as pictures; other files paste as attachments. Or just drag a card onto the page.';

        state.items.forEach(function (item) { els.items.appendChild(buildChip(item)); });
    }

    function buildChip(item) {
        const kind = u.kindOf(item.ext);

        const thumb = u.h('div', { class: 'chip-thumb' });
        const src = item.thumbnailURL || (kind === 'image' ? item.fileURL : '');
        if (src) {
            const img = u.h('img', { attrs: { src: src, alt: '' } });
            img.addEventListener('error', function () { u.clear(thumb).appendChild(u.svgIcon(u.kindIcon(kind), 18)); });
            thumb.appendChild(img);
        } else {
            thumb.appendChild(u.svgIcon(u.kindIcon(kind), 18));
        }

        const attachBtn = u.h('button', {
            dataset: { act: 'attach' },
            title: u.rasterImage(item.ext)
                ? 'Copy this image so you can paste it into the page'
                : 'Copy this file so you can paste it into the page'
        }, [document.createTextNode('Attach')]);
        const menuBtn = u.h('button', { dataset: { act: 'menu' }, title: 'More actions' }, [u.svgIcon('dots', 12)]);
        const removeBtn = u.h('button', { dataset: { act: 'remove' }, title: 'Remove from shelf' }, [u.svgIcon('close', 11)]);

        const chip = u.h('div', {
            class: 'shelf-chip',
            attrs: { draggable: 'true' },
            title: item.name + '\n' + u.fmtSub(item) + '\nDrag onto the page to attach.'
        }, [
            thumb,
            u.h('div', { class: 'chip-info' }, [
                u.h('div', { class: 'chip-name', text: item.name }),
                u.h('div', { class: 'chip-sub', text: u.fmtSub(item) })
            ]),
            u.h('div', { class: 'chip-actions' }, [attachBtn, menuBtn, removeBtn])
        ]);

        attachBtn.addEventListener('click', function (e) { e.stopPropagation(); Actions.attach([item]); });
        menuBtn.addEventListener('click', function (e) { e.stopPropagation(); Actions.menuFor([item], chip); });
        removeBtn.addEventListener('click', function (e) { e.stopPropagation(); remove(item.id); });

        chip.addEventListener('contextmenu', function (e) { e.preventDefault(); Actions.menuFor([item], chip); });

        chip.addEventListener('dragstart', function () {
            chip.classList.add('dragging');
            P.Library.dragItems([item], chip);
        });
        chip.addEventListener('dragend', function () { chip.classList.remove('dragging'); });

        return chip;
    }

    P.Actions = Actions;
    P.Shelf = {
        init: init,
        add: add,
        remove: remove,
        has: has,
        list: function () { return state.items.slice(); },
        count: function () { return state.items.length; }
    };
})(window.Perch);
