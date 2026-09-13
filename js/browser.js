/* ============================================================================
   Perch — browser.js
   Tabs, omnibox, per-tab history, start page, quick links, and the two
   Eagle round-trips (save the page as a bookmark, capture the view as an image).

   History is owned here rather than in the engine adapter, so the address bar
   behaves identically whether we are on <webview> or <iframe>.
   ========================================================================== */
window.Perch = window.Perch || {};

(function (P) {
    'use strict';

    const u = P.util;
    const E = P.Eagle;

    const SEARCH_ENGINES = {
        duckduckgo: { name: 'DuckDuckGo', tpl: 'https://duckduckgo.com/?q=%s' },
        google: { name: 'Google', tpl: 'https://www.google.com/search?q=%s' },
        bing: { name: 'Bing', tpl: 'https://www.bing.com/search?q=%s' },
        brave: { name: 'Brave', tpl: 'https://search.brave.com/search?q=%s' },
        ecosia: { name: 'Ecosia', tpl: 'https://www.ecosia.org/search?q=%s' },
        startpage: { name: 'Startpage', tpl: 'https://www.startpage.com/sp/search?query=%s' }
    };

    const DEFAULT_LINKS = [
        { name: 'Gmail', url: 'https://mail.google.com/' },
        { name: 'Drive', url: 'https://drive.google.com/' },
        { name: 'Notion', url: 'https://www.notion.so/' },
        { name: 'Figma', url: 'https://www.figma.com/files' },
        { name: 'Slack', url: 'https://app.slack.com/client' },
        { name: 'GitHub', url: 'https://github.com/' },
        { name: 'YouTube', url: 'https://www.youtube.com/' },
        { name: 'ChatGPT', url: 'https://chatgpt.com/' }
    ];

    const state = {
        tabs: [],
        activeId: null,
        seq: 0,
        links: [],
        recent: []
    };

    let els = {};

    const settings = function () {
        return (P.App && P.App.settings) || { search: 'duckduckgo', home: '', engine: 'auto' };
    };
    const searchTemplate = function () {
        const engine = SEARCH_ENGINES[settings().search] || SEARCH_ENGINES.duckduckgo;
        return engine.tpl;
    };

    /* ═══════════════════════════ boot ═══════════════════════════ */

    function init() {
        els = {
            app: u.el('app'),
            tabs: u.el('tabs'),
            views: u.el('viewHost'),
            stage: u.el('stage'),
            startPage: u.el('startPage'),
            blocked: u.el('blockedOverlay'),            blockedText: u.el('blockedText'),
            blockedNote: u.el('blockedNote'),
            blockedExternal: u.el('btnBlockedExternal'),
            blockedRetry: u.el('btnBlockedRetry'),
            blockedRebuild: u.el('btnBlockedRebuild'),
            notice: u.el('loadNotice'),
            noticeText: u.el('loadNoticeText'),
            noticeExternal: u.el('btnNoticeExternal'),
            noticeReload: u.el('btnNoticeReload'),
            noticeClose: u.el('btnNoticeClose'),
            address: u.el('addressInput'),
            omni: u.el('omni'),
            omniLock: u.el('omniLock'),
            back: u.el('btnBack'),
            forward: u.el('btnForward'),
            reload: u.el('btnReload'),
            home: u.el('btnHome'),
            go: u.el('btnOmniGo'),
            progress: u.el('progressBar'),
            newTab: u.el('btnNewTab'),
            quickBtn: u.el('btnQuickLinks'),
            quickMenu: u.el('quickMenu'),
            savePage: u.el('btnSaveToEagle'),
            capture: u.el('btnCapture'),
            openExternal: u.el('btnOpenExternal'),
            enginePill: u.el('enginePill'),
            startSearch: u.el('startSearch'),
            startForm: u.el('startForm'),
            quickTiles: u.el('quickTiles'),
            recentList: u.el('recentList'),
            clearRecent: u.el('btnClearRecent'),
            startTip: u.el('startTip'),
            startGreeting: u.el('startGreeting')
        };

        state.links = u.storageGet('links', DEFAULT_LINKS);
        state.recent = u.storageGet('recent', []);

        bindToolbar();
        bindStartPage();
        updateEnginePill();
        bindStartTip();
        renderQuickLinks();
        renderRecent();

        restoreSession();
        if (!state.tabs.length) createTab('', { focus: false });
        renderTabs();
        updateChrome();
    }

    /* ═══════════════════════════ tabs ═══════════════════════════ */

    function activeTab() {
        return state.tabs.filter(function (t) { return t.id === state.activeId; })[0] || null;
    }

    function createTab(url, opts) {
        const options = opts || {};
        const id = 'tab-' + (++state.seq);

        const view = u.h('div', { class: 'view', dataset: { tab: id } });
        const tab = {
            id: id,
            url: '',
            title: 'New tab',
            loading: false,
            blank: true,
            blocked: false,
            hasLoaded: false,
            loadWatch: null,
            notice: '',
            challenge: false,
            stack: [],
            hindex: -1,
            suppressPush: false,
            view: view,
            adapter: null
        };
        tab.adapter = P.Engine.createAdapter(handlersFor(tab));
        view.appendChild(tab.adapter.el);
        els.views.appendChild(view);
        state.tabs.push(tab);

        if (options.activate !== false) activateTab(id);
        renderTabs();

        if (url) navigate(url, tab);
        else if (options.focus !== false) setTimeout(focusAddress, 40);

        saveSession();
        return tab;
    }

    function closeTab(id) {
        const index = state.tabs.findIndex(function (t) { return t.id === id; });
        if (index < 0) return;

        const tab = state.tabs[index];
        try { tab.adapter.destroy(); } catch (e) { /* ignore */ }
        if (tab.view.parentNode) tab.view.parentNode.removeChild(tab.view);
        state.tabs.splice(index, 1);

        if (state.activeId === id) {
            const next = state.tabs[index] || state.tabs[index - 1];
            if (next) activateTab(next.id);
            else createTab('', { focus: false });
        }
        renderTabs();
        updateChrome();
        saveSession();
    }

    function activateTab(id) {
        state.activeId = id;
        renderTabs();
        syncActiveView();
        updateChrome();
        saveSession();
    }

    function cycleTab(delta) {
        if (state.tabs.length < 2) return;
        const index = state.tabs.findIndex(function (t) { return t.id === state.activeId; });
        const next = (index + delta + state.tabs.length) % state.tabs.length;
        activateTab(state.tabs[next].id);
    }

    function activateTabByIndex(n) {
        if (n >= state.tabs.length) return;
        activateTab(state.tabs[n].id);
    }

    function handlersFor(tab) {
        return {
            onLoadStart: function () {
                tab.loading = true;
                startLoadWatch(tab);
                refreshTab(tab);
            },
            onLoadStop: function () {
                tab.loading = false;
                clearLoadWatch(tab);
                refreshTab(tab);
            },
            onNav: function (url, info) {
                if (!url) return;
                if (info && info.inPage) {
                    const current = tab.stack[tab.hindex];
                    if (current) current.url = url;
                    tab.url = url;
                } else if (tab.suppressPush) {
                    tab.suppressPush = false;
                    const current = tab.stack[tab.hindex];
                    if (current) current.url = url;
                    tab.url = url;
                } else {
                    pushHistory(tab, url);
                }
                tab.blocked = false;
                tab.notice = '';
                tab.challenge = false;
                tab.hasLoaded = true;
                detectBotChallenge(tab, tab.title, url);
                recordRecent(url, tab.title);
                refreshTab(tab);
            },
            onTitle: function (title) {
                if (!title) return;
                tab.title = title;
                if (detectBotChallenge(tab, title, tab.url)) { /* notice set below */ }
                recordRecent(tab.url, title);
                refreshTab(tab);
                renderRecent();
            },
            onReady: function () { },
            onFail: function (info) {
                tab.loading = false;
                clearLoadWatch(tab);
                handleLoadFailure(tab, info);
                refreshTab(tab);
            },
            onBlocked: function (url) {
                tab.loading = false;
                showBlocked(tab, 'frame', { url: url });
                refreshTab(tab);
            },
            onPopup: function (url) {
                const usable = !!url && /^https?:/i.test(url);
                const mode = (P.App && P.App.settings && P.App.settings.popupMode) || 'window';

                if (!usable) {
                    E.log('pop-up with no hostable URL, left to Electron:', url || '(empty)');
                    return false;
                }

                // Consent screens and sign-in flows report back to the page that
                // opened them. Hosting them in a new tab severs that link, and a
                // webview pop-up window does not reliably give them an opener
                // either — both leave the page waiting and re-opening the same
                // dialog forever. Completing the flow in the current tab is the
                // route that actually finishes, so it is offered explicitly.
                if (mode === 'same') {
                    navigate(url, activeTab());
                    u.toast({ title: 'Opened in this tab', sub: 'Pop-ups are set to load in the current tab.', kind: 'info', timeout: 3500 });
                    return true;
                }
                if (mode === 'tab') {
                    createTab(url, { activate: true });
                    return true;
                }

                E.log('pop-up left as a real window:', url);
                u.toast({
                    title: 'The site opened a pop-up window',
                    sub: 'If this dialog keeps repeating, switch Pop-up windows to “Same tab”.',
                    kind: 'info',
                    icon: 'window',
                    timeout: 5000
                });
                return false;   // do not preventDefault
            }
        };
    }

    /**
     * Cloudflare (and friends) fingerprint the browser, not the visitor: an
     * embedded Electron webview fails the check no matter how many times the
     * box is ticked, and a spoofed user agent can make it worse because the UA
     * string then disagrees with the browser's own Sec-CH-UA hints — a plugin
     * cannot change those. So when a challenge page appears, say what it is and
     * offer the only route that works, instead of letting the user tick the box
     * forever.
     */
    const CHALLENGE_TITLE = /just a moment|please wait a moment|verifying you are human|verify you are human|attention required|checking your browser|enable javascript and cookies|ddos protection/i;
    const CHALLENGE_URL = /\/cdn-cgi\/(challenge|lm)\b/i;

    function detectBotChallenge(tab, title, url) {
        if (P.Engine.kind !== 'webview') return false;
        if (!CHALLENGE_TITLE.test(title || '') && !CHALLENGE_URL.test(url || '')) return false;

        tab.challenge = true;
        tab.blocked = false;
        tab.notice = u.hostOf(url || tab.url) + ' is running a browser check (Cloudflare). Embedded browsers usually ' +
                     'cannot pass it, and ticking the box will loop. Open the page in your normal browser — the ' +
                     'button on the right — and paste your Eagle file there with Ctrl/⌘ + V.';
        E.log('bot challenge detected on', url || tab.url, '—', title);
        return true;
    }

    /** Schemes that belong to a native app, not to a web view. */    const EXTERNAL_SCHEME = /^(mailto|tel|sms|callto|webcal|feed|magnet|slack|zoommtg|spotify|msteams|ms-outlook|outlook|discord|steam|intent|market|itms-apps|whatsapp|vscode|figma|notion|obsidian|linear|shortcuts|bitwarden|1password|protonmail):/i;

    function sameUrl(a, b) {
        const strip = function (value) {
            return String(value || '').replace(/[#?].*$/, '').replace(/\/+$/, '').toLowerCase();
        };
        return strip(a) === strip(b);
    }

    /**
     * A failed load must never blank the pane.
     *
     * On the webview engine Chromium has already drawn its own error page inside
     * the guest, and covering that with a full-screen card is how "many sites
     * don't work" happens: one failed subresource request, an external app
     * scheme, or a redirect the guest later recovers from would hide a page that
     * was fine. So: route external schemes to the OS, and report everything else
     * in a non-blocking strip.
     */
    function handleLoadFailure(tab, info) {
        const url = (info && info.url) || tab.url || '';
        const description = (info && info.description) || 'Load failed';

        // Defensive: isMainFrame is not reported by every Electron build.
        if (info && info.isMainFrame === undefined && tab.url && url && !sameUrl(url, tab.url)) {
            E.log('ignoring failure reported for a different URL:', url);
            return;
        }

        if (EXTERNAL_SCHEME.test(url)) {
            E.log('handing external scheme to the OS:', url);
            E.shell.openExternal(url);
            tab.notice = '';
            u.toast({
                title: 'Opened in your default app',
                sub: url.split(':')[0] + ': link',
                kind: 'info',
                icon: 'external'
            });
            return;
        }

        if (P.Engine.isWebview) {
            tab.blocked = false;                      // keep the pane on screen
            tab.notice = 'Could not load ' + (u.hostOf(url) || url) + ' — ' + description;
            return;
        }

        showBlocked(tab, 'fail', info);
    }

    /** Cheap per-tab refresh: tab strip entry, chrome and history list. */
    function refreshTab(tab) {
        updateTabNode(tab);
        if (tab.id === state.activeId) {
            syncActiveView();
            updateChrome();
        }
        saveSession();
    }

    function tabLabel(tab) {
        return (tab.title && tab.title !== 'New tab') ? tab.title : (u.hostOf(tab.url) || 'New tab');
    }

    /** Update one tab in place instead of rebuilding the whole strip. */
    function updateTabNode(tab) {
        const node = u.qs('.tab[data-tab="' + tab.id + '"]', els.tabs);
        if (!node) { renderTabs(); return; }

        const label = tabLabel(tab);
        node.classList.toggle('active', tab.id === state.activeId);
        node.title = label;
        const titleEl = node.querySelector('.tab-title');
        if (titleEl) titleEl.textContent = label;

        const current = node.querySelector('.tab-fav, .tab-spinner');
        const wanted = tab.loading
            ? 'spinner'
            : (u.faviconUrl(tab.url) || 'letter:' + u.letterOf(label));
        const have = !current
            ? ''
            : current.classList.contains('tab-spinner')
                ? 'spinner'
                : current.tagName === 'IMG' ? current.getAttribute('src') : 'letter:' + current.textContent;

        if (current && have !== wanted) {
            current.parentNode.replaceChild(faviconNode(tab), current);
        } else if (!current) {
            node.insertBefore(faviconNode(tab), node.firstChild);
        }
    }

    function pushHistory(tab, url) {
        tab.stack = tab.stack.slice(0, tab.hindex + 1);
        tab.stack.push({ url: url });
        tab.hindex = tab.stack.length - 1;
        if (tab.stack.length > 120) { tab.stack.shift(); tab.hindex--; }
        tab.url = url;
    }

    /** Navigate without pushing: used by back/forward, which move the pointer. */
    function goTo(tab, url) {
        tab.blank = false;
        tab.blocked = false;
        tab.notice = '';
        tab.url = url;
        tab.suppressPush = true;
        revealIfActive(tab);          // visible before the engine loads, as above
        setAddressValue(url);
        startLoadWatch(tab);
        try {
            tab.adapter.navigate(url);
        } catch (err) {
            E.log('goTo failed', err && err.message);
            tab.loading = false;
        }
        refreshTab(tab);
    }

    /* ═══════════════════════════ navigation ═══════════════════════════ */

    function navigate(input, targetTab) {
        const tab = targetTab || activeTab();
        if (!tab) return;
        const raw = String(input == null ? '' : input).trim();
        if (!raw || raw === 'start' || raw === 'about:blank') { showStartPage(tab); return; }

        const url = u.normalizeUrl(raw, searchTemplate());
        if (!url) return;

        tab.blank = false;
        tab.blocked = false;
        tab.notice = '';
        tab.loading = true;
        pushHistory(tab, url);
        tab.suppressPush = true;

        // Show the pane BEFORE the engine navigates. A <webview> guest that is
        // still display:none when loadURL arrives may never attach, which shows
        // up as "the browser stopped displaying pages".
        revealIfActive(tab);
        setAddressValue(url);
        startLoadWatch(tab);

        try {
            tab.adapter.navigate(url);
        } catch (err) {
            E.log('navigate failed', err && err.message);
            u.toast({ title: 'Could not load that address', sub: (err && err.message) || '', kind: 'error' });
            tab.loading = false;
        }

        recordRecent(url, '');
        refreshTab(tab);
    }

    /** Resolve the visibility rule for one tab without rebuilding the strip. */
    function revealIfActive(tab) {
        if (tab.id !== state.activeId) return;
        syncActiveView();
    }

    /**
     * The address bar must show where we actually went, even though the input
     * still holds focus right after the user pressed Enter. Chrome-style.
     */
    function setAddressValue(url) {
        if (els.address) els.address.value = url || '';
    }

    /**
     * A load that never reports completion must not leave the chrome spinning
     * forever — give up on the indicator after a while.
     */
    function startLoadWatch(tab) {
        clearLoadWatch(tab);
        tab.loadWatch = setTimeout(function () {
            tab.loadWatch = null;
            if (!tab.loading) return;
            E.log('load watchdog fired for', tab.url);
            tab.loading = false;
            refreshTab(tab);
        }, 30000);
    }

    function clearLoadWatch(tab) {
        if (tab.loadWatch) { clearTimeout(tab.loadWatch); tab.loadWatch = null; }
    }

    function showStartPage(tab) {
        tab.blank = true;
        tab.blocked = false;
        tab.notice = '';
        tab.url = '';
        tab.title = 'New tab';
        refreshTab(tab);
        focusAddress();
    }

    function goBack(tab) {
        const t = tab || activeTab();
        if (!t || t.hindex <= 0) return;
        t.hindex--;
        goTo(t, t.stack[t.hindex].url);
    }

    function goForward(tab) {
        const t = tab || activeTab();
        if (!t || t.hindex >= t.stack.length - 1) return;
        t.hindex++;
        goTo(t, t.stack[t.hindex].url);
    }

    function reload(hard) {
        const tab = activeTab();
        if (!tab || tab.blank) return;
        tab.blocked = false;
        if (hard) tab.adapter.reloadIgnoringCache(); else tab.adapter.reload();
        refreshTab(tab);
    }

    function stop() {
        const tab = activeTab();
        if (!tab) return;
        tab.adapter.stop();
        tab.loading = false;
        refreshTab(tab);
    }

    function home() {
        const tab = activeTab();
        if (!tab) return;
        const configured = settings().home;
        if (configured) navigate(configured, tab);
        else showStartPage(tab);
    }

    function focusAddress() {
        if (!els.address) return;
        els.address.focus();
        els.address.select();
    }

    function focusContent() {
        const tab = activeTab();
        if (!tab || tab.blank) return;
        try { tab.adapter.el.focus(); } catch (e) { /* ignore */ }
    }

    function currentUrl() {
        const tab = activeTab();
        return (tab && !tab.blank && tab.url) || '';
    }

    function currentTitle() {
        const tab = activeTab();
        return (tab && tab.title) || '';
    }

    function openExternal(url) {
        const target = url || currentUrl();
        if (!target) return;
        E.shell.openExternal(target);
    }

    /* ═══════════════════════════ chrome ═══════════════════════════ */

    function setIcon(host, name, size) {
        if (!host) return;
        u.clear(host);
        host.appendChild(u.svgIcon(name, size || 16));
        host.dataset.iconDone = '1';
    }

    function securityFor(url) {
        if (!url) return { icon: 'globe', cls: '' };
        if (/^https:/i.test(url)) return { icon: 'lock', cls: 'security-good' };
        if (/^http:/i.test(url)) return { icon: 'globe', cls: 'security-bad' };
        return { icon: 'file', cls: '' };
    }

    function renderTabs() {
        u.clear(els.tabs);
        state.tabs.forEach(function (tab) { els.tabs.appendChild(buildTab(tab)); });
    }

    function buildTab(tab) {
        const active = tab.id === state.activeId;
        const label = tabLabel(tab);

        const close = u.h('button', { class: 'tab-close', title: 'Close tab' }, [u.svgIcon('close', 11)]);
        close.addEventListener('click', function (e) { e.stopPropagation(); closeTab(tab.id); });

        const node = u.h('div', {
            class: 'tab' + (active ? ' active' : ''),
            dataset: { tab: tab.id },
            attrs: { role: 'tab', title: label },
            style: { width: Math.max(132, Math.min(230, 250 - state.tabs.length * 6)) + 'px' }
        }, [faviconNode(tab), u.h('span', { class: 'tab-title', text: label }), close]);

        node.addEventListener('click', function () { activateTab(tab.id); });
        node.addEventListener('auxclick', function (e) { if (e.button === 1) { e.preventDefault(); closeTab(tab.id); } });
        return node;
    }

    function faviconNode(tab) {
        const letter = u.letterOf(tab.title && tab.title !== 'New tab' ? tab.title : (u.hostOf(tab.url) || '?'));
        if (tab.loading) return u.h('span', { class: 'tab-spinner' });

        const src = u.faviconUrl(tab.url);
        if (!src) return u.h('span', { class: 'tab-fav letter', text: letter });

        const img = u.h('img', { class: 'tab-fav', attrs: { src: src, alt: '' } });
        img.addEventListener('error', function () {
            const span = u.h('span', { class: 'tab-fav letter', text: letter });
            if (img.parentNode) img.parentNode.replaceChild(span, img);
        });
        return img;
    }

    function syncActiveView() {
        state.tabs.forEach(function (tab) {
            const visible = tab.id === state.activeId && !tab.blank && !tab.blocked;
            const was = tab.view.classList.contains('active');
            tab.view.classList.toggle('active', visible);
            if (visible && !was) onViewRevealed(tab);
        });
    }

    /**
     * Called when a tab's pane becomes visible again. A <webview> guest that was
     * taken out of the layout can come back with no rendered surface, or with
     * its document dropped entirely — both look like "the browser stopped
     * showing pages". Nudge the layout, and reload the guest if it lost its
     * document while it was hidden.
     */
    function onViewRevealed(tab) {
        if (P.Engine.kind !== 'webview' || !tab.adapter) return;

        // Deliberately no size fiddling here: nudging the guest's box to force a
        // re-layout is exactly the kind of thing that leaves a guest painted at
        // the wrong offset. The reveal-before-load ordering and the self-heal
        // below are enough, and Rebuild view is the manual escape hatch.
        const el = tab.adapter.el;
        if (!tab.hasLoaded || !tab.url) return;
        try {
            const current = typeof el.getURL === 'function' ? el.getURL() : '';
            if (!current || current === 'about:blank') {
                E.log('guest lost its document while hidden — reloading', tab.url);
                try { el.loadURL(tab.url); } catch (e) { el.setAttribute('src', tab.url); }
                tab.loading = true;
                startLoadWatch(tab);
            }
        } catch (e) { /* getURL can throw before the guest attaches */ }
    }

    /**
     * Throw away this tab's rendering surface and build a fresh one, on the
     * current engine. The escape hatch when a guest is wedged.
     */
    function recreateTab(tab) {
        const target = tab || activeTab();
        if (!target) return;

        const url = target.url;
        const title = target.title;
        const stack = target.stack.slice();
        const hindex = target.hindex;

        try { target.adapter.destroy(); } catch (e) { /* ignore */ }
        if (target.view.parentNode) target.view.parentNode.removeChild(target.view);

        const view = u.h('div', { class: 'view', dataset: { tab: target.id } });
        target.adapter = P.Engine.createAdapter(handlersFor(target));
        view.appendChild(target.adapter.el);
        target.view = view;
        els.views.appendChild(view);

        target.stack = stack;
        target.hindex = hindex;
        target.hasLoaded = false;
        target.loading = false;
        target.blocked = false;
        target.blank = !url;
        target.suppressPush = true;

        if (url) {
            revealIfActive(target);       // visible first, then load
            startLoadWatch(target);
            try { target.adapter.navigate(url); } catch (e) { target.loading = false; }
        }
        if (title) target.title = title;

        refreshTab(target);
        u.toast({ title: 'View rebuilt', sub: url || 'Blank tab', kind: 'info', icon: 'window' });
    }

    function updateChrome() {
        const tab = activeTab();

        if (els.address && document.activeElement !== els.address) {
            els.address.value = tab && !tab.blank ? (tab.url || '') : '';
        }

        els.back.disabled = !(tab && tab.hindex > 0);
        els.forward.disabled = !(tab && tab.hindex < tab.stack.length - 1);

        const sec = securityFor(tab && !tab.blank ? tab.url : '');
        els.omni.classList.toggle('security-good', sec.cls === 'security-good');
        els.omni.classList.toggle('security-bad', sec.cls === 'security-bad');
        setIcon(els.omniLock, sec.icon, 14);

        els.progress.hidden = !(tab && tab.loading);
        setIcon(els.reload, tab && tab.loading ? 'close' : 'reload', 16);

        if (els.notice) {
            els.notice.hidden = !(tab && tab.notice);
            if (tab && tab.notice) els.noticeText.textContent = tab.notice;
        }

        els.startPage.hidden = !(tab && tab.blank);
        els.blocked.hidden = !(tab && tab.blocked);
        els.savePage.disabled = !(tab && !tab.blank && tab.url);
        els.capture.disabled = !(tab && !tab.blank);
        els.openExternal.disabled = !(tab && !tab.blank && tab.url);

        if (tab && tab.blank) renderRecent();
        syncActiveView();
    }

    function updateEnginePill() {
        const info = P.Engine.describe();
        const report = P.Engine.engineReport();
        if (!els.enginePill) return;
        els.enginePill.textContent = info.label;
        els.enginePill.dataset.engine = info.kind;
        els.enginePill.title = info.note +
            (report.webviewAvailable ? '\n\nwebview engine is available.' : '\n\nwebview engine is NOT available in this Eagle build (webviewTag is off), so no plugin can use it.') +
            '\n\nClick for settings.';
    }

    /* ═══════════════════════════ blocked / failed ═══════════════════════════ */

    function showBlocked(tab, kind, detail) {
        tab.blocked = true;
        tab.loading = false;
        tab.suppressPush = false;
        clearLoadWatch(tab);

        const host = u.hostOf((detail && detail.url) || tab.url) || 'This site';
        if (els.blockedText) {
            els.blockedText.textContent = kind === 'frame'
                ? host + ' sends X-Frame-Options or a frame-ancestors policy, which forbids being shown inside another application.'
                : 'Could not load ' + host + (detail && detail.description ? ' — ' + detail.description : '') + '.';
        }
        if (els.blockedNote) {
            els.blockedNote.textContent = kind === 'frame' && !P.Engine.isWebview
                ? 'Perch is using the fallback iframe engine. Open Settings → Browser engine, or use your normal browser for this site.'
                : '';
        }
        updateChrome();
    }

    /* ═══════════════════════════ quick links ═══════════════════════════ */

    function saveLinks() { u.storageSet('links', state.links); }

    function renderQuickLinks() {
        if (!els.quickTiles) return;
        u.clear(els.quickTiles);

        state.links.forEach(function (link) {
            const tile = u.h('button', { class: 'tile', title: link.url }, [
                faviconBox(link), u.h('span', { class: 'tile-name', text: link.name })
            ]);
            tile.addEventListener('click', function (e) {
                if (e.ctrlKey || e.metaKey) createTab(link.url, { activate: true });
                else navigate(link.url, activeTab());
            });
            tile.addEventListener('contextmenu', function (e) {
                e.preventDefault();
                state.links = state.links.filter(function (l) { return l.name !== link.name || l.url !== link.url; });
                saveLinks();
                renderQuickLinks();
                u.toast({ title: 'Removed ' + link.name, kind: 'info' });
            });
            els.quickTiles.appendChild(tile);
        });

        const add = u.h('button', { class: 'tile tile-add', title: 'Manage quick links' }, [
            u.h('span', { class: 'tile-fav', style: { background: 'var(--surface-3)', color: 'var(--text-dim)' } }, [u.svgIcon('plus', 15)]),
            u.h('span', { class: 'tile-name', text: 'Add' })
        ]);
        add.addEventListener('click', openQuickLinksManager);
        els.quickTiles.appendChild(add);
    }

    function faviconBox(link) {
        const letter = u.letterOf(link.name);
        const box = u.h('span', { class: 'tile-fav', text: letter });
        const src = u.faviconUrl(link.url);
        if (!src) return box;
        const img = u.h('img', { class: 'tile-fav', attrs: { src: src, alt: '' } });
        img.addEventListener('error', function () {
            if (img.parentNode) img.parentNode.replaceChild(box, img);
        });
        return img;
    }

    function openQuickLinksManager() {
        const body = function (host) {
            const list = u.h('div', { class: 'recent' });
            const paint = function () {
                u.clear(list);
                if (!state.links.length) list.appendChild(u.h('div', { class: 'help', text: 'No quick links yet.' }));
                state.links.forEach(function (link, i) {
                    const row = u.h('div', { class: 'recent-item' }, [
                        u.h('span', { class: 'r-title', text: link.name }),
                        u.h('span', { class: 'r-url', text: link.url }),
                        u.h('button', { class: 'icon-btn tiny', title: 'Remove' }, [u.svgIcon('trash', 13)])
                    ]);
                    row.querySelector('button').addEventListener('click', function () {
                        state.links.splice(i, 1);
                        saveLinks(); paint(); renderQuickLinks();
                    });
                    list.appendChild(row);
                });
            };
            paint();

            const nameInput = u.h('input', { class: 'input', attrs: { placeholder: 'Name' } });
            const urlInput = u.h('input', { class: 'input', attrs: { placeholder: 'https://…' } });
            const addBtn = u.h('button', { class: 'accent-btn', text: 'Add' });
            addBtn.addEventListener('click', function () {
                const name = nameInput.value.trim();
                const url = u.normalizeUrl(urlInput.value.trim(), searchTemplate());
                if (!name || !url) { u.toast({ title: 'Name and URL are both required', kind: 'warn' }); return; }
                state.links.push({ name: name, url: url });
                saveLinks(); nameInput.value = ''; urlInput.value = ''; paint(); renderQuickLinks();
            });

            host.appendChild(u.h('div', { class: 'field' }, [u.h('label', { text: 'Quick links' }), list]));
            host.appendChild(u.h('div', { class: 'field' }, [
                u.h('label', { text: 'Add a link' }),
                u.h('div', { style: { display: 'flex', gap: '6px' } }, [nameInput, urlInput, addBtn])
            ]));
        };

        u.openModal({ title: 'Quick links', body: body });
    }

    function toggleQuickMenu(force) {
        const menu = els.quickMenu;
        const show = force != null ? force : menu.hidden;
        if (!show) { menu.hidden = true; return; }

        u.clear(menu);
        menu.appendChild(u.h('div', { class: 'menu-title', text: 'Quick links' }));
        state.links.forEach(function (link) {
            const item = u.h('button', { class: 'menu-item' }, [
                u.h('span', { class: 'mi-label', text: link.name }),
                u.h('span', { class: 'mi-sub', text: u.hostOf(link.url) })
            ]);
            item.addEventListener('click', function () { menu.hidden = true; navigate(link.url, activeTab()); });
            menu.appendChild(item);
        });

        menu.appendChild(u.h('div', { class: 'menu-sep' }));
        const addCurrent = u.h('button', { class: 'menu-item' }, [u.h('span', { class: 'mi-label', text: 'Add current page' })]);
        addCurrent.disabled = !currentUrl();
        addCurrent.addEventListener('click', function () {
            menu.hidden = true;
            const url = currentUrl();
            if (!url) return;
            const name = currentTitle() || u.hostOf(url);
            state.links.push({ name: name.slice(0, 32), url: url });
            saveLinks(); renderQuickLinks();
            u.toast({ title: 'Added “' + name.slice(0, 32) + '” to quick links', kind: 'success', icon: 'star' });
        });
        const manage = u.h('button', { class: 'menu-item' }, [u.h('span', { class: 'mi-label', text: 'Manage quick links…' })]);
        manage.addEventListener('click', function () { menu.hidden = true; openQuickLinksManager(); });

        menu.appendChild(addCurrent);
        menu.appendChild(manage);
        menu.hidden = false;
    }

    /* ═══════════════════════════ recent ═══════════════════════════ */

    function recordRecent(url, title) {
        if (!url || !/^https?:/i.test(url)) return;
        const existing = state.recent.filter(function (r) { return r.url === url; })[0];
        if (existing) {
            if (title) existing.title = title;
            existing.ts = Date.now();
        } else {
            state.recent.unshift({ url: url, title: title || '', ts: Date.now() });
        }
        state.recent.sort(function (a, b) { return b.ts - a.ts; });
        state.recent = state.recent.slice(0, 60);
        u.storageSet('recent', state.recent);
    }

    function renderRecent() {
        if (!els.recentList) return;
        u.clear(els.recentList);
        const items = state.recent.slice(0, 7);
        if (!items.length) {
            els.recentList.appendChild(u.h('div', { class: 'help', text: 'Pages you visit will show up here.' }));
            return;
        }
        items.forEach(function (entry) {
            const row = u.h('button', { class: 'recent-item' }, [
                u.svgIcon('globe', 14),
                u.h('span', { class: 'r-title', text: entry.title || u.hostOf(entry.url) }),
                u.h('span', { class: 'r-url', text: u.pathOf(entry.url) })
            ]);
            row.addEventListener('click', function () { navigate(entry.url, activeTab()); });
            els.recentList.appendChild(row);
        });
    }

    /* ═══════════════════════════ session ═══════════════════════════ */

    const saveSession = u.debounce(function () {
        u.storageSet('session', {
            tabs: state.tabs.map(function (t) { return t.url; }),
            active: state.tabs.findIndex(function (t) { return t.id === state.activeId; })
        });
    }, 400);

    function restoreSession() {
        const saved = u.storageGet('session', null);
        if (!saved || !Array.isArray(saved.tabs) || !saved.tabs.length) return;
        const urls = saved.tabs.filter(function (url) { return /^https?:/i.test(url || ''); });
        if (!urls.length) return;

        urls.forEach(function (url, i) {
            const tab = createTab('', { activate: false, focus: false });
            if (url) navigate(url, tab);
            if (i === (saved.active || 0)) state.activeId = tab.id;
        });
        if (!activeTab()) state.activeId = state.tabs[0].id;
    }

    /* ═══════════════════════════ binding ═══════════════════════════ */

    function bindToolbar() {
        els.back.addEventListener('click', function () { goBack(); });
        els.forward.addEventListener('click', function () { goForward(); });
        els.reload.addEventListener('click', function (e) {
            const tab = activeTab();
            if (tab && tab.loading) stop(); else reload(e.shiftKey);
        });
        els.home.addEventListener('click', home);
        els.newTab.addEventListener('click', function () { createTab('', { activate: true }); });
        els.go.addEventListener('click', function () { navigate(els.address.value, activeTab()); });
        els.savePage.addEventListener('click', savePageToEagle);
        els.capture.addEventListener('click', captureToEagle);
        els.openExternal.addEventListener('click', function () { openExternal(currentUrl()); });

        els.address.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                navigate(els.address.value, activeTab());
                focusContent();
            } else if (e.key === 'Escape') {
                els.address.value = currentUrl();
                els.address.blur();
            }
        });
        els.address.addEventListener('focus', function () { els.address.select(); });

        els.quickBtn.addEventListener('click', function (e) { e.stopPropagation(); toggleQuickMenu(); });
        document.addEventListener('click', function (e) {
            if (els.quickMenu.hidden) return;
            if (els.quickMenu.contains(e.target) || els.quickBtn.contains(e.target)) return;
            els.quickMenu.hidden = true;
        });

        els.blockedExternal.addEventListener('click', function () { openExternal(activeTab() && activeTab().url); });
        els.blockedRetry.addEventListener('click', function () { reload(true); });
        els.blockedRebuild.addEventListener('click', function () { recreateTab(activeTab()); });

        els.noticeExternal.addEventListener('click', function () { openExternal(activeTab() && activeTab().url); });
        els.noticeReload.addEventListener('click', function () {
            const tab = activeTab();
            if (tab) { tab.notice = ''; }
            reload(true);
        });
        els.noticeClose.addEventListener('click', function () {
            const tab = activeTab();
            if (tab) tab.notice = '';
            updateChrome();
        });
    }

    function bindStartPage() {
        els.startForm.addEventListener('submit', function (e) {
            e.preventDefault();
            const value = els.startSearch.value.trim();
            if (!value) return;
            navigate(value, activeTab());
            focusContent();
        });
        els.startSearch.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') els.startSearch.blur();
        });
        els.clearRecent.addEventListener('click', function () {
            state.recent = [];
            u.storageSet('recent', []);
            renderRecent();
            u.toast({ title: 'Recent pages cleared', kind: 'success', icon: 'trash' });
        });
    }

    function bindStartTip() {
        const engine = P.Engine.describe();
        u.clear(els.startTip);
        els.startTip.appendChild(u.h('span', { text: 'Tip: ' }));
        els.startTip.appendChild(u.h('kbd', { text: 'Ctrl/⌘ B' }));
        els.startTip.appendChild(u.h('span', { text: ' toggles the Eagle library, ' }));
        els.startTip.appendChild(u.h('kbd', { text: 'Ctrl/⌘ ⇧ A' }));
        els.startTip.appendChild(u.h('span', { text: ' toggles the attachment shelf, and files on the shelf can be dragged straight into the page. ' }));
        els.startTip.appendChild(u.h('span', { text: 'Engine: ' + engine.label + '. ' + engine.note }));

        const hour = new Date().getHours();
        els.startGreeting.textContent = hour < 5 ? 'Still up?' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    }

    /* ═══════════════════════════ Eagle round-trips ═══════════════════════════ */

    function contentRect() {
        const r = els.stage.getBoundingClientRect();
        return {
            x: Math.round(r.left),
            y: Math.round(r.top),
            width: Math.max(1, Math.round(r.width)),
            height: Math.max(1, Math.round(r.height))
        };
    }

    async function screenshotDataUrl(quality) {
        const image = await E.win.capturePage(contentRect());
        if (!image) return '';
        try {
            if (typeof image.toJPEG === 'function') {
                const buf = image.toJPEG(quality || 82);
                if (buf && buf.length && typeof Buffer !== 'undefined') {
                    return 'data:image/jpeg;base64,' + buf.toString('base64');
                }
            }
            if (typeof image.toDataURL === 'function') return image.toDataURL();
        } catch (err) {
            E.log('capture failed', err && err.message);
        }
        return '';
    }

    function folderOptions() {
        const folders = (P.Library && P.Library.folders()) || [];
        const active = (P.Library && P.Library.activeFolder()) || '';
        return { folders: folders, active: active };
    }

    function folderSelect(host, selectedId) {
        const info = folderOptions();
        const select = u.h('select', { class: 'select' });
        select.appendChild(u.h('option', { attrs: { value: '' }, text: 'No folder' }));
        info.folders.forEach(function (folder) {
            select.appendChild(u.h('option', { attrs: { value: folder.id }, text: folder.name }));
        });
        select.value = selectedId || info.active || '';
        host.appendChild(select);
        return select;
    }

    function savePageToEagle() {
        const tab = activeTab();
        const url = currentUrl();
        if (!tab || !url) {
            u.toast({ title: 'Nothing to save', sub: 'Open a website first.', kind: 'warn' });
            return;
        }

        const collect = { fn: null };

        const body = function (host) {
            const nameInput = u.h('input', { class: 'input', attrs: { value: currentTitle() || u.hostOf(url) } });
            const tagsInput = u.h('input', { class: 'input', attrs: { placeholder: 'design, inspiration' } });
            const folderField = u.h('div');

            host.appendChild(u.h('div', { class: 'field' }, [
                u.h('label', { text: 'Bookmark name' }), nameInput
            ]));
            host.appendChild(u.h('div', { class: 'field' }, [
                u.h('label', { text: 'Tags (comma separated)' }), tagsInput
            ]));
            host.appendChild(u.h('div', { class: 'field' }, [u.h('label', { text: 'Folder in Eagle' }), folderField]));
            const select = folderSelect(folderField, '');
            host.appendChild(u.h('div', { class: 'help' }, [
                u.h('span', { text: 'URL: ' }),
                u.h('span', { text: url, style: { fontFamily: 'var(--mono)', wordBreak: 'break-all' } })
            ]));
            host.appendChild(u.h('div', { class: 'help', text: 'A screenshot of the page view becomes the bookmark thumbnail.' }));

            collect.fn = function () {
                return {
                    name: nameInput.value.trim() || u.hostOf(url),
                    tags: tagsInput.value.split(',').map(function (s) { return s.trim(); }).filter(Boolean),
                    folders: select.value ? [select.value] : []
                };
            };
        };

        const saveBtn = u.h('button', { class: 'accent-btn' }, [u.svgIcon('bookmark', 14), u.h('span', { text: 'Save to Eagle' })]);
        saveBtn.addEventListener('click', async function () {
            const data = collect.fn ? collect.fn() : { name: currentTitle(), tags: [], folders: [] };
            u.closeModal();

            u.toast({ title: 'Saving to Eagle…', kind: 'info' });
            const base64 = await screenshotDataUrl(80);
            const itemId = await E.item.addBookmark(url, {
                name: data.name,
                base64: base64 || undefined,
                tags: data.tags,
                folders: data.folders,
                annotation: 'Saved from Perch'
            });
            if (itemId) {
                u.toast({ title: 'Saved to Eagle', sub: data.name, kind: 'success', icon: 'bookmark' });
                if (P.Library) P.Library.refresh();
            } else {
                u.toast({ title: 'Eagle did not accept the bookmark', sub: E.available ? 'Check the Eagle log.' : 'Eagle API not available.', kind: 'error' });
            }
        });

        u.openModal({
            title: 'Save page to Eagle',
            body: body,
            actions: [saveBtn]
        });
    }

    async function captureToEagle() {
        const tab = activeTab();
        if (!tab || tab.blank) {
            u.toast({ title: 'Nothing to capture', kind: 'warn' });
            return;
        }
        u.toast({ title: 'Capturing the view…', kind: 'info' });
        const dataUrl = await screenshotDataUrl(90);
        if (!dataUrl) {
            u.toast({ title: 'Capture failed', sub: 'Eagle did not return a screenshot.', kind: 'error' });
            return;
        }
        const info = folderOptions();
        const itemId = await E.item.addFromBase64(dataUrl, {
            name: (currentTitle() || u.hostOf(currentUrl()) || 'Capture') + ' — ' + new Date().toLocaleDateString(),
            website: currentUrl(),
            folders: info.active ? [info.active] : [],
            tags: ['Perch capture'],
            annotation: 'Captured in Perch'
        });
        if (itemId) {
            u.toast({ title: 'Captured into Eagle', kind: 'success', icon: 'camera' });
            if (P.Library) P.Library.refresh();
        } else {
            u.toast({ title: 'Eagle did not accept the capture', kind: 'error' });
        }
    }

    /* ═══════════════════════════ engine switching ═══════════════════════════ */

    /** Re-create every tab on the newly selected engine, preserving URLs. */
    function rebuildForEngine() {
        const snapshot = state.tabs.map(function (t) { return { url: t.url, title: t.title }; });
        const activeIndex = Math.max(0, state.tabs.findIndex(function (t) { return t.id === state.activeId; }));

        state.tabs.slice().forEach(function (tab) {
            try { tab.adapter.destroy(); } catch (e) { /* ignore */ }
            if (tab.view.parentNode) tab.view.parentNode.removeChild(tab.view);
        });
        state.tabs = [];
        state.activeId = null;

        snapshot.forEach(function (entry, i) {
            const tab = createTab('', { activate: false, focus: false });
            if (entry.url) navigate(entry.url, tab);
            if (i === activeIndex) state.activeId = tab.id;
        });
        if (!state.tabs.length) createTab('', { focus: false });
        if (!activeTab()) state.activeId = state.tabs[0].id;

        updateEnginePill();
        bindStartTip();
        renderTabs();
        updateChrome();
        u.toast({ title: 'Browser engine: ' + P.Engine.describe().label, sub: 'Tabs were reloaded.', kind: 'info' });
    }

    /**
     * Ask the loaded page whether it can actually store cookies and use
     * localStorage. This is what settles a cookie-consent loop: if a page cannot
     * write a first-party cookie, no amount of clicking Accept will stick.
     */
    async function probePage() {
        const tab = activeTab();
        if (!tab || tab.blank || !tab.adapter) return null;

        if (typeof tab.adapter.probe !== 'function') {
            // The iframe engine cannot script a cross-origin frame, but the shape
            // of the problem is knowable anyway: the page runs as a third-party
            // frame, so the browser refuses its cookies and a consent banner can
            // never stick — which is exactly the loop being reported.
            return {
                engine: 'iframe',
                pageOrigin: u.originOf(tab.url) || 'unknown',
                perchOrigin: location.origin,
                thirdPartyFrame: true,
                canWriteCookie: false,
                verdict: 'The page runs as a third-party frame inside Perch, so the browser refuses its cookies. ' +
                         'A consent banner cannot stick, and any site needing a signed-in session cannot work here. ' +
                         'Use the Open-in-browser button instead.'
            };
        }

        const result = await tab.adapter.probe();
        if (!result) return { engine: 'webview', note: 'the page did not answer the probe' };
        result.engine = 'webview';
        result.verdict = result.canWriteCookie === false
            ? 'This page cannot store a first-party cookie, so Accept can never stick — storage is denied below Perch.'
            : result.canWriteCookie === true
                ? 'Cookies work here. If a banner still repeats, it is the site’s own consent/pop-up logic.'
                : 'Inconclusive.';
        return result;
    }

    P.Browser = {
        init: init,
        SEARCH_ENGINES: SEARCH_ENGINES,
        createTab: function () { return createTab('', { activate: true }); },
        closeActiveTab: function () { if (state.activeId) closeTab(state.activeId); },
        closeTab: closeTab,
        activateTabByIndex: activateTabByIndex,
        cycleTab: cycleTab,
        focusAddress: focusAddress,
        focusContent: focusContent,
        navigate: function (url) { navigate(url, activeTab()); },
        goBack: goBack,
        goForward: goForward,
        reload: reload,
        stop: stop,
        isLoading: function () { const tab = activeTab(); return !!(tab && tab.loading); },
        home: home,
        currentUrl: currentUrl,
        currentTitle: currentTitle,
        openExternal: openExternal,
        savePageToEagle: savePageToEagle,
        captureToEagle: captureToEagle,
        probePage: probePage,
        updateEnginePill: updateEnginePill,
        rebuildForEngine: rebuildForEngine,
        recreateTab: recreateTab,
        recreateAllTabs: function () { state.tabs.slice().forEach(function (tab) { recreateTab(tab); }); },
        tabCount: function () { return state.tabs.length; }
    };
})(window.Perch);
