/* ============================================================================
   Perch — util.js
   DOM helpers, inline icon set, formatting, storage, toasts, modal plumbing.
   Loaded first; every other module hangs off window.Perch.
   ========================================================================== */
window.Perch = window.Perch || {};

(function (P) {
    'use strict';

    const SVG_NS = 'http://www.w3.org/2000/svg';

    /* ─────────────────────────── DOM ─────────────────────────── */

    function el(id) { return document.getElementById(id); }

    function qs(sel, root) { return (root || document).querySelector(sel); }

    function qsa(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

    function clear(node) {
        if (!node) return node;
        while (node.firstChild) node.removeChild(node.firstChild);
        return node;
    }

    /**
     * Tiny element factory. Untrusted strings must go through `text`
     * (textContent) — `html` is reserved for trusted, hard-coded markup.
     * The plugin window has Node integration, so injecting HTML built from
     * Eagle item names or remote page titles would be a real vulnerability.
     */
    function h(tag, opts, children) {
        const node = document.createElement(tag);
        opts = opts || {};

        if (opts.class) node.className = opts.class;
        if (opts.text != null) node.textContent = String(opts.text);
        if (opts.html != null) node.innerHTML = opts.html; // trusted markup only
        if (opts.attrs) for (const k in opts.attrs) {
            const v = opts.attrs[k];
            if (v != null && v !== false) node.setAttribute(k, String(v));
        }
        if (opts.style) for (const k in opts.style) node.style[k] = opts.style[k];
        if (opts.dataset) for (const k in opts.dataset) node.dataset[k] = opts.dataset[k];
        if (opts.on) for (const k in opts.on) node.addEventListener(k, opts.on[k]);
        if (opts.title != null) node.title = String(opts.title);

        if (children != null) appendAll(node, children);
        return node;
    }

    function appendAll(node, children) {
        const list = Array.isArray(children) ? children : [children];
        for (const child of list) {
            if (child == null || child === false) continue;
            node.appendChild(typeof child === 'string' || typeof child === 'number'
                ? document.createTextNode(String(child))
                : child);
        }
        return node;
    }

    /* ─────────────────────────── icons ─────────────────────────── */

    // Each icon is a list of primitives:
    //   p:<path d>        stroked path
    //   f:<path d>        filled path
    //   c:cx,cy,r         stroked circle
    //   fc:cx,cy,r        filled circle
    //   r:x,y,w,h,rx      stroked rounded rect
    //   l:x1,y1,x2,y2     line
    const ICONS = {
        back: ['p:M15.5 4.6 8 12l7.5 7.4'],
        forward: ['p:M8.5 4.6 16 12l-7.5 7.4'],
        reload: ['p:M19.6 12A7.6 7.6 0 1 1 12 4.4', 'f:M12 4.4 8.1 1.3 8.1 7.5Z'],
        home: ['p:M3.4 11.3 12 4.2l8.6 7.1', 'p:M6.1 9.6V19.6h11.8V9.6'],
        plus: ['l:12,5.4,12,18.6', 'l:5.4,12,18.6,12'],
        close: ['l:6.6,6.6,17.4,17.4', 'l:17.4,6.6,6.6,17.4'],
        minimize: ['l:6,12,18,12'],
        maximize: ['r:5.4,5.4,13.2,13.2,2.6'],
        restore: ['r:4.4,8.6,10.8,10.8,2.4', 'p:M8.6 8.6V6.6h9v9h-2.2'],
        search: ['c:11,11,6.5', 'l:15.8,15.8,20.4,20.4'],
        folder: ['p:M3.6 7.4a2 2 0 0 1 2-2h3.3l2 2.4h7.5a2 2 0 0 1 2 2v7.4a2 2 0 0 1-2 2H5.6a2 2 0 0 1-2-2z'],
        layers: ['p:M12 3.6 3.4 8l8.6 4.4L20.6 8z', 'p:M3.4 12.4 12 16.8l8.6-4.4', 'p:M3.4 16.6 12 21l8.6-4.4'],
        paperclip: ['p:M16.4 8.7v6.6a3.9 3.9 0 0 1-7.8 0V7.5a3.9 3.9 0 0 1 7.8 0z', 'p:M11.2 16.8V8.9'],
        bookmark: ['p:M7.2 4.2h9.6v15.4l-4.8-3.4-4.8 3.4z'],
        camera: ['r:3.4,6.8,17.2,12.4,2.6', 'c:12,13,3.4', 'p:M8.6 6.8 10 4.4h4l1.4 2.4'],
        settings: ['l:4.2,8,19.8,8', 'c:9,8,2.1', 'l:4.2,16,19.8,16', 'c:15,16,2.1'],
        sun: ['c:12,12,4.3', 'l:12,3.2,12,5.2', 'l:12,18.8,12,20.8', 'l:3.2,12,5.2,12', 'l:18.8,12,20.8,12',
              'l:5.8,5.8,7.3,7.3', 'l:16.7,16.7,18.2,18.2', 'l:18.2,5.8,16.7,7.3', 'l:7.3,16.7,5.8,18.2'],
        moon: ['p:M12 3.2a6 6 0 0 0 8.8 8.8 9 9 0 1 1-8.8-8.8z'],
        copy: ['r:8.8,8.8,10.2,10.2,2.4', 'p:M15.2 5.6V4.8a2.4 2.4 0 0 0-2.4-2.4H4.8A2.4 2.4 0 0 0 2.4 4.8v8a2.4 2.4 0 0 0 2.4 2.4h.8'],
        trash: ['l:4.2,6.8,19.8,6.8', 'p:M9.4 6.8V4.6h5.2v2.2',
                'p:M6.6 6.8l.9 12.2a1.6 1.6 0 0 0 1.6 1.5h5.8a1.6 1.6 0 0 0 1.6-1.5l.9-12.2'],
        tag: ['p:M4.2 10.9V5.4a1.2 1.2 0 0 1 1.2-1.2h5.5l8.7 8.7a1.6 1.6 0 0 1 0 2.3l-4.3 4.3a1.6 1.6 0 0 1-2.3 0z', 'c:8,8,1.2'],
        chevronDown: ['p:M6.4 9.6 12 15.2l5.6-5.6'],
        chevronRight: ['p:M9.6 6.4 15.2 12l-5.6 5.6'],
        arrowRight: ['l:4.6,12,19.4,12', 'p:M13.4 6 19.4 12l-6 6'],
        external: ['p:M14 4.6h5.4V10', 'l:19.4,4.6,11.4,12.6',
                   'p:M17.8 14.4v4a1.6 1.6 0 0 1-1.6 1.6H5.6A1.6 1.6 0 0 1 4 18.4V7.6A1.6 1.6 0 0 1 5.6 6h4'],
        shield: ['p:M12 3.6 5 6.4v5.3c0 4.1 2.9 7.3 7 8.7 4.1-1.4 7-4.6 7-8.7V6.4z'],
        star: ['p:M12 3.9l2.6 5.2 5.8.8-4.2 4.1 1 5.8L12 17.1l-5.2 2.7 1-5.8L3.6 9.9l5.8-.8z'],
        help: ['c:12,12,8.5', 'p:M9.7 9.6a2.4 2.4 0 0 1 4.7.5c0 1.6-2.4 2-2.4 3.5', 'fc:12,17,1'],
        globe: ['c:12,12,8.4', 'l:3.6,12,20.4,12',
                'p:M12 3.6c2.6 2.3 3.9 5.1 3.9 8.4s-1.3 6.1-3.9 8.4c-2.6-2.3-3.9-5.1-3.9-8.4s1.3-6.1 3.9-8.4z'],
        image: ['r:3.4,4.6,17.2,14.8,2.6', 'c:8.6,9.8,1.5',
                'p:M4.6 17.4 9.8 12.6l3.4 3.2 2.6-2.3 3.6 3.3'],
        video: ['r:3.2,5.8,12.2,12.4,2.4', 'p:M15.4 11.2 20.8 7.9v8.2l-5.4-3.3z'],
        audio: ['p:M9.4 17.4V6.6l9.4-2.1v11', 'c:7.6,17.4,1.8', 'c:17,15.3,1.8'],
        file: ['p:M7 3.8h6.4L19 9.4v10.8H7z', 'p:M13.4 3.8v5.6H19'],
        window: ['r:3.4,4.6,17.2,14.8,2.6', 'l:3.4,9.2,20.6,9.2', 'fc:6.6,6.9,0.9', 'fc:9.4,6.9,0.9'],
        lock: ['r:5.4,10.4,13.2,9.4,2.4', 'p:M8.4 10.4V8a3.6 3.6 0 0 1 7.2 0v2.4'],
        check: ['p:M5 12.6 9.6 17.2 19 6.8'],
        dots: ['fc:6,12,1.4', 'fc:12,12,1.4', 'fc:18,12,1.4'],
        sort: ['l:4.6,7,19.4,7', 'l:7,12,17,12', 'l:10,17,14,17'],
        download: ['p:M12 3.8v11.4', 'p:M7.6 10.8 12 15.2l4.4-4.4', 'p:M4.6 19.6h14.8'],
        link: ['p:M10.2 13.8a3.6 3.6 0 0 0 5.1 0l3.2-3.2a3.6 3.6 0 0 0-5.1-5.1l-1.2 1.2',
               'p:M13.8 10.2a3.6 3.6 0 0 0-5.1 0l-3.2 3.2a3.6 3.6 0 0 0 5.1 5.1l1.2-1.2'],
        sparkle: ['p:M12 3.6l1.8 4.6 4.6 1.8-4.6 1.8L12 16.4l-1.8-4.6L5.6 10l4.6-1.8z',
                  'p:M18.6 15.4l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z']
    };

    function svgIcon(name, size) {
        const def = ICONS[name] || ICONS.sparkle;
        const px = size || 16;
        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('width', String(px));
        svg.setAttribute('height', String(px));
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '1.7');
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('stroke-linejoin', 'round');
        svg.setAttribute('aria-hidden', 'true');
        svg.dataset.iconName = name;

        for (const spec of def) {
            const idx = spec.indexOf(':');
            const kind = spec.slice(0, idx);
            const args = spec.slice(idx + 1);
            let node;
            switch (kind) {
                case 'p':
                case 'f':
                    node = document.createElementNS(SVG_NS, 'path');
                    node.setAttribute('d', args);
                    if (kind === 'f') {
                        node.setAttribute('fill', 'currentColor');
                        node.setAttribute('stroke', 'none');
                    }
                    break;
                case 'c':
                case 'fc': {
                    const [cx, cy, r] = args.split(',').map(Number);
                    node = document.createElementNS(SVG_NS, 'circle');
                    node.setAttribute('cx', String(cx));
                    node.setAttribute('cy', String(cy));
                    node.setAttribute('r', String(r));
                    if (kind === 'fc') {
                        node.setAttribute('fill', 'currentColor');
                        node.setAttribute('stroke', 'none');
                    }
                    break;
                }
                case 'r': {
                    const [x, y, w, hh, rx] = args.split(',').map(Number);
                    node = document.createElementNS(SVG_NS, 'rect');
                    node.setAttribute('x', String(x));
                    node.setAttribute('y', String(y));
                    node.setAttribute('width', String(w));
                    node.setAttribute('height', String(hh));
                    node.setAttribute('rx', String(rx || 0));
                    break;
                }
                case 'l': {
                    const [x1, y1, x2, y2] = args.split(',').map(Number);
                    node = document.createElementNS(SVG_NS, 'line');
                    node.setAttribute('x1', String(x1));
                    node.setAttribute('y1', String(y1));
                    node.setAttribute('x2', String(x2));
                    node.setAttribute('y2', String(y2));
                    break;
                }
                default:
                    continue;
            }
            svg.appendChild(node);
        }
        return svg;
    }

    /** Replace every `[data-icon]` placeholder inside `root` with real SVG. */
    function hydrateIcons(root) {
        qsa('[data-icon]', root || document).forEach(function (host) {
            if (host.dataset.iconDone === '1') return;
            const size = Number(host.dataset.iconSize || 0) || 16;
            host.insertBefore(svgIcon(host.dataset.icon, size), host.firstChild);
            host.dataset.iconDone = '1';
        });
    }

    /* ─────────────────────────── formatting ─────────────────────────── */

    function fmtBytes(bytes) {
        const n = Number(bytes);
        if (!n || n < 0) return '';
        if (n < 1024) return n + ' B';
        if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
        if (n < 1024 * 1024 * 1024) return (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';
        return (n / 1073741824).toFixed(1) + ' GB';
    }

    function timeAgo(ts) {
        if (!ts) return '';
        const diff = Date.now() - Number(ts);
        if (!isFinite(diff)) return '';
        const min = Math.floor(diff / 60000);
        if (min < 1) return 'just now';
        if (min < 60) return min + 'm ago';
        const hours = Math.floor(min / 60);
        if (hours < 24) return hours + 'h ago';
        const days = Math.floor(hours / 24);
        if (days < 30) return days + 'd ago';
        const months = Math.floor(days / 30);
        if (months < 12) return months + 'mo ago';
        return Math.floor(months / 12) + 'y ago';
    }

    function hostOf(url) {
        try {
            const u = new URL(url);
            if (u.protocol === 'file:') return 'local file';
            return u.host;
        } catch (e) { return ''; }
    }

    function originOf(url) {
        try {
            const u = new URL(url);
            if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
            return u.origin;
        } catch (e) { return ''; }
    }

    function pathOf(url) {
        try {
            const u = new URL(url);
            return (u.pathname || '/') + (u.search || '');
        } catch (e) { return url; }
    }

    function extOf(name) {
        const s = String(name || '');
        const i = s.lastIndexOf('.');
        return i > -1 ? s.slice(i + 1).toLowerCase() : '';
    }

    const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif', 'tif', 'tiff', 'heic', 'psd', 'ai', 'sketch', 'fig'];
    const VIDEO_EXT = ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v', 'wmv', 'flv', 'mpg', 'mpeg'];
    const AUDIO_EXT = ['mp3', 'wav', 'aac', 'flac', 'ogg', 'm4a', 'aiff', 'wma'];

    /**
     * Formats a browser can actually decode into pixels, and therefore the only
     * ones that can be put on the clipboard as *image data*. Design sources
     * (psd, ai, sketch, fig) and HEIC/TIFF are images to a human but opaque to a
     * web page, so they must travel as files instead.
     */
    const RASTER_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'ico', 'svg'];

    function rasterImage(ext) {
        return RASTER_EXT.indexOf(String(ext || '').toLowerCase()) > -1;
    }

    function kindOf(ext) {
        const e = String(ext || '').toLowerCase();
        if (IMAGE_EXT.indexOf(e) > -1) return 'image';
        if (VIDEO_EXT.indexOf(e) > -1) return 'video';
        if (AUDIO_EXT.indexOf(e) > -1) return 'audio';
        return 'doc';
    }

    function kindIcon(kind) {
        if (kind === 'image') return 'image';
        if (kind === 'video') return 'video';
        if (kind === 'audio') return 'audio';
        return 'file';
    }

    function fmtSub(item) {
        const bits = [];
        const kind = kindOf(item.ext);
        bits.push((item.ext || kind).toUpperCase());
        if (item.width && item.height && (kind === 'image' || kind === 'video')) bits.push(item.width + '×' + item.height);
        const size = fmtBytes(item.size);
        if (size) bits.push(size);
        return bits.join(' · ');
    }

    /** Turn omnibox text into a URL, falling back to a search query. */
    function normalizeUrl(input, searchTemplate) {
        const raw = String(input || '').trim();
        if (!raw) return '';
        if (/^(https?|file):\/\//i.test(raw)) return raw;
        // Never allow script-y or data URLs from the address bar.
        const cleaned = raw.replace(/^(javascript|data|vbscript):/i, '');
        if (/^localhost(:\d+)?(\/|$|\?)/i.test(cleaned)) return 'http://' + cleaned;
        if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$|\?)/.test(cleaned)) return 'http://' + cleaned;
        if (/^[\w-]+(\.[\w-]+)+(:\d+)?([/?#].*)?$/.test(cleaned) && !/\s/.test(cleaned)) return 'https://' + cleaned;
        const tpl = searchTemplate || 'https://duckduckgo.com/?q=%s';
        return tpl.replace('%s', encodeURIComponent(cleaned));
    }

    function faviconUrl(pageUrl) {
        const origin = originOf(pageUrl);
        return origin ? origin + '/favicon.ico' : '';
    }

    function letterOf(text) {
        const s = String(text || '?').replace(/^www\./, '').trim();
        return (s[0] || '?').toUpperCase();
    }

    /* ─────────────────────────── misc ─────────────────────────── */

    function debounce(fn, ms) {
        let timer = null;
        return function () {
            const args = arguments, self = this;
            clearTimeout(timer);
            timer = setTimeout(function () { fn.apply(self, args); }, ms);
        };
    }

    function uid() {
        return 'id' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
    }

    function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }

    function storageGet(key, fallback) {
        try {
            const raw = window.localStorage.getItem('perch.' + key);
            if (raw == null) return fallback;
            return JSON.parse(raw);
        } catch (e) { return fallback; }
    }

    function storageSet(key, value) {
        try { window.localStorage.setItem('perch.' + key, JSON.stringify(value)); }
        catch (e) { /* quota / disabled storage — not fatal */ }
    }

    /** Copy plain text without clobbering the Eagle clipboard API. */
    function copyPlainText(text) {
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
                return navigator.clipboard.writeText(String(text));
            }
        } catch (e) { /* fall through */ }
        return Promise.reject(new Error('clipboard unavailable'));
    }

    /* ─────────────────────────── toasts ─────────────────────────── */

    function toast(opts) {
        const o = typeof opts === 'string' ? { title: opts } : (opts || {});
        const host = el('toasts');
        if (!host) return null;

        const iconName = o.icon || (o.kind === 'error' ? 'shield' : o.kind === 'success' ? 'check' : 'sparkle');
        const node = h('div', { class: 'toast ' + (o.kind || 'info') }, [
            h('span', { class: 't-icon' }, [svgIcon(iconName, 17)]),
            h('div', { class: 't-body' }, [
                h('div', { class: 't-title', text: o.title || '' }),
                o.sub ? h('div', { class: 't-sub', text: o.sub }) : null
            ])
        ]);
        host.appendChild(node);

        const life = o.timeout || (o.kind === 'error' ? 6200 : 3600);
        const kill = function () {
            node.classList.add('out');
            setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 220);
        };
        node.addEventListener('click', kill);
        setTimeout(kill, life);
        return node;
    }

    /* ─────────────────────────── modal ─────────────────────────── */

    let modalCloser = null;

    function openModal(cfg) {
        const root = el('modalRoot');
        if (!root) return;
        clear(root);

        const body = h('div', { class: 'modal-body' });
        if (typeof cfg.body === 'function') cfg.body(body); else appendAll(body, cfg.body);

        const closeBtn = h('button', { class: 'icon-btn tiny', title: 'Close' }, [svgIcon('close', 14)]);
        closeBtn.addEventListener('click', closeModal);

        const card = h('div', { class: 'modal', role: 'dialog' }, [
            h('div', { class: 'modal-head' }, [h('h3', { text: cfg.title || '' }), closeBtn]),
            body,
            cfg.actions ? h('div', { class: 'modal-foot' }, cfg.actions) : null
        ]);

        root.appendChild(card);
        root.hidden = false;

        const onKey = function (e) { if (e.key === 'Escape') { e.stopPropagation(); closeModal(); } };
        const onBackdrop = function (e) { if (e.target === root) closeModal(); };
        document.addEventListener('keydown', onKey, true);
        root.addEventListener('mousedown', onBackdrop);

        modalCloser = function () {
            document.removeEventListener('keydown', onKey, true);
            root.removeEventListener('mousedown', onBackdrop);
            if (typeof cfg.onClose === 'function') cfg.onClose();
        };
        return card;
    }

    function closeModal() {
        const root = el('modalRoot');
        if (root) { root.hidden = true; clear(root); }
        if (modalCloser) { const fn = modalCloser; modalCloser = null; fn(); }
    }

    function isModalOpen() {
        const root = el('modalRoot');
        return !!root && !root.hidden;
    }

    P.util = {
        el: el, qs: qs, qsa: qsa, clear: clear, h: h, appendAll: appendAll,
        svgIcon: svgIcon, hydrateIcons: hydrateIcons, ICONS: ICONS,
        fmtBytes: fmtBytes, fmtSub: fmtSub, timeAgo: timeAgo,
        hostOf: hostOf, originOf: originOf, pathOf: pathOf, extOf: extOf,
        kindOf: kindOf, kindIcon: kindIcon, rasterImage: rasterImage,
        IMAGE_EXT: IMAGE_EXT, VIDEO_EXT: VIDEO_EXT, AUDIO_EXT: AUDIO_EXT, RASTER_EXT: RASTER_EXT,
        normalizeUrl: normalizeUrl, faviconUrl: faviconUrl, letterOf: letterOf,
        debounce: debounce, uid: uid, clamp: clamp,
        storageGet: storageGet, storageSet: storageSet, copyPlainText: copyPlainText,
        toast: toast, openModal: openModal, closeModal: closeModal, isModalOpen: isModalOpen
    };
})(window.Perch);
