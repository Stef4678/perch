/* ============================================================================
   Perch — library.js
   The Eagle library panel: folder tree, kind filters, search, thumbnail grid
   and the multi-select that feeds the attachment shelf.

   Paging strategy: for the unfiltered view we page through
   item.getIdsWithModifiedAt() (Eagle's fast listing API) and only fetch full
   records for the slice we render, so a 100k-item library stays responsive.
   ========================================================================== */
window.Perch = window.Perch || {};

(function (P) {
    'use strict';

    const u = P.util;
    const E = P.Eagle;

    const PAGE_SIZE = 60;
    const KIND_LABEL = { image: 'image', video: 'video', audio: 'audio', doc: 'file' };

    const state = {
        folders: [],
        collapsed: {},          // folderId -> true when collapsed
        activeFolder: '',
        query: '',
        kind: 'all',
        items: [],              // items currently rendered
        loaded: [],             // everything fetched for the active query
        checked: {},
        cursor: 0,              // index into the recent-id list
        recentIds: null,
        exhausted: false,
        loading: false,
        total: 0,
        lastClicked: -1
    };

    let els = {};

    /* ─────────────────────────── boot ─────────────────────────── */

    function init() {
        els = {
            search: u.el('libSearch'),
            searchClear: u.el('btnLibSearchClear'),
            filters: u.el('libFilters'),
            folders: u.el('libFolderList'),
            grid: u.el('libGrid'),
            more: u.el('libMore'),
            moreBtn: u.el('btnLibMore'),
            empty: u.el('libEmpty'),
            status: u.el('libStatus'),
            grab: u.el('btnGrabSelection'),
            addChecked: u.el('btnAddChecked'),
            checkedCount: u.el('checkedCount'),
            refresh: u.el('btnLibRefresh'),
            scroll: u.el('libScroll')
        };

        els.search.addEventListener('input', u.debounce(function () {
            state.query = els.search.value.trim();
            resetAndRefresh();
        }, 320));
        els.search.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') { els.search.value = ''; state.query = ''; resetAndRefresh(); }
        });
        els.searchClear.addEventListener('click', function () {
            els.search.value = ''; state.query = ''; resetAndRefresh(); els.search.focus();
        });

        els.filters.addEventListener('click', function (e) {
            const btn = e.target.closest('.chip-filter');
            if (!btn) return;
            u.qsa('.chip-filter', els.filters).forEach(function (b) { b.classList.toggle('active', b === btn); });
            state.kind = btn.dataset.kind || 'all';
            resetAndRefresh();
        });

        els.refresh.addEventListener('click', function () { loadFolders(); resetAndRefresh(); });
        els.moreBtn.addEventListener('click', function () { loadMore(); });
        els.grab.addEventListener('click', grabEagleSelection);
        els.addChecked.addEventListener('click', addCheckedToShelf);

        E.onLibraryChanged(function () { loadFolders(); resetAndRefresh(); });
        E.onThemeChanged(function () { /* colours are CSS-driven */ });

        if (!E.available) {
            els.status.textContent = 'Demo mode — Eagle API not detected';
        }

        loadFolders();
        resetAndRefresh();
    }

    /* ─────────────────────────── folders ─────────────────────────── */

    async function loadFolders() {
        const list = await E.folder.getAll();
        state.folders = list;
        renderFolders();
    }

    function folderColor(name) {
        const map = {
            red: '#ff6b6b', orange: '#ffa94d', yellow: '#ffd43b', green: '#51cf66',
            aqua: '#22d3ee', blue: '#4dabf7', purple: '#9775fa', pink: '#f783ac'
        };
        return map[String(name || '').toLowerCase()] || 'var(--text-faint)';
    }

    function renderFolders() {
        u.clear(els.folders);

        const all = u.h('button', { class: 'folder-node' + (state.activeFolder === '' ? ' active' : '') }, [
            u.h('span', { class: 'chev' }),
            u.h('span', { class: 'fdot', style: { background: 'linear-gradient(135deg,#8b5cf6,#22d3ee)' } }),
            u.h('span', { class: 'fname', text: 'All items' })
        ]);
        all.addEventListener('click', function () { state.activeFolder = ''; resetAndRefresh(); });
        els.folders.appendChild(all);

        const byParent = {};
        state.folders.forEach(function (f) {
            const key = f.parent || '__root__';
            (byParent[key] = byParent[key] || []).push(f);
        });
        Object.keys(byParent).forEach(function (k) {
            byParent[k].sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
        });

        (function walk(parentKey, depth) {
            (byParent[parentKey] || []).forEach(function (folder) {
                const kids = byParent[folder.id] || [];
                const collapsed = !!state.collapsed[folder.id];

                const chev = u.h('span', { class: 'chev' + (kids.length && !collapsed ? ' open' : '') }, [
                    kids.length ? u.svgIcon('chevronRight', 13) : null
                ]);

                const node = u.h('button', {
                    class: 'folder-node' + (state.activeFolder === folder.id ? ' active' : ''),
                    style: { paddingLeft: (7 + depth * 13) + 'px' }
                }, [
                    chev,
                    u.h('span', { class: 'fdot', style: { background: folderColor(folder.iconColor) } }),
                    u.h('span', { class: 'fname', text: folder.name })
                ]);

                chev.addEventListener('click', function (e) {
                    if (!kids.length) return;
                    e.stopPropagation();
                    state.collapsed[folder.id] = !state.collapsed[folder.id];
                    renderFolders();
                });
                node.addEventListener('click', function () {
                    state.activeFolder = folder.id;
                    resetAndRefresh();
                    renderFolders();
                });

                els.folders.appendChild(node);
                if (kids.length && !collapsed) walk(folder.id, depth + 1);
            });
        })('__root__', 0);
    }

    /* ─────────────────────────── query + paging ─────────────────────────── */

    function resetAndRefresh() {
        state.items = [];
        state.loaded = [];
        state.cursor = 0;
        state.recentIds = null;
        state.exhausted = false;
        state.lastClicked = -1;
        u.clear(els.grid);
        refresh();
    }

    function matchesFilters(item) {
        if (!item) return false;
        if (state.kind === 'all' || state.kind === 'selected') return true;
        return u.kindOf(item.ext) === state.kind;
    }

    function sortByModified(list) {
        return list.slice().sort(function (a, b) { return (b.modifiedAt || 0) - (a.modifiedAt || 0); });
    }

    async function getRecentIds() {
        if (state.recentIds) return state.recentIds;
        const rows = await E.item.getIdsWithModifiedAt();
        state.recentIds = rows
            .filter(function (r) { return r && r.id; })
            .sort(function (a, b) { return (b.modifiedAt || 0) - (a.modifiedAt || 0); });
        return state.recentIds;
    }

    /** True when we can use the fast "most recent first" listing path. */
    function usesRecentPath() {
        return !state.activeFolder && !state.query && state.kind !== 'selected';
    }

    async function fetchViaRecent() {
        const ids = await getRecentIds();
        const collected = [];
        const CHUNK = 90;

        while (collected.length < PAGE_SIZE && state.cursor < ids.length) {
            const slice = ids.slice(state.cursor, state.cursor + CHUNK);
            state.cursor += CHUNK;
            const rows = await E.item.getByIds(slice.map(function (r) { return r.id; }));
            const byId = {};
            rows.forEach(function (it) { if (it) byId[it.id] = it; });
            for (const rec of slice) {
                const item = byId[rec.id];
                if (item && matchesFilters(item)) collected.push(item);
                if (collected.length >= PAGE_SIZE) break;
            }
        }

        state.exhausted = state.cursor >= ids.length;
        return { items: collected, total: ids.length };
    }

    async function fetchViaQuery() {
        const options = {};
        if (state.activeFolder) options.folders = [state.activeFolder];
        if (state.query) options.keywords = [state.query];
        if (state.kind === 'selected') options.isSelected = true;

        const rows = await E.item.get(options);
        const filtered = sortByModified(rows.filter(matchesFilters));
        const already = state.items.length;
        const slice = filtered.slice(already, already + PAGE_SIZE);
        state.exhausted = already + slice.length >= filtered.length;
        return { items: slice, total: filtered.length };
    }

    async function refresh() {
        if (state.loading) return;
        state.loading = true;
        setStatus('Loading…');

        try {
            const result = usesRecentPath() ? await fetchViaRecent() : await fetchViaQuery();
            state.items = state.items.concat(result.items);
            state.loaded = state.items;
            state.total = result.total;
            render();
        } catch (err) {
            E.log('library refresh failed', err && err.message);
            setStatus('Could not read the library');
            u.clear(els.grid);
            els.empty.hidden = false;
            u.clear(els.empty).appendChild(u.h('div', {}, [
                u.h('strong', { text: 'Eagle library unavailable' }),
                u.h('span', { text: 'Open Perch from inside Eagle to browse your items.' })
            ]));
        } finally {
            state.loading = false;
        }
    }

    function loadMore() {
        if (state.exhausted || state.loading) return;
        refresh();
    }

    /* ─────────────────────────── rendering ─────────────────────────── */

    function thumbSource(item) {
        if (item.thumbnailURL) return item.thumbnailURL;
        if (u.kindOf(item.ext) === 'image' && item.fileURL) return item.fileURL;
        return '';
    }

    function buildCard(item) {
        const kind = u.kindOf(item.ext);
        const checked = !!state.checked[item.id];
        const shelfed = P.Shelf && P.Shelf.has(item.id);

        const thumb = u.h('div', { class: 'thumb' });
        const src = thumbSource(item);
        if (src) {
            const img = u.h('img', { attrs: { src: src, loading: 'lazy', alt: '' } });
            img.addEventListener('error', function () {
                u.clear(thumb).appendChild(u.svgIcon(u.kindIcon(kind), 22));
            });
            thumb.appendChild(img);
        } else {
            thumb.appendChild(u.svgIcon(u.kindIcon(kind), 22));
        }

        const addBtn = u.h('button', { class: 'add', title: 'Add to the attachment shelf' }, [u.svgIcon('plus', 13)]);
        addBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            P.Shelf.add([item]);
            syncCardState(item.id);
        });

        const card = u.h('div', {
            class: 'lib-card' + (checked ? ' checked' : '') + (shelfed ? ' on-shelf' : ''),
            attrs: { draggable: 'true', tabindex: '0' },
            dataset: { id: item.id }
        }, [
            thumb,
            u.h('span', { class: 'kind', text: KIND_LABEL[kind] || kind }),
            addBtn,
            u.h('div', { class: 'meta' }, [u.h('div', { class: 'name', text: item.name })])
        ]);
        card.title = item.name + '\n' + u.fmtSub(item) + '\nDrag into the page, or click + to shelve it.';

        card.addEventListener('click', function (e) {
            const index = state.items.findIndex(function (it) { return it.id === item.id; });
            if (e.shiftKey && state.lastClicked > -1) {
                const from = Math.min(state.lastClicked, index), to = Math.max(state.lastClicked, index);
                for (let i = from; i <= to; i++) state.checked[state.items[i].id] = true;
            } else {
                state.checked[item.id] = !state.checked[item.id];
                state.lastClicked = index;
            }
            syncAllCardStates();
        });

        card.addEventListener('dblclick', function () {
            P.Shelf.add([item]);
            syncAllCardStates();
        });

        card.addEventListener('dragstart', function () {
            if (!state.checked[item.id]) {
                state.checked = {};
                state.checked[item.id] = true;
                syncAllCardStates();
            }
            const picked = checkedItems();
            card.classList.add('dragging');
            dragItems(picked.length ? picked : [item], card);
        });
        card.addEventListener('dragend', function () { card.classList.remove('dragging'); });

        card.addEventListener('contextmenu', function (e) {
            e.preventDefault();
            const targets = state.checked[item.id] ? checkedItems() : [item];
            P.Actions.menuFor(targets, card);
        });

        return card;
    }

    function syncCardState(id) {
        const card = u.qs('.lib-card[data-id="' + cssEscape(id) + '"]', els.grid);
        if (!card) return;
        const isChecked = !!state.checked[id];
        card.classList.toggle('checked', isChecked);
        card.classList.toggle('on-shelf', !!(P.Shelf && P.Shelf.has(id)));
    }

    function syncAllCardStates() {
        state.items.forEach(function (it) { syncCardState(it.id); });
        updateCheckedCount();
    }

    function cssEscape(value) {
        return String(value).replace(/["\\]/g, '\\$&');
    }

    function render() {
        u.clear(els.grid);

        // Re-render everything loaded so far; a few hundred small cards is cheap.
        state.items.forEach(function (item) { els.grid.appendChild(buildCard(item)); });

        const empty = state.items.length === 0;
        els.empty.hidden = !empty;
        if (empty) {
            u.clear(els.empty).appendChild(u.h('div', {}, [
                u.h('strong', { text: state.query || state.activeFolder ? 'Nothing matched' : 'No items yet' }),
                u.h('span', {
                    text: state.query || state.activeFolder
                        ? 'Try another folder, clear the search, or switch the filter.'
                        : 'Add something to Eagle and hit refresh.'
                })
            ]));
        }

        els.more.hidden = state.exhausted || state.items.length === 0;
        updateCheckedCount();
        updateStatus();
    }

    function setStatus(text) { if (els.status) els.status.textContent = text; }

    function updateStatus() {
        const shown = state.items.length;
        const bits = [];
        if (state.total) bits.push(state.total.toLocaleString() + ' match' + (state.total === 1 ? '' : 'es'));
        bits.push('showing ' + shown.toLocaleString());
        if (state.kind !== 'all') bits.push(state.kind);
        if (!E.available) bits.push('demo');
        setStatus(bits.join(' · '));
    }

    /* ─────────────────────────── selection ─────────────────────────── */

    function checkedItems() {
        return state.items.filter(function (it) { return state.checked[it.id]; });
    }

    function updateCheckedCount() {
        const n = checkedItems().length;
        els.checkedCount.textContent = String(n);
        els.addChecked.disabled = n === 0;
    }

    async function addCheckedToShelf() {
        const picked = checkedItems();
        if (!picked.length) return;
        P.Shelf.add(picked);
        syncAllCardStates();
    }

    async function grabEagleSelection() {
        const selected = await E.item.getSelected();
        if (!selected.length) {
            u.toast({ title: 'Nothing selected in Eagle', sub: 'Select items in the Eagle window, then try again.', kind: 'warn' });
            return;
        }
        P.Shelf.add(selected);
        u.toast({ title: 'Added ' + selected.length + ' item' + (selected.length === 1 ? '' : 's') + ' to the shelf', kind: 'success' });
        syncAllCardStates();
    }

    /** Called by the shelf when its contents change. */
    function onShelfChanged() { syncAllCardStates(); }

    function markShelfed(ids) {
        ids.forEach(function (id) { syncCardState(id); });
    }

    /* ─────────────────────────── native drag ─────────────────────────── */

    /**
     * Start a native drag of these items out of Perch.
     *
     * A drag that lands nowhere used to fail silently, which reads as "Perch is
     * broken" when the real cause is usually that the page has no drop target —
     * a sign-in screen, or a site that simply does not accept drops. Chromium
     * tells us: dragend's dropEffect stays 'none' when the drop was refused. Use
     * that to fall back to the clipboard so Ctrl+V still works, and say so.
     */
    function dragItems(items, sourceEl) {
        if (!items || !items.length) return;
        // Keep the shelf in sync with what is being dragged into the page.
        P.Shelf.add(items, { silent: true });

        const paths = items.map(function (it) { return it.filePath; }).filter(Boolean);
        if (!paths.length) {
            u.toast({ title: 'No local file path', sub: 'These items cannot be dragged out.', kind: 'warn' });
            return;
        }

        const fallbackToClipboard = function (reason, detail) {
            E.clipboard.copyFiles(paths).then(function (ok) {
                u.toast({
                    title: ok ? 'Files copied instead' : 'Could not copy the files',
                    sub: reason + (ok ? ' Click the page and press Ctrl/⌘ + V.' : ''),
                    kind: ok ? 'warn' : 'error',
                    icon: 'paperclip',
                    timeout: 8000
                });
            });
            E.log('drag did not land:', detail || reason);
        };

        if (sourceEl && sourceEl.addEventListener) {
            const onDragEnd = function (event) {
                sourceEl.removeEventListener('dragend', onDragEnd);
                const effect = event && event.dataTransfer && event.dataTransfer.dropEffect;

                if (effect === 'none') {
                    fallbackToClipboard(
                        'That page did not accept the drop — it may be a sign-in screen, or a page with no drop zone.',
                        'dropEffect=none'
                    );
                    return;
                }

                // The page took the file. Say so, because a site that is signed
                // out will accept the drop and then quietly discard it — which
                // looks exactly like Perch failing to deliver anything.
                E.log('drag delivered to the page (dropEffect=' + effect + ')');
                u.toast({
                    title: 'Delivered to the page',
                    sub: 'If nothing appeared, the site ignored it — signed-out web apps usually do. Sign in, or use Attach.',
                    kind: 'info',
                    icon: 'check',
                    timeout: 5000
                });
            };
            sourceEl.addEventListener('dragend', onDragEnd);
        }

        E.drag.startDrag(paths).catch(function () {
            fallbackToClipboard('Native drag is unavailable here.', 'startDrag rejected');
        });
    }

    P.Library = {
        init: init,
        refresh: function () { resetAndRefresh(); },
        onShelfChanged: onShelfChanged,
        markShelfed: markShelfed,
        dragItems: dragItems,
        folders: function () { return state.folders.slice(); },
        activeFolder: function () { return state.activeFolder; }
    };
})(window.Perch);
