/* ============================================================================
   Perch — engine.js
   The thing that actually renders web pages.

   Eagle plugin windows are Electron BrowserWindows, so a <webview> tag may be
   available — that gives a real browser (any site, real titles, popups as
   tabs). When it is not enabled we fall back to a cross-origin <iframe>, which
   browsers refuse to fill for sites that send X-Frame-Options / frame-ancestors.

   Both paths are wrapped behind one small adapter so the rest of the app never
   cares which engine is live.
   ========================================================================== */
window.Perch = window.Perch || {};

(function (P) {
    'use strict';

    const u = P.util;
    let kind = 'iframe';
    let requested = 'auto';
    let spoofUserAgent = true;
    let sessionMode = 'perch';

    // Warnings and errors the loaded page itself logged. This is the only window
    // we get into a remote page's own failures (Gemini's frontend erroring while
    // it processes an attachment, for instance), so it is worth keeping.
    const GUEST_CONSOLE = [];

    function rememberConsole(level, message, source) {
        GUEST_CONSOLE.push({
            level: level,
            message: String(message || '').slice(0, 400),
            source: String(source || '').slice(0, 120)
        });
        if (GUEST_CONSOLE.length > 40) GUEST_CONSOLE.shift();
    }

    /** Is the Electron <webview> custom element actually registered? */
    function probeWebview() {
        try {
            const probe = document.createElement('webview');
            const ok = typeof probe.loadURL === 'function' &&
                       typeof probe.getURL === 'function' &&
                       typeof probe.stop === 'function';
            return ok ? 'yes' : 'no';
        } catch (e) { return 'no'; }
    }

    /**
     * Decide which engine to use.
     * pref: 'auto' | 'webview' | 'iframe'
     * options.spoofUserAgent: present as Chrome (default) or leave the Electron UA
     * options.sessionPartition: 'perch' (persistent, default) or 'default' (inherit)
     */
    function init(pref, options) {
        const opts = options || {};
        if (typeof opts.spoofUserAgent === 'boolean') spoofUserAgent = opts.spoofUserAgent;
        if (opts.sessionPartition === 'perch' || opts.sessionPartition === 'default') sessionMode = opts.sessionPartition;

        requested = pref || 'auto';
        const available = probeWebview() === 'yes';
        const wanted = requested === 'webview' || (requested === 'auto' && available);
        kind = (wanted && available) ? 'webview' : 'iframe';
        return kind;
    }

    /** What was asked for versus what was granted — a silent downgrade is a bug. */
    function engineReport() {
        return {
            requested: requested,
            granted: kind,
            webviewAvailable: probeWebview() === 'yes',
            downgraded: requested === 'webview' && kind !== 'webview'
        };
    }

    function describe() {
        if (kind === 'webview') {
            return {
                kind: 'webview',
                limited: false,
                label: 'webview',
                note: 'Full browser engine — every site loads, including ones that block embedding.'
            };
        }
        return {
            kind: 'iframe',
            limited: true,
            label: 'iframe · limited',
            note: 'Eagle does not expose the webview engine to plugins, so Perch renders pages in a ' +
                  'cross-origin frame. Sites that forbid embedding (Google, Gemini, GitHub, banks) cannot be ' +
                  'shown, and a framed site is a third party, so its cookies are blocked and a consent banner ' +
                  'can never stick. This is a limit of the host, not a setting.'
        };
    }

    /* ═══════════════════════ webview adapter ═══════════════════════ */

    /**
     * Product tokens that identify a real browser. Anything else in the UA
     * (Electron/32.1.0, Eagle/4.0.0, Perch/1.0.0 …) marks us as an embedded
     * automation-ish browser, which is what makes Google, Cloudflare and
     * friends hand out "verify you are not a robot" pages.
     */
    const UA_PRODUCTS = /^(Mozilla|AppleWebKit|KHTML|Gecko|Chrome|Chromium|Safari|Version|Mobile|Edg|EdgA|OPR|CriOS|FxiOS|like)\//;

    function browserUserAgent() {
        const raw = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
        if (!raw) return '';
        const cleaned = raw.split(' ')
            .filter(function (token) {
                // Bare words and version numbers (e.g. "(KHTML," / "like" / "Gecko)") are kept.
                if (!/^[A-Za-z][\w.-]*\/[\w.\-]+$/.test(token)) return true;
                return UA_PRODUCTS.test(token);
            })
            .join(' ')
            .replace(/\s{2,}/g, ' ')
            .trim();
        return cleaned.length > 20 ? cleaned : raw;
    }

    /**
     * Read-only probe run inside the loaded page. It answers the one question a
     * cookie-consent loop turns on: can this page actually store a cookie?
     * It writes a single throwaway first-party cookie named perch_probe, reads it
     * back, deletes it, and does the same with one localStorage key. Nothing else
     * is read and nothing is transmitted.
     */
    const PROBE_SCRIPT = '(function () {' +
        'var out = { url: location.href, secure: location.protocol === "https:" };' +
        'try { out.cookieEnabled = !!navigator.cookieEnabled; } catch (e) { out.cookieEnabled = null; }' +
        'try { out.cookieCount = document.cookie ? document.cookie.split(";").filter(function (c) { return c.trim(); }).length : 0; } catch (e) { out.cookieCount = null; }' +
        'try {' +
        '  document.cookie = "perch_probe=1; path=/; max-age=60; SameSite=Lax";' +
        '  out.canWriteCookie = /(^|;\\s*)perch_probe=1/.test(document.cookie);' +
        '  document.cookie = "perch_probe=; path=/; max-age=0; SameSite=Lax";' +
        '} catch (e) { out.canWriteCookie = false; }' +
        'try {' +
        '  window.localStorage.setItem("perch_probe", "1");' +
        '  out.localStorage = window.localStorage.getItem("perch_probe") === "1";' +
        '  window.localStorage.removeItem("perch_probe");' +
        '} catch (e) { out.localStorage = false; }' +
        'try { out.thirdPartyFrame = (window.top !== window.self); } catch (e) { out.thirdPartyFrame = true; }' +
        'return out;' +
        '})()';

    function webviewAdapter(handlers) {
        const el = document.createElement('webview');
        el.setAttribute('allowpopups', '');

        // A persistent, named session. Inheriting the host window's session is not
        // enough: if Eagle gives plugin windows an in-memory partition, every
        // consent or sign-in cookie is dropped and sites loop their cookie banner
        // forever ("accept" → banner again). An explicit `persist:` jar is the
        // cheapest cure, and the setting exists in case a host refuses to create it.
        if (sessionMode === 'perch') el.setAttribute('partition', 'persist:perch');

        // The user agent is the one thing worth overriding: an Electron UA is what
        // makes Google, Cloudflare and friends serve bot-check pages. It is a
        // toggle rather than a hard-coded decision, because spoofing is not free —
        // the UA string and the Sec-CH-UA client hints then disagree, and a site
        // that cross-checks them can be harder on us, not easier.
        if (spoofUserAgent) {
            const ua = browserUserAgent();
            if (ua) el.setAttribute('useragent', ua);
        }
        el.setAttribute('src', 'about:blank');
        el.style.width = '100%';
        el.style.height = '100%';
        el.style.display = 'flex';

        let lastUrl = '';

        el.addEventListener('did-start-loading', function () { handlers.onLoadStart && handlers.onLoadStart(); });
        el.addEventListener('did-stop-loading', function () { handlers.onLoadStop && handlers.onLoadStop(); });
        el.addEventListener('dom-ready', function () { handlers.onReady && handlers.onReady(); });

        el.addEventListener('did-navigate', function (e) {
            lastUrl = e.url || lastUrl;
            handlers.onNav && handlers.onNav(e.url, { isMainFrame: true, inPage: false });
        });
        el.addEventListener('did-navigate-in-page', function (e) {
            if (e.isMainFrame === false) return;
            lastUrl = e.url || lastUrl;
            handlers.onNav && handlers.onNav(e.url, { isMainFrame: true, inPage: true });
        });
        el.addEventListener('page-title-updated', function (e) {
            handlers.onTitle && handlers.onTitle(e.title || '');
        });
        el.addEventListener('did-fail-load', function (e) {
            // -3 is ABORTED, which fires on every user-stopped or replaced load.
            if (e.errorCode === -3) return;
            // Subframe failures (ads, trackers, blocked embeds) are constant on
            // the modern web and must never take over the whole pane.
            if (e.isMainFrame === false) return;
            handlers.onFail && handlers.onFail({
                code: e.errorCode,
                description: e.errorDescription || 'Load failed',
                url: e.validatedURL || lastUrl,
                isMainFrame: e.isMainFrame
            });
        });
        el.addEventListener('new-window', function (e) {
            // Only swallow the popup when the caller can actually host it;
            // window.open('') flows write into the popup's own document.
            const handled = handlers.onPopup ? handlers.onPopup(e.url, e) : false;
            if (handled && typeof e.preventDefault === 'function') e.preventDefault();
        });
        el.addEventListener('console-message', function (e) {
            rememberConsole(e.level, e.message, (e.sourceId || '') + ':' + e.line);
            if (e.level >= 2) P.Eagle.log('page console [' + (e.level === 3 ? 'error' : 'warn') + '] ' + String(e.message || '').slice(0, 200));
        });
        el.addEventListener('render-process-gone', function () {
            handlers.onFail && handlers.onFail({ code: 0, description: 'The page stopped responding', url: lastUrl, isMainFrame: true });
        });

        return {
            el: el,
            kind: 'webview',
            navigate: function (url) {
                try {
                    el.loadURL(url);
                } catch (err) {
                    // loadURL rejects early if the guest is not ready yet.
                    el.setAttribute('src', url);
                }
            },
            reload: function () { try { el.reload(); } catch (e) { /* not ready */ } },
            reloadIgnoringCache: function () { try { el.reloadIgnoringCache(); } catch (e) { try { el.reload(); } catch (e2) { /* ignore */ } } },
            stop: function () { try { el.stop(); } catch (e) { /* ignore */ } },
            /** Run the cookie/storage probe inside the guest (webview only). */
            probe: async function () {
                try {
                    if (typeof el.executeJavaScript !== 'function') return null;
                    return await el.executeJavaScript(PROBE_SCRIPT, false);
                } catch (err) {
                    P.Eagle.log('page probe failed', err && err.message);
                    return null;
                }
            },
            currentUrl: function () { try { return el.getURL() || lastUrl; } catch (e) { return lastUrl; } },
            destroy: function () {
                try { el.stop(); } catch (e) { /* ignore */ }
                if (el.parentNode) el.parentNode.removeChild(el);
            }
        };
    }

    /* ═══════════════════════ iframe adapter ═══════════════════════ */

    function iframeAdapter(handlers) {
        const el = document.createElement('iframe');
        el.setAttribute('referrerpolicy', 'no-referrer-when-downgrade');
        el.setAttribute('allow', 'clipboard-read; clipboard-write; fullscreen; autoplay; encrypted-media');
        el.style.width = '100%';
        el.style.height = '100%';
        el.style.border = '0';

        let requested = '';
        let probeToken = 0;

        el.addEventListener('load', function () {
            const token = ++probeToken;
            if (!requested) return;
            probeFrame(token, 0);
        });

        /**
         * A frame that simply has not committed yet looks exactly like a frame
         * that was refused: both present an about:blank document we are allowed
         * to read. So probe repeatedly and only report a refusal once the frame
         * has had a fair chance to produce a real (cross-origin) document.
         */
        function probeFrame(token, attempt) {
            setTimeout(function () {
                if (token !== probeToken || !requested) return;

                if (!looksBlocked(el, requested)) {
                    handlers.onNav && handlers.onNav(readableUrl(el) || requested, { isMainFrame: true, inPage: false });
                    handlers.onLoadStop && handlers.onLoadStop();
                    return;
                }
                if (attempt < 3) { probeFrame(token, attempt + 1); return; }

                handlers.onBlocked && handlers.onBlocked(requested);
                handlers.onLoadStop && handlers.onLoadStop();
            }, attempt === 0 ? 80 : 260);
        }

        return {
            el: el,
            kind: 'iframe',
            navigate: function (url) {
                requested = url;
                probeToken++;                 // abandon any probe for the previous URL
                handlers.onLoadStart && handlers.onLoadStart();
                el.setAttribute('src', url);
            },
            reload: function () { if (requested) { el.setAttribute('src', 'about:blank'); el.setAttribute('src', requested); } },
            reloadIgnoringCache: function () { this.reload(); },
            stop: function () { /* iframes cannot be stopped once committed */ },
            currentUrl: function () { return readableUrl(el) || requested; },
            destroy: function () { if (el.parentNode) el.parentNode.removeChild(el); }
        };
    }

    /**
     * Heuristic: a cross-origin frame that loaded for real has a null
     * contentDocument, while a frame refused by X-Frame-Options commits an
     * error page we can still read (about:blank / empty).
     */
    function looksBlocked(frame, requestedUrl) {
        let sameOriginOurs = false;
        try { sameOriginOurs = u.originOf(requestedUrl) === location.origin; } catch (e) { sameOriginOurs = false; }
        if (sameOriginOurs) return false;

        try {
            const doc = frame.contentDocument;
            if (doc === null) return false;          // real cross-origin document
            if (!doc) return true;
            const href = doc.URL || '';
            if (!href || href === 'about:blank') return true;
            if (!doc.body || (!doc.body.childNodes.length && !doc.body.textContent)) return true;
            return false;
        } catch (e) {
            return false;                            // access threw => cross-origin => loaded
        }
    }

    function readableUrl(frame) {
        try {
            const href = frame.contentWindow && frame.contentWindow.location && frame.contentWindow.location.href;
            if (href && href !== 'about:blank') return href;
        } catch (e) { /* cross-origin — expected */ }
        return '';
    }

    /** Create a per-tab adapter. */
    function createAdapter(handlers) {
        return kind === 'webview' ? webviewAdapter(handlers) : iframeAdapter(handlers);
    }

    P.Engine = {
        probeWebview: probeWebview,
        engineReport: engineReport,
        init: init,
        describe: describe,
        createAdapter: createAdapter,
        browserUserAgent: browserUserAgent,
        guestConsole: function (n) { return GUEST_CONSOLE.slice(-(n || 10)); },
        get kind() { return kind; },
        get isWebview() { return kind === 'webview'; },
        get spoofingUserAgent() { return spoofUserAgent; },
        get sessionPartition() { return sessionMode; }
    };
})(window.Perch);
