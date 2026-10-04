// ---- ustar extraction (Phase 5: loading a previously-exported .tar.xz
// battle file back in) - pure byte parsing, no WASM needed, same idiom as
// replay_export.c's tar_add_entry() on the writing side. Verified against
// replay_export.c's own output (testdata/export_test.html) and against
// real tar.exe. ----
const USTAR_MAGIC = [117, 115, 116, 97, 114, 0, 48, 48]; // "ustar\0" + "00"
function parseOctalField(bytes) {
    let s = '';
    for (const b of bytes) { if (b === 0 || b === 32) break; s += String.fromCharCode(b); }
    return s.length ? parseInt(s, 8) : 0;
}
function parseTar(bytes) {
    const entries = [];
    let off = 0;
    while (off + 512 <= bytes.length) {
        const header = bytes.subarray(off, off + 512);
        if (header.every(b => b === 0)) break; // end-of-archive zero block
        const nameBytes = header.subarray(0, 100);
        let nameEnd = 0; while (nameEnd < 100 && nameBytes[nameEnd] !== 0) nameEnd++;
        const name = new TextDecoder().decode(nameBytes.subarray(0, nameEnd));
        const size = parseOctalField(header.subarray(124, 136));
        const magicBytes = header.subarray(257, 265);
        const magicOk = USTAR_MAGIC.every((b, i) => magicBytes[i] === b);
        off += 512;
        const data = bytes.subarray(off, off + size);
        entries.push({ name, size, magicOk, data });
        off += size;
        if (size % 512 !== 0) off += 512 - (size % 512);
    }
    return entries;
}

const canvas = document.getElementById('canvas');
const gl = canvas.getContext('webgl');
const uploadOverlay = document.getElementById('upload-overlay');
const loadingOverlay = document.getElementById('loading-overlay');
const resetBtn = document.getElementById('reset-btn');

// `new Worker(url)` has its own cache behavior, separate from fetch()'s
// (and not controllable via a {cache} option at all) - a plain relative
// URL here can silently keep using a browser-cached copy of
// replay-worker.js even after the file on disk/server has changed. One
// cache-bust suffix per page load, reused by every Worker(...) call site,
// same pattern testdata/verify_against_truth.html already uses for the
// same reason.
const WORKER_SCRIPT_URL = 'replay-worker.js?v=' + Date.now();

// Debug mode gates the system-log panel, the VFS trace panel, and the SQL
// terminal (added in a later phase) - all noise/attack-surface most users
// never need. Opt in via ?debug=1 for a one-off session, or persist it with
// localStorage so it survives a reload without retyping the URL.
const DEBUG_MODE = new URLSearchParams(location.search).has('debug') ||
                    localStorage.getItem('wb_debug') === '1';
const logBox = document.getElementById('log-box');
const debugPanel = document.getElementById('debug-panel');
const sqlTerminalPanel = document.getElementById('sql-terminal-panel');
// System Logs/VFS Trace default OFF even in debug mode (opt in via the
// hamburger menu's Panels checkboxes - see setPanelVisible below); SQL
// Terminal is the one debug tool that's actually useful open by default.
// Showing all three unconditionally is what caused the original overlap
// complaints this whole panel redesign exists to fix.
//
// The Panels section itself is NOT debug-gated (a normal user must still be
// able to open SQL Terminal/Schema Explorer/Docs/System Logs/VFS Trace
// through the menu - they just don't start open) - only which panels start
// VISIBLE differs by mode. Gating the whole section behind DEBUG_MODE left
// normal-mode users with no path to any of these panels at all, including
// no way to even reach the checkbox that would show them.
document.getElementById('menu-panels-section').style.display = 'block';
if (DEBUG_MODE) {
    sqlTerminalPanel.style.display = 'flex';
    document.getElementById('panel-toggle-sql-terminal-panel').checked = true;
}

let currentSimulationState = "AWAITING_FILE";
let activeLogs = ["Ready to process Warband SQLite replay..."];
let wasmInstance = null;

// Replay playback state - all tick/SQL bookkeeping lives in replay_worker.wasm;
// this is just the continuous playback clock the render loop advances.
let replayTime = 0.0;
let totalStartTime = 0.0;
let totalEndTime = 0.0;
let isPaused = false;
let playbackSpeed = 1.0;
let matches = []; // small (<=16) summary array from the loader worker's 'loaded' message
let timelineLoadBars = []; // per-match DOM element for the buffered/loaded indicator, see updateLoadIndicators()

// Phase 5: the ordered, user-editable rendering-query list - the single
// source of truth for what gets drawn/shown, main.js's job alone to own
// (replay_worker.c's RenderQuerySlot engine is a "dumb executor": it only
// ever receives already-decided sql/interpolate/shape/enabled params per
// slot, never parses @KIND/@CACHE/@INTERPOLATE directives itself - see that
// file's own header comment on the render-query section). Each entry:
// { name, kind: 'dots'|'chat', cache: 'tick'|'live'|'none', interpolate, shape,
// enabled, sql }. kind='chat' entries never reach the C engine at all -
// refreshChatFromQuery runs them directly and concatenates results in list
// order (see that function). List order IS draw order for 'dots' entries -
// pushRenderQueriesToEngine always resubmits the full dots-kind sublist in
// list order. Populated once per load (initDefaultRenderQueries, called from
// onLoaderMessage's 'loaded' case) from the compiled-in C defaults via the
// 'getDefaultRenderQueries' worker message, plus one JS-only default chat
// entry (the exact query refreshChatFromQuery always ran before this list
// existed) - a fresh load reproduces today's exact behavior byte-for-byte,
// a user who never opens the Rendering Queries panel sees zero change.
let renderQueries = [];
let nextRenderQueryId = 1;
let renderQueriesNeedRevalidate = false; // see onLoaderMessage's 'loaded'/'frame' cases
// Cached verbatim from the 'defaultRenderQueries' worker reply - reused by
// "Reset to Defaults" so that button doesn't need its own round-trip, and so
// its result is byte-identical to what a fresh load itself seeds.
let defaultRenderQueriesSnapshot = null;
// Phase 6: the @KIND nato_symbol sample/template (sql/sample_render_nato_symbols.sql),
// fetched once via 'getSampleNatoSymbolSql' - see updateRenderQueryField's
// own use of this when the panel's Kind control is switched to nato_symbol.
let sampleNatoSymbolSql = null;

// ---- @KIND/@CACHE/@INTERPOLATE/@SHAPE directive comments - leading
// `-- @KEY value` lines, read/written by the Rendering Queries panel's own
// controls (see buildRenderQueryCard) but otherwise just ordinary SQL
// comments - the query text stays valid, runnable SQL entirely on its own,
// matching every default query file (sql/default_render_*.sql). Directives
// are matched anywhere a `-- @KEY value` line appears (not just a fixed
// leading block), since a hand-edited query's comments won't always stay in
// exactly the same shape the defaults ship in. ----
function parseRenderQueryDirectives(sql) {
    const kindM = /^--\s*@KIND\s+(\S+)/im.exec(sql);
    const cacheM = /^--\s*@CACHE\s+(\S+)/im.exec(sql);
    const interpM = /^--\s*@INTERPOLATE\s+(\S+)/im.exec(sql);
    const shapeM = /^--\s*@SHAPE\s+(\S+)/im.exec(sql);
    const cacheVal = cacheM ? cacheM[1].toLowerCase() : 'tick';
    return {
        kind: kindM ? kindM[1].toLowerCase() : 'dots',
        cache: (cacheVal === 'live' || cacheVal === 'none') ? cacheVal : 'tick',
        interpolate: interpM ? interpM[1].toLowerCase() !== 'off' : true,
        shape: (shapeM && shapeM[1].toLowerCase() === 'ring') ? 1 : 0,
    };
}
// Rewrites (or inserts) a single `-- @KEY value` line, leaving the rest of
// the text untouched - used by the panel's dropdown/checkbox controls so a
// control change and a hand-edit of the same line converge on the same text.
function setRenderQueryDirective(sql, key, value) {
    const re = new RegExp('^--\\s*@' + key + '\\s+\\S+\\s*$', 'im');
    const line = `-- @${key} ${value}`;
    if (re.test(sql)) return sql.replace(re, line);
    return line + '\n' + sql;
}

function initDefaultRenderQueries(defaults) {
    // defaults = [{sql, interpolate, shape}, ...] straight from
    // replay_get_default_render_query_sql/interpolate/shape (slot 0 =
    // corpses, slot 1 = living_agents - see replay_worker.c's
    // seed_default_render_queries, the same slot assignment).
    defaultRenderQueriesSnapshot = defaults;
    renderQueries = [
        { id: nextRenderQueryId++, name: 'Corpses', kind: 'dots', cache: 'tick', interpolate: defaults[0].interpolate, shape: defaults[0].shape, enabled: true, sql: defaults[0].sql },
        { id: nextRenderQueryId++, name: 'Living Agents', kind: 'dots', cache: 'tick', interpolate: defaults[1].interpolate, shape: defaults[1].shape, enabled: true, sql: defaults[1].sql },
        { id: nextRenderQueryId++, name: 'Chat', kind: 'chat', cache: 'tick', interpolate: false, shape: 0, enabled: true, sql: defaults[2].sql },
    ];
    pushRenderQueriesToEngine();
    refreshAllRenderQueryPanels();
}

// Toolbar "Reset to Defaults" - rebuilds the exact same 3-entry list
// initDefaultRenderQueries produces on a fresh load, discarding any edits.
function resetRenderQueriesToDefaults() {
    if (!defaultRenderQueriesSnapshot) return;
    initDefaultRenderQueries(defaultRenderQueriesSnapshot);
}

// Recognized by updateRenderQueryField below to detect "the user hasn't
// actually written anything yet" - switching Kind to nato_symbol on a query
// still carrying this exact placeholder swaps in the real sample template
// (sampleNatoSymbolSql) instead of just prepending a directive line on top
// of irrelevant dots SQL; switching on a query with real user SQL never
// touches the SQL body, only the directive comment (see that function).
const NEW_RENDER_QUERY_PLACEHOLDER_SQL =
    '-- @KIND dots\n-- @CACHE tick\n-- @INTERPOLATE off\nSELECT x, y, 1.0 AS color_r, 1.0 AS color_g, 1.0 AS color_b\nFROM b.corpses\nWHERE 0; -- replace with a real condition - b is an arbitrary, user-editable schema (see Schema Explorer)';

function addRenderQuery() {
    renderQueries.push({
        id: nextRenderQueryId++, name: 'New Query', kind: 'dots', cache: 'tick',
        interpolate: false, shape: 0, enabled: true,
        sql: NEW_RENDER_QUERY_PLACEHOLDER_SQL,
    });
    pushRenderQueriesToEngine();
    refreshAllRenderQueryPanels();
}

function deleteRenderQuery(id) {
    renderQueries = renderQueries.filter(q => q.id !== id);
    // Close any live pop-out for this query BEFORE dropping its editors
    // entry - otherwise a pop-out window open on a just-deleted query is
    // left orphaned: still on screen, still editable, but any further edit
    // silently goes nowhere (the query object it closes over is no longer
    // in renderQueries at all).
    for (const e of (renderQueryEditors[id] || [])) {
        if (e.root && e.root.closest('[data-panel-type="render-query-popout-panel"]')) {
            e.root.closest('[data-panel-type="render-query-popout-panel"]').remove();
        }
    }
    delete renderQueryEditors[id];
    pushRenderQueriesToEngine();
    refreshAllRenderQueryPanels();
}

function moveRenderQuery(id, delta) {
    const idx = renderQueries.findIndex(q => q.id === id);
    const newIdx = idx + delta;
    if (idx < 0 || newIdx < 0 || newIdx >= renderQueries.length) return;
    const [q] = renderQueries.splice(idx, 1);
    renderQueries.splice(newIdx, 0, q);
    pushRenderQueriesToEngine();
    refreshAllRenderQueryPanels();
}

// A structural field (kind/cache/interpolate/shape/enabled/name) changed via
// a control, not a raw textarea edit - rewrites the SQL's own directive
// comment to match (so Export/hand-editing stays consistent with what the
// controls show), re-pushes to the engine, and does a full repaint (cheap
// and correct here, unlike a textarea edit - see syncRenderQueryText).
function updateRenderQueryField(id, field, value) {
    const q = renderQueries.find(q => q.id === id);
    if (!q) return;
    q[field] = value;
    if (field === 'kind' && value === 'nato_symbol' && q.sql === NEW_RENDER_QUERY_PLACEHOLDER_SQL && sampleNatoSymbolSql) {
        q.sql = sampleNatoSymbolSql;
        q.interpolate = true; // matches the sample's own @INTERPOLATE on
    } else if (field === 'kind') {
        q.sql = setRenderQueryDirective(q.sql, 'KIND', value);
    }
    if (field === 'cache') q.sql = setRenderQueryDirective(q.sql, 'CACHE', value);
    if (field === 'interpolate') q.sql = setRenderQueryDirective(q.sql, 'INTERPOLATE', value ? 'on' : 'off');
    if (field === 'shape') q.sql = setRenderQueryDirective(q.sql, 'SHAPE', value === 1 ? 'ring' : 'dot');
    pushRenderQueriesToEngine();
    if (field === 'kind' && q.kind === 'chat') refreshChatFromQuery(latestFrame ? latestFrame.activeMatchIndex : -1);
    refreshAllRenderQueryPanels();
}

// Resubmits the full ordered dots-kind sublist to the C engine - see
// replay_worker.c's replay_render_query_configure/replay_render_query_set_count
// and this section's own header comment on the "always resubmit the whole
// list" model. Called once after every change to renderQueries (today: only
// at load time; once the Rendering Queries panel exists, every add/remove/
// reorder/edit/enable/disable calls this too).
// Tracks which query id landed in which C slot on the most recent push, so
// the 'renderQueriesConfigured' reply (indexed by slot, matching the C
// engine's own addressing) can be routed back to the right card's status
// line - see onLoaderMessage's 'renderQueriesConfigured' case.
let lastPushedDotsIds = [];
function pushRenderQueriesToEngine() {
    const dots = renderQueries.filter(q => q.kind === 'dots');
    lastPushedDotsIds = dots.map(q => q.id);
    for (const q of dots) setRenderQueryStatus(q.id, 'OK.', q.sql);
    if (!playbackWorker) return;
    const dotsQueries = dots.map(q => ({
        sql: q.sql, interpolate: q.interpolate, shape: q.shape, enabled: q.enabled, cache: q.cache,
    }));
    playbackWorker.postMessage({ type: 'configureRenderQueries', queries: dotsQueries });
}

// ---- Rendering Queries panel: build/wire, one card per renderQueries
// entry. "Duplicable window chrome, globally shared underlying state" (like
// Chat/System Logs, unlike SQL Terminal) - there's one GL canvas and one
// query list, so refreshAllRenderQueryPanels() below does a full repaint of
// every open copy on any STRUCTURAL change (add/remove/reorder/toggle/
// directive-control edit). A raw textarea keystroke does NOT trigger that -
// syncRenderQueryText mirrors it into every OTHER open copy of the SAME
// card only, exactly like generator-script editors already do
// (syncGeneratorScriptText) - a full repaint on every keystroke would reset
// the typing cursor and undo history in the window being typed in. ----

// id -> [{textarea, backdrop, gutter, status, root}, ...], one entry per
// currently-mounted card for that query, across every open panel window.
const renderQueryEditors = {};
function pruneDeadRenderQueryEditors(id) {
    const list = renderQueryEditors[id];
    if (!list) return [];
    const alive = list.filter(e => e.textarea.isConnected);
    renderQueryEditors[id] = alive;
    return alive;
}
function syncRenderQueryText(id, text, source) {
    for (const e of pruneDeadRenderQueryEditors(id)) {
        if (e.textarea === source) continue;
        e.textarea.value = text;
        renderSqlHighlightInto(e.textarea, e.backdrop);
        renderLineNumbersInto(e.textarea, e.gutter);
    }
}
function setRenderQueryStatus(id, text, sqlText, errorOffset) {
    const isError = text.startsWith('Error');
    for (const e of pruneDeadRenderQueryEditors(id)) {
        e.status.innerText = isError ? formatSqlErrorMessage(text, sqlText, errorOffset) : text;
        e.status.classList.toggle('is-error', isError);
    }
}

// Debounced per-query push to the engine so fast typing doesn't flood the
// worker queue with a prepare-validate call per keystroke (each one is
// cheap alone - see replay_render_query_configure's own comment - but a
// paste or held key can fire dozens in a row).
const renderQueryPushTimers = {};
function debouncedPushRenderQueries(id) {
    clearTimeout(renderQueryPushTimers[id]);
    renderQueryPushTimers[id] = setTimeout(() => pushRenderQueriesToEngine(), 400);
}

// Editing a @KIND=chat query used to re-run refreshChatFromQuery on EVERY
// raw keystroke, including every intermediate, syntactically-broken state
// while still mid-edit - a real, unbounded flood of overlapping background
// SQL requests while typing (runSchemaQueryAsync has no cap on how many can
// be in flight/queued at once), unlike the engine push right above, which
// was already debounced. Same 400ms debounce, same reasoning.
let chatRefreshTimer = null;
function debouncedRefreshChatFromQuery() {
    clearTimeout(chatRefreshTimer);
    chatRefreshTimer = setTimeout(() => refreshChatFromQuery(latestFrame ? latestFrame.activeMatchIndex : -1), 400);
}

function buildRenderQueryCard(q) {
    const card = document.createElement('div');
    card.className = 'render-query-card';
    card.dataset.queryId = String(q.id);

    const header = document.createElement('div');
    header.className = 'render-query-card-header';

    const dragHandle = document.createElement('span');
    dragHandle.className = 'render-query-drag-handle';
    dragHandle.textContent = '☰';
    dragHandle.title = 'Drag to reorder';
    dragHandle.draggable = true;
    header.appendChild(dragHandle);

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'render-query-name';
    nameInput.value = q.name;
    nameInput.addEventListener('change', () => updateRenderQueryField(q.id, 'name', nameInput.value));
    header.appendChild(nameInput);

    const enabledLabel = document.createElement('label');
    enabledLabel.className = 'render-query-enabled-label';
    const enabledCheckbox = document.createElement('input');
    enabledCheckbox.type = 'checkbox';
    enabledCheckbox.checked = q.enabled;
    enabledCheckbox.addEventListener('change', () => updateRenderQueryField(q.id, 'enabled', enabledCheckbox.checked));
    enabledLabel.appendChild(enabledCheckbox);
    enabledLabel.appendChild(document.createTextNode(' Enabled'));
    header.appendChild(enabledLabel);

    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = '×';
    deleteBtn.title = 'Delete this query';
    deleteBtn.className = 'render-query-delete-btn';
    deleteBtn.onclick = () => deleteRenderQuery(q.id);
    header.appendChild(deleteBtn);

    card.appendChild(header);

    const controlsRow = document.createElement('div');
    controlsRow.className = 'render-query-controls-row';

    const kindSelect = document.createElement('select');
    const KIND_LABELS = { dots: 'Kind: Dots', chat: 'Kind: Chat', nato_symbol: 'Kind: NATO Symbol' };
    Object.keys(KIND_LABELS).forEach(k => {
        const opt = document.createElement('option');
        opt.value = k; opt.textContent = KIND_LABELS[k];
        if (q.kind === k) opt.selected = true;
        kindSelect.appendChild(opt);
    });
    kindSelect.addEventListener('change', () => updateRenderQueryField(q.id, 'kind', kindSelect.value));
    controlsRow.appendChild(kindSelect);

    const cacheSelect = document.createElement('select');
    [['tick', 'Cache: Per Tick'], ['live', 'Cache: Live (every frame)'], ['none', 'Cache: None (once per battle)']].forEach(([v, label]) => {
        const opt = document.createElement('option');
        opt.value = v; opt.textContent = label;
        if (q.cache === v) opt.selected = true;
        cacheSelect.appendChild(opt);
    });
    cacheSelect.title = 'Per Tick (default) re-runs whenever the tick changes. Live re-runs every rendered frame instead - a real perf tradeoff, only for queries that need it (e.g. reading the live cursor position). None runs this query once per battle and never again automatically - for a query whose result is battle-wide rather than per-tick (e.g. scoped by CURRENT_BATTLE_TICK_START()/END() instead of CURRENT_TICK()), where re-running it every tick would just repeat the same answer.';
    cacheSelect.addEventListener('change', () => updateRenderQueryField(q.id, 'cache', cacheSelect.value));
    controlsRow.appendChild(cacheSelect);

    // Interpolate applies to both dots (GL) and nato_symbol (dom-overlay) -
    // both blend a tickA/tickB row pair by row_key, just via different
    // mechanisms (blend_render_slot in C vs. updateNatoSymbolTransform in
    // JS - see that function's own header comment). Shape (dot/ring) is
    // GL-specific, dots only.
    if (q.kind === 'dots' || q.kind === 'nato_symbol') {
        const interpLabel = document.createElement('label');
        const interpCheckbox = document.createElement('input');
        interpCheckbox.type = 'checkbox';
        interpCheckbox.checked = q.interpolate;
        interpCheckbox.addEventListener('change', () => updateRenderQueryField(q.id, 'interpolate', interpCheckbox.checked));
        interpLabel.appendChild(interpCheckbox);
        interpLabel.appendChild(document.createTextNode(' Interpolate'));
        controlsRow.appendChild(interpLabel);
    }
    if (q.kind === 'dots') {
        const shapeSelect = document.createElement('select');
        [[0, 'Shape: Dot'], [1, 'Shape: Ring']].forEach(([v, label]) => {
            const opt = document.createElement('option');
            opt.value = String(v); opt.textContent = label;
            if (q.shape === v) opt.selected = true;
            shapeSelect.appendChild(opt);
        });
        shapeSelect.addEventListener('change', () => updateRenderQueryField(q.id, 'shape', parseInt(shapeSelect.value, 10)));
        controlsRow.appendChild(shapeSelect);
    }

    const popoutBtn = document.createElement('button');
    popoutBtn.textContent = 'Open in window';
    popoutBtn.title = 'Edit this query in its own separate, larger window, kept in sync with this card';
    popoutBtn.onclick = () => createRenderQueryPopoutPanel(q);
    controlsRow.appendChild(popoutBtn);

    card.appendChild(controlsRow);

    // Row: line-number gutter + backdrop/textarea pair - identical technique
    // to buildGeneratorScriptEditor, just with its own CSS classes (main.css's
    // .render-query-* rules).
    const editorRow = document.createElement('div');
    editorRow.className = 'render-query-editor-row';

    const gutter = document.createElement('pre');
    gutter.className = 'render-query-gutter';
    gutter.setAttribute('aria-hidden', 'true');
    editorRow.appendChild(gutter);

    const editorWrap = document.createElement('div');
    editorWrap.className = 'render-query-editor-wrap';

    const backdrop = document.createElement('pre');
    backdrop.className = 'render-query-highlight';
    backdrop.setAttribute('aria-hidden', 'true');
    editorWrap.appendChild(backdrop);

    const textarea = document.createElement('textarea');
    textarea.rows = 8;
    textarea.className = 'render-query-textarea';
    textarea.spellcheck = false;
    textarea.autocomplete = 'off';
    textarea.value = q.sql;
    editorWrap.appendChild(textarea);

    editorRow.appendChild(editorWrap);
    card.appendChild(editorRow);

    const status = document.createElement('div');
    status.className = 'render-query-status';
    card.appendChild(status);

    wireRenderQueryEditorBehavior(q, { textarea, backdrop, gutter, status, root: card });
    return card;
}

// Shared behavior behind EVERY render-query editor instance, regardless of
// which DOM/CSS shell it's mounted in (the compact card above, or the
// pop-out further down) - mirrors wireGeneratorScriptEditorBehavior's own
// split exactly: the caller owns layout, this owns behavior. `els` is
// {textarea, backdrop, gutter, status, root}.
function wireRenderQueryEditorBehavior(q, els) {
    const { textarea, backdrop, gutter, status, root } = els;
    attachSqlHighlighting(textarea, backdrop, gutter);
    const editor = { textarea, backdrop, gutter };
    editor.onTextChanged = () => {
        q.sql = textarea.value;
        syncRenderQueryText(q.id, textarea.value, textarea);
        debouncedPushRenderQueries(q.id);
        if (q.kind === 'chat') debouncedRefreshChatFromQuery();
    };
    attachSqlAutocomplete(editor);
    textarea.addEventListener('input', editor.onTextChanged);
    // Re-parses directives from hand-edited text on blur (not per-keystroke -
    // see this section's own header comment) so the dropdowns above converge
    // back to whatever the text now says, without disrupting an in-progress
    // edit.
    textarea.addEventListener('blur', () => {
        const parsed = parseRenderQueryDirectives(textarea.value);
        q.kind = (parsed.kind === 'chat' || parsed.kind === 'nato_symbol') ? parsed.kind : 'dots';
        q.cache = parsed.cache;
        q.interpolate = parsed.interpolate;
        q.shape = parsed.shape;
        pushRenderQueriesToEngine();
        refreshAllRenderQueryPanels();
    });

    renderQueryEditors[q.id] = (renderQueryEditors[q.id] || []).concat([{ textarea, backdrop, gutter, status, root }]);
}

// Pop-out layout: the same "genuinely separate, larger proper text editor"
// shell the generator-script pop-out uses (main.css's .render-query-popout-*
// rules, aliased onto the identical .generator-popout-* declarations so both
// features share one definition of what a pop-out editor looks like) - no
// metadata controls (kind/cache/interpolate/shape/name/enabled stay
// exclusive to the compact card, edited there), Ctrl+Enter has no special
// meaning here (a render query has no explicit "Run" - it applies on every
// edit), status/errors show in the same Emacs-style minibuffer line.
function buildRenderQueryPopoutEditor(q) {
    const root = document.createElement('div');
    root.className = 'render-query-popout-root';

    const editorRow = document.createElement('div');
    editorRow.className = 'render-query-popout-editor-row';

    const gutter = document.createElement('pre');
    gutter.className = 'render-query-popout-gutter';
    gutter.setAttribute('aria-hidden', 'true');
    editorRow.appendChild(gutter);

    const editorWrap = document.createElement('div');
    editorWrap.className = 'render-query-popout-editor-wrap';

    const backdrop = document.createElement('pre');
    backdrop.className = 'render-query-popout-highlight';
    backdrop.setAttribute('aria-hidden', 'true');
    editorWrap.appendChild(backdrop);

    const textarea = document.createElement('textarea');
    textarea.className = 'render-query-popout-textarea';
    textarea.spellcheck = false;
    textarea.autocomplete = 'off';
    textarea.value = q.sql;
    editorWrap.appendChild(textarea);

    editorRow.appendChild(editorWrap);
    root.appendChild(editorRow);

    const status = document.createElement('div');
    status.className = 'render-query-popout-minibuffer';
    root.appendChild(status);

    wireRenderQueryEditorBehavior(q, { textarea, backdrop, gutter, status, root });
    return root;
}

// Pops a single query's editor out into its own independent, draggable/
// resizable/closable window - built the exact same way
// createGeneratorScriptPopoutPanel is (a fresh panel with no static
// main.html markup, wired through the same wirePanelInstance every other
// window uses), staying live-synced with the compact card via
// renderQueryEditors[q.id] (wireRenderQueryEditorBehavior above), same as a
// popped-out generator script stays synced with its embedded original.
function createRenderQueryPopoutPanel(q) {
    // De-dupe: a double-click (or clicking "Open in window" again on a card
    // whose pop-out is already open) must bring the EXISTING window to
    // front, not spawn a second independent one for the same query id.
    // Two live editors for one query, both wired into the same
    // renderQueryEditors[q.id] sync (syncRenderQueryText treats each as
    // "not the source" from the other's perspective), stacked 30px apart
    // right on top of each other - a real, easy way for a user to end up
    // typing into a window they didn't think had focus, reading as
    // "my keystrokes are landing somewhere wrong" even though each
    // individual editor's own cursor tracking is internally fine.
    for (const e of pruneDeadRenderQueryEditors(q.id)) {
        const existing = e.root && e.root.closest('[data-panel-type="render-query-popout-panel"]');
        if (existing) {
            existing.style.zIndex = String(++panelZIndexCounter);
            e.textarea.focus();
            return existing;
        }
    }

    const panel = document.createElement('div');
    panel.className = 'ui-panel';
    panel.setAttribute('data-panel-type', 'render-query-popout-panel');

    const header = document.createElement('div');
    header.className = 'panel-header';
    const title = document.createElement('span');
    title.textContent = `[Rendering Query: ${q.name}]`;
    const controls = document.createElement('span');
    controls.className = 'panel-header-controls';
    controls.innerHTML = '<span class="toggle-icon">-</span><span class="panel-maximize-btn" title="Maximize window"></span><span class="panel-close-btn" title="Close window">&times;</span>';
    header.appendChild(title);
    header.appendChild(controls);
    panel.appendChild(header);
    panel.appendChild(document.createElement('div')).className = 'panel-content';

    document.body.appendChild(panel);
    wirePanelInstance(panel);

    const content = panel.querySelector('.panel-content');
    ensurePanelZoomWrap(content).appendChild(buildRenderQueryPopoutEditor(q));

    const alreadyVisible = document.querySelectorAll('[data-panel-type="render-query-popout-panel"]').length - 1;
    const offset = alreadyVisible * 30;
    panel.style.top = (20 + offset) + 'px';
    panel.style.right = (20 + offset) + 'px';
    panel.style.left = 'auto';
    panel.style.bottom = 'auto';
    panel.style.zIndex = String(++panelZIndexCounter);
    panel.style.display = 'flex';
    return panel;
}

// Drag-reorder: HTML5 drag-and-drop on each card's drag handle, reordering
// renderQueries by query id (not DOM position) so this stays correct
// regardless of which of possibly several open panel windows the drag
// happened in.
function wireRenderQueryDragReorder(listEl) {
    let draggingId = null;
    listEl.addEventListener('dragstart', (e) => {
        const card = e.target.closest('.render-query-card');
        if (!card) return;
        draggingId = parseInt(card.dataset.queryId, 10);
        e.dataTransfer.effectAllowed = 'move';
    });
    listEl.addEventListener('dragover', (e) => {
        if (draggingId == null) return;
        e.preventDefault();
        const card = e.target.closest('.render-query-card');
        if (!card) return;
        card.classList.add('render-query-drop-target');
    });
    listEl.addEventListener('dragleave', (e) => {
        const card = e.target.closest('.render-query-card');
        if (card) card.classList.remove('render-query-drop-target');
    });
    listEl.addEventListener('drop', (e) => {
        e.preventDefault();
        const card = e.target.closest('.render-query-card');
        listEl.querySelectorAll('.render-query-drop-target').forEach(c => c.classList.remove('render-query-drop-target'));
        if (!card || draggingId == null) return;
        const targetId = parseInt(card.dataset.queryId, 10);
        if (targetId === draggingId) return;
        const fromIdx = renderQueries.findIndex(q => q.id === draggingId);
        const toIdx = renderQueries.findIndex(q => q.id === targetId);
        if (fromIdx < 0 || toIdx < 0) return;
        const [moved] = renderQueries.splice(fromIdx, 1);
        renderQueries.splice(toIdx, 0, moved);
        draggingId = null;
        pushRenderQueriesToEngine();
        refreshAllRenderQueryPanels();
    });
}

// Rebuilds every open Rendering Queries panel's card list from scratch -
// see this section's own header comment on why a full repaint is safe here
// (only called on structural changes, never on a plain textarea keystroke).
function refreshAllRenderQueryPanels() {
    for (const content of panelContentElements('render-queries-panel')) {
        const listEl = content.querySelector('.render-queries-list');
        if (!listEl) continue;
        listEl.innerHTML = '';
        const frag = document.createDocumentFragment();
        for (const q of renderQueries) frag.appendChild(buildRenderQueryCard(q));
        listEl.appendChild(frag);
        if (!listEl.dataset.dragWired) {
            wireRenderQueryDragReorder(listEl);
            listEl.dataset.dragWired = '1';
        }
    }
}

// Export/Import SQL: one JSON bundle (query text, order, directives all
// round-trip together) - reuses finishExportDownload's exact Blob+
// <a download>+revokeObjectURL pattern (see exportActiveBattle) and the
// existing hidden-<input type=file>+change-listener pattern used for battle
// file import, just pointed at a small JSON document instead of tar bytes.
// pipeline_overrides carries the replay.db/battle.db generator scripts'
// CURRENT customization alongside the rendering queries, best-effort: those
// scripts have no canonical copy outside whichever Schema Explorer/pop-out
// editor DOM currently holds them (generatorScriptEditors - a genuinely
// open editor IS the source of truth while mounted, see that map's own
// comment), so a viewKind with no editor open right now is simply omitted
// rather than exported as a false "no customization" null.
function currentGeneratorScriptTextOrNull(viewKind) {
    const alive = pruneDeadGeneratorScriptEditors(viewKind);
    return alive.length > 0 ? alive[0].textarea.value : null;
}

function exportRenderQueriesSql() {
    const bundle = {
        format_version: 1,
        render_queries: renderQueries.map(q => ({
            name: q.name, kind: q.kind, cache: q.cache, interpolate: q.interpolate, enabled: q.enabled, sql: q.sql,
        })),
        pipeline_overrides: {
            replaydb_populate: currentGeneratorScriptTextOrNull(1),
            battledb_derive: currentGeneratorScriptTextOrNull(2),
        },
    };
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'rendering-queries.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// Applies an imported pipeline_overrides entry to viewKind - pushes it into
// any currently-open editor's DOM (so it stays in sync the same way a live
// edit would - syncGeneratorScriptText) and runs it for real via the same
// 'runGeneratorScript' message the Run button posts, so the import actually
// takes effect immediately rather than just prefilling a textarea nobody
// clicks Run on.
function applyImportedGeneratorScript(viewKind, sql) {
    if (sql == null || !playbackWorker) return;
    for (const e of pruneDeadGeneratorScriptEditors(viewKind)) {
        e.textarea.value = sql;
        renderSqlHighlightInto(e.textarea, e.backdrop);
        renderLineNumbersInto(e.textarea, e.gutter);
    }
    setAllGeneratorStatus(viewKind, 'Running...');
    playbackWorker.postMessage({ type: 'runGeneratorScript', viewKind, sql });
}

function importRenderQueriesSqlFile(file) {
    file.text().then(text => {
        const bundle = JSON.parse(text);
        if (!Array.isArray(bundle.render_queries)) throw new Error('missing render_queries array');
        renderQueries = bundle.render_queries.map(q => ({
            id: nextRenderQueryId++,
            name: q.name || 'Query',
            kind: (q.kind === 'chat' || q.kind === 'nato_symbol') ? q.kind : 'dots',
            cache: (q.cache === 'live' || q.cache === 'none') ? q.cache : 'tick',
            interpolate: !!q.interpolate, shape: q.shape === 1 ? 1 : 0,
            enabled: q.enabled !== false, sql: String(q.sql || ''),
        }));
        pushRenderQueriesToEngine();
        refreshChatFromQuery(latestFrame ? latestFrame.activeMatchIndex : -1);
        refreshAllRenderQueryPanels();
        if (bundle.pipeline_overrides) {
            applyImportedGeneratorScript(1, bundle.pipeline_overrides.replaydb_populate);
            applyImportedGeneratorScript(2, bundle.pipeline_overrides.battledb_derive);
        }
    }).catch(e => {
        alert('Failed to import rendering queries: ' + e.message);
    });
}

// ---- Phase 6: NATO APP-6 symbol kind (@KIND nato_symbol) - a dom-overlay
// surface (see the plan's own §1 RENDER_KINDS registry: gl for dots,
// chat-panel for chat, dom-overlay for this). Entirely JS-only, exactly like
// chat - never reaches replay_worker.c's RenderQuerySlot engine at all, runs
// its SQL directly through the same background SQL Terminal execution path
// (runSchemaQueryAsync) chat already uses. Tick-gated per query, with a
// genuine two-fetch (tickA + tickB via CURRENT_TICK()/CURRENT_TICK_B()) +
// per-RAF JS-side blend for @INTERPOLATE on, mirroring @KIND=dots' own
// tick-gated-fetch/cheap-per-RAF-blend split but entirely client-side, since
// a dom-overlay symbol's position is a DOM transform, not a GL buffer. ----

let currentViewShiftX = 0, currentViewShiftY = 0;

// Grouped by arm, matching real APP-6 practice (variants within an arm use
// amplifiers, not distinct icons) - see lua/msfiles/header_common.py's
// multi_troop_class_* enum for the real class_id values Napoleonic Wars
// uses (10-23), plus the pre-Napoleonic 0-7 fallback set. Unlisted/0 -> the
// 'other' fallback below (empty frame, no interior glyph - APP-6's own
// "unknown function" convention).
const NATO_UNIT_TYPE_MAP = {
    1: { arm: 'infantry' }, 10: { arm: 'infantry' }, 11: { arm: 'infantry' }, 12: { arm: 'infantry' }, 13: { arm: 'infantry' },
    3: { arm: 'cavalry' }, 14: { arm: 'cavalry' }, 15: { arm: 'cavalry' }, 16: { arm: 'cavalry' }, 17: { arm: 'cavalry' }, 18: { arm: 'cavalry' }, 19: { arm: 'cavalry' },
    4: { arm: 'infantry', ranged: true }, 5: { arm: 'infantry', ranged: true },
    6: { arm: 'cavalry', ranged: true }, 7: { arm: 'cavalry', ranged: true },
    20: { arm: 'artillery' },
    21: { arm: 'rocket' },
    22: { arm: 'engineer' },
    23: { arm: 'medical' },
};
function getNatoUnitInfo(classId) {
    return NATO_UNIT_TYPE_MAP[classId] || { arm: 'other' };
}

// Replicates main.c's render_frame() ortho/view math exactly (aspect-scaled
// 30-unit half-extent ortho projection, camera scale+translate, Y-flip to
// screen space) so a symbol's screen position can be recomputed every RAF
// from cheap arithmetic alone - no WASM round-trip per symbol per frame.
// view_shift is applied to the world position first, exactly like
// render_frame applies it per-object to agent/highlight positions (never
// folded into the shared vp matrix - see set_view_shift's own comment on
// why that was tried and rejected twice already).
function worldToScreen(wx, wy) {
    if (!wasmInstance) return null;
    const ex = wasmInstance.exports;
    const camX = ex.get_cam_x(), camY = ex.get_cam_y(), camZoom = ex.get_cam_zoom();
    const sx = (wx + currentViewShiftX - camX) * camZoom;
    const sy = (wy + currentViewShiftY - camY) * camZoom;
    const aspect = canvas.width / canvas.height;
    let xBound = 30.0, yBound = 30.0;
    if (aspect > 1.0) xBound *= aspect; else yBound /= aspect;
    const ndcX = sx / xBound, ndcY = sy / yBound;
    return { x: (ndcX + 1) / 2 * canvas.width, y: (1 - ndcY) / 2 * canvas.height };
}

// Shortest-angle-delta rotation blend (avoids a 359deg->0deg spin artifact a
// naive linear blend would produce).
function blendAngleDeg(a, b, alpha) {
    let delta = ((b - a + 180) % 360 + 360) % 360 - 180;
    return a + delta * alpha;
}

const NATO_SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs) {
    const el = document.createElementNS(NATO_SVG_NS, tag);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    return el;
}

// Builds one symbol's static DOM structure (frame + interior glyph +
// amplifiers + labels) - rebuilt only when a row's unit_type/affiliation
// changes (see updateNatoSymbolLayer), not every RAF. Frame shape encodes
// affiliation (APP-6: rectangle=friend, diamond=hostile, square=neutral,
// quatrefoil-ish=unknown); no affiliation given falls back to a plain
// rectangle colored by team, since a symmetric two-team spectator replay has
// no inherent "who's the enemy" framing (the plan's own explicit call).
function buildNatoSymbolElement(row) {
    const g = svgEl('g', { class: 'nato-symbol' });
    const info = getNatoUnitInfo(row.unit_type | 0);
    const color = (row.color_r != null)
        ? `rgb(${Math.round(row.color_r * 255)},${Math.round(row.color_g * 255)},${Math.round(row.color_b * 255)})`
        : '#00ff00';

    const S = 10; // half-size of the frame, in screen px at scale=1
    let frame;
    switch (row.affiliation) {
        case 'hostile': frame = svgEl('polygon', { points: `0,${-S} ${S},0 0,${S} ${-S},0` }); break; // diamond
        case 'neutral': frame = svgEl('rect', { x: -S, y: -S, width: S * 2, height: S * 2 }); break; // square
        case 'unknown': frame = svgEl('ellipse', { cx: 0, cy: 0, rx: S * 1.15, ry: S * 0.75 }); break; // quatrefoil approximation
        case 'friend':
        default: frame = svgEl('rect', { x: -S, y: -S * 0.7, width: S * 2, height: S * 1.4 }); break; // rectangle
    }
    frame.setAttribute('class', 'nato-symbol-frame');
    frame.setAttribute('stroke', color);
    frame.setAttribute('vector-effect', 'non-scaling-stroke');
    g.appendChild(frame);

    const glyph = svgEl('g', { class: 'nato-symbol-glyph-group' });
    const G = S * 0.55;
    function addGlyphPath(d) {
        const p = svgEl('path', { d, class: 'nato-symbol-glyph' });
        p.setAttribute('stroke', color);
        p.setAttribute('vector-effect', 'non-scaling-stroke');
        glyph.appendChild(p);
    }
    switch (info.arm) {
        case 'infantry': addGlyphPath(`M${-G},${-G} L${G},${G} M${-G},${G} L${G},${-G}`); break; // crossed diagonal X
        case 'cavalry':
            addGlyphPath(`M${-G},${G} L${G},${-G}`); // single diagonal
            g.appendChild((() => { const l = svgEl('line', { x1: -S, y1: S * 0.7 + 3, x2: S, y2: S * 0.7 + 3, class: 'nato-symbol-amplifier' }); l.setAttribute('stroke', color); l.setAttribute('vector-effect', 'non-scaling-stroke'); return l; })()); // mobility (animal) amplifier bar
            break;
        case 'artillery': glyph.appendChild((() => { const c = svgEl('circle', { cx: 0, cy: 0, r: G * 0.6, class: 'nato-symbol-glyph' }); c.setAttribute('fill', color); return c; })()); break; // filled circle
        case 'rocket': addGlyphPath(`M0,${-G} L${G * 0.6},${G} L0,${G * 0.4} L${-G * 0.6},${G} Z`); break; // arrow/missile shape
        case 'engineer': addGlyphPath(`M${-G},${G} L${G},${-G}`); break; // diagonal bar
        case 'medical': addGlyphPath(`M0,${-G} L0,${G} M${-G},0 L${G},0`); break; // cross
        default: break; // 'other'/unmapped - empty frame, no glyph
    }
    if (info.ranged) {
        const dot = svgEl('circle', { cx: 0, cy: -S * 0.7 - 4, r: 2, class: 'nato-symbol-amplifier' });
        dot.setAttribute('fill', color);
        g.appendChild(dot);
    }
    g.appendChild(glyph);

    if (row.rotation_deg != null) {
        const arrow = svgEl('line', { x1: 0, y1: 0, x2: 0, y2: -(S + 8), class: 'nato-symbol-amplifier nato-symbol-direction' });
        arrow.setAttribute('stroke', color);
        arrow.setAttribute('vector-effect', 'non-scaling-stroke');
        g.appendChild(arrow);
    }

    if (row.commander_name) {
        const label = svgEl('text', { x: 0, y: S * 0.7 + 14, 'text-anchor': 'middle', class: 'nato-symbol-label nato-symbol-commander' });
        label.textContent = row.commander_name;
        g.appendChild(label);
    }
    if (row.aux_text) {
        const label = svgEl('text', { x: S + 4, y: 3, class: 'nato-symbol-label nato-symbol-aux' });
        label.textContent = row.aux_text;
        g.appendChild(label);
    }
    return g;
}

// Cheap per-RAF update - position/rotation/scale only, no DOM structure
// rebuild (see buildNatoSymbolElement). `alpha`/`rowB` are only meaningful
// when the query's own @INTERPOLATE is on; rotation blends via
// blendAngleDeg (shortest-angle), not naive linear.
function updateNatoSymbolTransform(g, rowA, rowB, alpha, size) {
    const wx = rowB ? rowA.x + (rowB.x - rowA.x) * alpha : rowA.x;
    const wy = rowB ? rowA.y + (rowB.y - rowA.y) * alpha : rowA.y;
    const screen = worldToScreen(wx, wy);
    if (!screen) return;
    let rot = 0;
    if (rowA.rotation_deg != null) {
        rot = (rowB && rowB.rotation_deg != null) ? blendAngleDeg(rowA.rotation_deg, rowB.rotation_deg, alpha) : rowA.rotation_deg;
    }
    const s = size || 1;
    g.setAttribute('transform', `translate(${screen.x},${screen.y}) rotate(${rot}) scale(${s})`);
}

// renderQueries[i].id -> { tickKey, rowsA: Map(row_key -> row), rowsB: Map,
// elements: Map(row_key -> <g>) }. One entry per currently-enabled
// nato_symbol query - state persists across renderQueries edits by id, same
// convention as renderQueryEditors.
const natoSymbolQueryState = {};

function buildNatoSymbolTickBQuery(sql) {
    return sql.replace(/CURRENT_TICK\(\)/g, 'CURRENT_TICK_B()');
}

// Tick-gated fetch (mirrors refreshChatFromQuery's own gating, just per-
// query and keyed by row_key into a Map instead of a flat row array) - runs
// the query once (or twice, tickA+tickB, if @INTERPOLATE on) only when the
// tick actually changed, never per-RAF.
async function refreshNatoSymbolQuery(q, tickKey) {
    let state = natoSymbolQueryState[q.id];
    if (!state) { state = natoSymbolQueryState[q.id] = { tickKey: null, rowsA: new Map(), rowsB: new Map(), elements: new Map() }; }
    if (state.tickKey === tickKey) return;
    state.tickKey = tickKey;
    try {
        const resA = await runSchemaQueryAsync(q.sql);
        const rowsA = new Map();
        for (const r of resA.rows) rowsA.set(String(r[0]), rowFromNatoColumns(resA.columns, r));
        state.rowsA = rowsA;
        if (q.interpolate) {
            const resB = await runSchemaQueryAsync(buildNatoSymbolTickBQuery(q.sql));
            const rowsB = new Map();
            for (const r of resB.rows) rowsB.set(String(r[0]), rowFromNatoColumns(resB.columns, r));
            state.rowsB = rowsB;
        } else {
            state.rowsB = new Map();
        }
    } catch (e) {
        // Transient (e.g. a reset landed mid-query) - the next tick change retries, same as chat.
    }
}

function rowFromNatoColumns(columns, r) {
    const obj = {};
    columns.forEach((c, i) => { obj[c] = r[i]; });
    obj.x = parseFloat(obj.x); obj.y = parseFloat(obj.y);
    if (obj.unit_type != null) obj.unit_type = parseInt(obj.unit_type, 10);
    if (obj.color_r != null) { obj.color_r = parseFloat(obj.color_r); obj.color_g = parseFloat(obj.color_g); obj.color_b = parseFloat(obj.color_b); }
    if (obj.rotation_deg != null) obj.rotation_deg = parseFloat(obj.rotation_deg);
    if (obj.size != null) obj.size = parseFloat(obj.size);
    return obj;
}

// Called every RAF (from the 'frame' handler, alongside the dots renderSlots
// copy and refreshChatFromQuery) - kicks off the tick-gated fetch above
// (fire-and-forget, async) and does the cheap per-RAF blend/DOM-transform
// update against whatever rows are currently cached (possibly still last
// tick's, while a fetch for the new tick is in flight - exactly the same
// "briefly stale, self-corrects" tradeoff chat already accepts).
function updateNatoSymbolLayer(activeMatchIndex, tickKey, alpha) {
    const layer = document.getElementById('map-symbol-layer');
    if (!layer) return;
    const natoQueries = renderQueries.filter(q => q.kind === 'nato_symbol' && q.enabled);
    if (activeMatchIndex < 0 || natoQueries.length === 0) {
        if (layer.childElementCount > 0) layer.innerHTML = '';
        return;
    }
    for (const q of natoQueries) {
        refreshNatoSymbolQuery(q, tickKey); // fire-and-forget; no-ops if already fetched for this tick
        const state = natoSymbolQueryState[q.id];
        if (!state) continue;
        const seen = new Set();
        for (const [key, rowA] of state.rowsA) {
            seen.add(key);
            const rowB = q.interpolate ? state.rowsB.get(key) : null;
            let g = state.elements.get(key);
            if (!g) {
                g = buildNatoSymbolElement(rowA);
                state.elements.set(key, g);
                layer.appendChild(g);
            }
            updateNatoSymbolTransform(g, rowA, rowB, alpha, rowA.size);
        }
        for (const [key, g] of state.elements) {
            if (!seen.has(key)) { g.remove(); state.elements.delete(key); }
        }
    }
    // Remove stale elements for any nato_symbol query that got disabled/deleted since the last pass.
    for (const id in natoSymbolQueryState) {
        if (!natoQueries.some(q => String(q.id) === id)) {
            for (const g of natoSymbolQueryState[id].elements.values()) g.remove();
            delete natoSymbolQueryState[id];
        }
    }
}

// While true, the camera's visual shift (main.wasm's set_view_shift - a
// RENDER-ONLY offset, never cam_x/cam_y itself, see that function's own
// comment) re-centers on whichever battle is active every time it changes
// (the 'frame' handler below) - i.e. "point at the center of every single
// battle in the file" as long as the user hasn't touched the camera. WASD
// or a canvas drag turns this off (see the keydown/mousemove handlers
// further down main.js), so a manual pan during playback is never fought;
// the "Recenter Camera" menu button turns it back on. Reset true on
// triggerReset so a fresh load starts following again.
let cameraFollowActiveBattle = true;
// Which match index the view is currently shifted to center on - avoids
// redundantly recomputing/reapplying the same shift on every single 'frame'
// message for an unchanged active battle, only on a real change.
let cameraCenteredOnMatchIndex = -1;

// Phase 4: battle export (replay.db+battle.db+manifest.json, tar'd then
// xz-compressed). Export itself runs on playbackWorker (the sole g_db
// writer, see replay_export.c); compression runs in a separate, lazily
// created Worker around compress.wasm so a slow LZMA pass never blocks
// playback message handling on the main replay engine thread.
let exportInFlight = false;
let compressWorker = null;

// Worker orchestration
const WASM_MEMORY_INITIAL_PAGES = 1536;  // 96MiB - must match Makefile's --initial-memory (Phase 6:
                                          // shrunk from 640MiB now that wasm_layout.h's nominal
                                          // per-thread sizes are small enough to actually approach the
                                          // 128MB-floor target - see wasm_layout.h's own comment for
                                          // why smaller nominal sizes lose no real capability.
const WASM_MEMORY_MAX_PAGES = 32768;     // 2GiB - must match Makefile's --max-memory; > initial
                                          // on purpose now, real headroom for heap_extend_threaded
                                          // to grow into (goyslopless-c/lib/heap.c) - initial===max
                                          // would make every grow call fail regardless of whether
                                          // the grow logic itself is correct.
let sharedMemory = null;
let replayModule = null;
let playbackWorker = null; // the loader worker, which continues serving live queries after load
let pendingFrameRequest = false;
let latestFrame = null; // { buffer, count, activeMatchIndex, relativeTime }

// Near-cursor prefetch (YouTube-buffering-style): a dedicated persistent
// worker builds not-yet-visited battles' indexes ahead of the playback
// cursor, so playbackWorker's own self-healing replay_ensure_battle_ready
// call is a cheap no-op by the time the user actually gets there instead of
// paying the one-time index-build cost live. See replay-worker.js's
// 'prefetch' role and replay_worker.c's replay_prefetch_battle(). Purely a
// latency optimization - fetch_positions() is self-healing regardless, so
// nothing here is required for correctness, only for hiding the cold-open
// cost before the cursor arrives.
const PREFETCH_THREAD_ID = 9; // must match WASM_PREFETCH_THREAD_ID in wasm_layout.h
let prefetchWorker = null;
// `prefetchWorker` is assigned synchronously in startPrefetchWorker() (new
// Worker(...) returns immediately), but the worker itself is still mid
// bootstrap()  - awaiting its own OPFS handles, then WebAssembly.instantiate -
// for a while after that. schedulePrefetch() is also called from the 'frame'
// handler below, which fires on essentially every animation frame during
// normal playback - so `!prefetchWorker` alone as a readiness check has a
// real window where a 'frame' response races the worker's own 'ready' and
// posts 'prefetchBattle' before `instance` is set, crashing the worker
// (instance.exports throws on null - surfaced as "[Prefetch Worker Error]
// Cannot read properties of null (reading 'exports')" / Firefox's "can't
// access property 'exports', instance is null" in the system log). Track
// readiness explicitly instead of inferring it from worker-object truthiness.
let prefetchWorkerReady = false;
let prefetchInFlight = false;
let prefetchedBattles = new Set(); // bounds computed (read-only, off playbackWorker)

// Priming is the other half: replay_prefetch_battle() only computes a
// battle's rowid bounds - actually building its index is a WRITE, and
// SQLite's rollback-journal locking only ever lets ONE connection hold that
// role (see the comment on replay_prefetch_battle in replay_worker.c), so it
// has to happen on playbackWorker itself. Sent only once a battle's bounds
// are already known (so playbackWorker's own call skips straight to the
// index build) and only when playbackWorker has no frame request in flight -
// still a visible one-time cost when it runs, but 1-2 battles ahead of the
// cursor instead of exactly when the user arrives.
let primingInFlight = false;
let primedBattles = new Set();

// Battles replay_try_prime_battle() (replay_worker.c) has told us aren't
// worth proactively evicting-for-and-priming right now (see its own
// comment) - pickPrimeTarget() below skips these like an already-primed
// target, otherwise the scheduler would busy-loop re-requesting the same
// declined target every tick. Cleared whenever the ready-battle set
// actually changes (resyncLoadState) - if an eviction happened, a
// previously-declined target might be worth reconsidering now.
let declinedPrimingBattles = new Set();

// Mirrors primingInFlight/primedBattles/declinedPrimingBattles exactly, but
// for replay_prewarm_battle_summary() (replay_export.c) - the roster/corpse
// summary cache's own proactive pre-warm, sharing g_priming_budget_bytes
// with agent_states priming above but tracked separately here since a
// battle can be index-primed without its summary being cached yet, or vice
// versa (an already-cached summary surviving an index eviction). Reset in
// triggerReset() alongside the other three, same reasoning.
let summaryPrewarmInFlight = false;
let cachedSummaryBattles = new Set();
let declinedSummaryPrewarmBattles = new Set();

const glObjects = { programs: [], shaders: [], buffers: [], uniforms: [] };

// Reader workers (startBoundsComputation) are otherwise only ever referenced
// by the local closure that creates each one - already gracefully
// terminated the moment they report done/error, but with no way to reach
// any still-running ones from outside that closure. Tracked here purely so
// the pagehide handler below can also ask them to release their OPFS
// handles if the tab closes mid-bounds-computation, the one window where
// they'd otherwise be abandoned with no cleanup attempt at all.
const activeReaderWorkers = new Set();

// Resolves once any in-flight worker teardown from a previous
// triggerReset() has actually finished closing its OPFS handles.
// startReplayLoad()/beginBattleFileWorkerLoad() chain off this before
// spawning the next load's workers - otherwise a fast reset-then-reload
// (or export-then-reload) could still start the new load's
// createSyncAccessHandle() calls before the old ones finish closing,
// recreating the exact race gracefulTerminateWorker exists to close.
let pendingWorkerTeardown = Promise.resolve();

// Every replay-worker.js instance (any role) opens its own
// FileSystemSyncAccessHandle on the shared, fixed-name OPFS file backing
// the loaded replay (see replay-worker.js's OPFS_MAIN_DB_NAME comment).
// Worker.terminate() does NOT guarantee that lock is released before it
// returns - release-on-termination is implementation-timing-dependent, not
// spec-guaranteed - so a fast reset-then-reload could have the NEW worker's
// createSyncAccessHandle() on that same filename race the OLD worker's not-
// yet-finished teardown and fail with NoModificationAllowedError ("No
// modification allowed"). Ask the worker to close its own handles first
// (deterministic, spec-guaranteed) and wait for it to confirm before
// terminating - the setTimeout is only a safety net for a hung/crashed
// worker that never acks, not the normal path.
function gracefulTerminateWorker(worker, timeoutMs) {
    return new Promise((resolve) => {
        if (!worker) { resolve(); return; }
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            worker.onmessage = null;
            worker.onerror = null;
            worker.terminate();
            resolve();
        };
        worker.onmessage = (e) => {
            if (e.data && e.data.type === 'shutdownComplete') finish();
        };
        worker.onerror = finish;
        worker.postMessage({ type: 'shutdown' });
        setTimeout(finish, timeoutMs || 2000);
    });
}

// Best-effort OPFS handle release on tab close/navigate-away - NOT a
// guarantee, and can't be one: 'pagehide' handlers get a real but bounded
// window to do synchronous work, and postMessage is asynchronous, so there's
// no way to confirm (let alone wait for, from the main thread - Atomics.wait
// is disallowed outside a worker) that a worker actually received and
// processed this before the browser tears the tab down, especially on a
// hard close rather than an in-tab navigation. Still worth doing: the
// worker's own 'shutdown' handler (replay-worker.js's onmessage) is fully
// synchronous - shuttingDown=true, closeAllOpfsHandles(), postMessage - no
// awaits at all - so if the message is delivered before teardown, the OPFS
// handle genuinely does get closed in time, same guaranteed-deterministic
// release gracefulTerminateWorker already relies on for the in-app reset
// path. This is what that same path doesn't cover: a plain tab close/
// navigate never goes through triggerReset()'s explicit teardown at all,
// leaving the OUTGOING tab's handle to whatever the browser's own implicit
// worker cleanup timing happens to do - which is exactly the scenario a
// stale "createSyncAccessHandle failed... No modification allowed" on a
// LATER, unrelated tab's load traces back to.
window.addEventListener('pagehide', () => {
    if (playbackWorker) playbackWorker.postMessage({ type: 'shutdown' });
    if (prefetchWorker) prefetchWorker.postMessage({ type: 'shutdown' });
    for (const w of activeReaderWorkers) w.postMessage({ type: 'shutdown' });
});

function triggerReset() {
    document.getElementById('file-input').value = "";
    uploadOverlay.style.display = 'flex';
    document.getElementById('hamburger-container').style.display = 'none';
    closeMainMenu();
    resetBtn.style.display = 'none';
    document.getElementById('export-btn').style.display = 'none';
    removeTimelineUI();
    currentSimulationState = "AWAITING_FILE";

    const outgoingPlayback = playbackWorker;
    const outgoingPrefetch = prefetchWorker;
    playbackWorker = null;
    prefetchWorker = null;
    prefetchWorkerReady = false;
    pendingWorkerTeardown = Promise.all([
        gracefulTerminateWorker(outgoingPlayback),
        gracefulTerminateWorker(outgoingPrefetch),
    ]).then(() => {
        appendToConsoleLog("[System] Previous session's workers released.");
    });
    prefetchedBattles = new Set();
    prefetchInFlight = false;
    primedBattles = new Set();
    primingInFlight = false;
    declinedPrimingBattles = new Set();
    cachedSummaryBattles = new Set();
    summaryPrewarmInFlight = false;
    declinedSummaryPrewarmBattles = new Set();
    sharedMemory = null;
    matches = [];
    timelineLoadBars = [];
    latestFrame = null;
    cameraFollowActiveBattle = true;
    cameraCenteredOnMatchIndex = -1;
    // Any SQL/schema request queued or in flight against the outgoing
    // playbackWorker will never get a response (same reasoning as
    // pendingFrameRequest below) - drop them rather than leaving whichever
    // window(s) issued them stuck showing "Running.../Queued..." forever
    // after a fresh load starts.
    activeSqlRequest = null;
    sqlRequestQueue.length = 0;
    knownSchemas = {};
    knownSchemasBootstrapped = false;
    // A frame request can genuinely be in flight to the outgoing
    // playbackWorker right when reset happens (the render loop posts one on
    // essentially every animation frame - see the 'loop' function far below)
    // - that worker is going away and will never send the matching 'frame'
    // response back (the only other place this flips false, ~line 946).
    // Left set, this permanently wedges the render loop's `if
    // (!pendingFrameRequest)` gate shut for the NEXT load too: no frame
    // ever gets requested again, so latestFrame never updates again either.
    // Confirmed via testdata/ui_behavior_tests.js's rapid reset->reload
    // check, which reproduces this reliably (a fresh load's own render loop
    // ticks fast enough that a request is almost always in flight the
    // instant a reset fires).
    pendingFrameRequest = false;
    lastChatQueryKey = null; // force the next 'frame' to re-query chat, not skip it as "unchanged"
    knownCheckpointIds = [];
    currentCheckpointId = null;
    refreshAllCheckpointDropdowns();

    panelContentElements('chat-box').forEach((el) => { el.innerHTML = '<div>System: Chat initialized...</div>'; });
    appendToConsoleLog("[System] Reset complete. Select a new sqlite database.");
}

// Hamburger menu (replaces the old always-floating #reset-btn/#export-btn
// corner buttons - see main.css's #hamburger-container comment for why).
function toggleMainMenu(event) {
    event.stopPropagation(); // don't let the outside-click listener below immediately re-close it
    document.getElementById('main-menu').classList.toggle('open');
}

function closeMainMenu() {
    document.getElementById('main-menu').classList.remove('open');
}

// The hamburger menu is "just another window" for stacking purposes, same
// as every .ui-panel (see wirePanelInstance's identical mousedown listener) -
// it used to sit at a fixed CSS z-index (12), which panelZIndexCounter (see
// its own declaration below) climbs past after only one or two panel clicks
// in any session, permanently burying the menu behind whatever was clicked
// last instead of coming to front when IT'S clicked. Capture phase so this
// still fires even though main-menu's own buttons call stopPropagation() in
// places (closeMainMenu() on click) - matches wirePanelInstance's own
// reasoning exactly.
document.getElementById('hamburger-container').addEventListener('mousedown', () => {
    document.getElementById('hamburger-container').style.zIndex = String(++panelZIndexCounter);
}, true);

// Backs the hamburger menu's Panels checkboxes (main.html's
// #menu-panels-section, debug-mode only). One-directional: the checkbox
// drives the panel, nothing else hides/shows these panels after the initial
// DEBUG_MODE default above, so there's no state to keep in sync the other way.
//
// Every checked-on panel spawns top-right, staggered by how many of the
// other toggleable panels are already visible at that moment - so checking
// two or three of these at once doesn't pile them on top of each other, and
// re-checking one you'd previously dragged elsewhere brings it back
// somewhere findable instead of leaving it wherever it was hidden.
const TOGGLEABLE_PANEL_IDS = ['log-box', 'debug-panel', 'sql-terminal-panel', 'schema-explorer-panel', 'sql-docs-panel', 'render-queries-panel'];

// Every panel TYPE that supports opening additional, fully independent
// windows (main.js's openNewPanelInstance) - the original element already in
// main.html (found by this literal id, kept ONLY for this one lookup) plus
// any number of clones. Includes chat-box, which isn't in
// TOGGLEABLE_PANEL_IDS above (chat has no show/hide checkbox - it's always
// visible - but can still be duplicated).
const PANEL_TYPES = ['chat-box', 'log-box', 'debug-panel', 'sql-terminal-panel', 'schema-explorer-panel', 'sql-docs-panel', 'render-queries-panel'];

// Every currently-open panel's own .panel-zoom-wrap (main.js's
// ensurePanelZoomWrap - NOT .panel-content directly, which would bypass the
// zoom boundary entirely: content appended straight into .panel-content
// would render as a sibling of the wrap, at its un-zoomed size, unreachable
// by Ctrl+Scroll) for every currently-open window of a given type (original
// + any open clones) - used by the "broadcast" panels (Chat, System Logs)
// whose content is one shared feed, not per-window state: a second Chat/Log
// window should mirror the exact same messages, not show nothing until
// something new happens to fire specifically at it.
function panelContentElements(type) {
    return Array.from(document.querySelectorAll(`[data-panel-type="${type}"] > .panel-content`))
        .map((content) => ensurePanelZoomWrap(content));
}

function setPanelVisible(panelId, visible) {
    const panel = document.getElementById(panelId);
    if (visible) {
        const alreadyVisible = TOGGLEABLE_PANEL_IDS.filter(
            (id) => id !== panelId && getComputedStyle(document.getElementById(id)).display !== 'none'
        ).length;
        const offset = alreadyVisible * 30;
        panel.style.top = (20 + offset) + 'px';
        panel.style.right = (20 + offset) + 'px';
        panel.style.left = 'auto';
        panel.style.bottom = 'auto';
        panel.style.zIndex = String(++panelZIndexCounter); // bring the newly-shown panel to front too
        // Schema explorer should load itself the moment it's shown, not sit
        // there empty until the user finds and clicks "Refresh" - the button
        // stays for a manual re-sync later, it just isn't required up front.
        if (panelId === 'schema-explorer-panel') refreshSchemaExplorerPanel(panel);
    }
    panel.style.display = visible ? 'flex' : 'none';
}

document.addEventListener('click', (e) => {
    const menu = document.getElementById('main-menu');
    if (menu.classList.contains('open') && !document.getElementById('hamburger-container').contains(e.target)) {
        closeMainMenu();
    }
});

// Tracks each panel's user-resized content height (px), if any - keyed by
// the content ELEMENT itself (not an id string - a clone shares no id with
// its original, and a WeakMap keyed by element needs no manual cleanup when
// a clone is closed/removed, unlike a Map keyed by a string that would leak
// forever). Read here so un-minimizing restores whatever height the user
// last dragged to, instead of snapping back to main.css's plain default
// every time.
const panelResizedHeight = new WeakMap();

// A panel is in exactly one of three modes - 'normal', 'minimized',
// 'maximized'. Each of the two non-normal modes has its OWN independent
// "restore" memory - panelMinRestore ('normal'|'maximized': what un-
// minimizing goes to) and panelMaxRestore ('normal'|'minimized': what un-
// maximizing goes to) - each written ONLY by its own button's click handler
// and NEVER touched by the other button:
//   - clicking a mode's own button while ALREADY in that mode restores
//     whatever THAT mode's own map remembered (or 'normal' if nothing was);
//   - clicking it from any other mode (including the OTHER non-normal mode -
//     a direct minimized<->maximized jump) enters that mode, recording
//     whatever mode is being left into THAT button's OWN map only.
//
// This used to be a SINGLE shared restoreMode map (one slot doing double
// duty for both buttons), which is a real, hand-hit bug, not a hypothetical
// one: minimize a panel, then click maximize directly (without un-
// minimizing first) - a completely ordinary thing to do, since the header
// with both buttons stays visible while collapsed. That jump overwrites the
// one shared slot with 'minimized' (clobbering the 'normal' it needed to
// remember), and every later click alternates between the two non-normal
// modes forever - the panel's original small window becomes permanently
// unreachable through the buttons, which reads exactly like "maximize
// doesn't work" (it LOOKS like it's toggling something, just never back to
// where the user started). Splitting the memory in two - one slot the
// minimize button owns, one the maximize button owns, neither ever
// clobbering the other - fixes this while still reproducing the two cases a
// naive "minimize and maximize are fully independent flags" implementation
// gets wrong: clicking maximize while "minimized, remembered-maximized"
// must go to a fully visible fullscreen panel (not toggle some independent
// maximized flag off), and clicking maximize again from THERE must go back
// to "minimized, remembered-maximized" (a full-width collapsed header)
// rather than snapping all the way back to the small pre-maximize rect -
// the rect only actually needs to move at the two moments the fullscreen-
// ness of the CURRENT rect actually changes, tracked below as
// isRectFullscreen(). Verified by hand against all 10 (2 buttons x 5
// reachable (mode, own-restore-value) combinations) transitions - see
// transitionPanel's own comment.
const panelMinRestore = new WeakMap(); // panel -> 'normal' | 'maximized' - what the minimize button's OWN toggle-back goes to; meaningful only while minimized, set only by a minimize click
const panelMaxRestore = new WeakMap(); // panel -> 'normal' | 'minimized' - what the maximize button's OWN toggle-back goes to; meaningful only while maximized, set only by a maximize click
const panelSavedRect = new WeakMap(); // panel -> {top,left,right,bottom,width} - the true home rect, saved only while away from it

function getPanelMode(panel) {
    if (panel.classList.contains('minimized')) return 'minimized';
    if (panel.classList.contains('maximized')) return 'maximized';
    return 'normal';
}

// minRestoreValue is panelMinRestore's OWN value - only ever consulted when
// mode==='minimized' (the maximized case short-circuits regardless), so
// callers pass panelMinRestore.get(panel) specifically, never panelMaxRestore.
function isRectFullscreen(mode, minRestoreValue) {
    return mode === 'maximized' || (mode === 'minimized' && minRestoreValue === 'maximized');
}

function applyNormalContentSize(content) {
    const resized = panelResizedHeight.get(content);
    if (resized) {
        content.style.minHeight = resized + 'px';
        content.style.maxHeight = resized + 'px';
        // Explicit height, not just equal min/max-height: min/max alone
        // pin the box's own visual size identically in every browser, but
        // per spec do NOT make it a "definite" height for a percentage-
        // height CHILD to resolve against (main.css's .panel-zoom-wrap
        // height:100% chain, used by the SQL Terminal's results table and
        // the generator-script pop-out's editor area) - Chrome resolves it
        // anyway, Firefox strictly doesn't, which is exactly the "editor
        // doesn't fill/resize with the window in Firefox" bug this fixes.
        content.style.height = resized + 'px';
    } else if (content.classList.contains('chat-content')) {
        content.style.minHeight = '';
        content.style.maxHeight = '424px';
        content.style.height = '';
    } else {
        content.style.minHeight = '';
        content.style.maxHeight = ''; // main.css's plain 150px default (or a panel-type-specific override, e.g. the generator-script pop-out's fixed height)
        content.style.height = '';
    }
}

function applyContentForMode(content, mode) {
    if (mode === 'minimized') {
        content.style.minHeight = '0px';
        content.style.maxHeight = '0px';
        content.style.height = '0px';
        // box-sizing:border-box makes `height` set the TOTAL border-box
        // height, but a browser will never render less than padding+border
        // regardless - without this, the 12px top/bottom padding alone
        // still forces a 24px-tall box even with height:0 (confirmed
        // directly: exactly 24px, exactly 2x the 12px padding). Left/right
        // untouched - only the vertical padding needs to collapse.
        content.style.paddingTop = '0';
        content.style.paddingBottom = '0';
    } else if (mode === 'maximized') {
        content.style.minHeight = '0';
        content.style.maxHeight = 'none';
        content.style.height = 'auto';
        content.style.paddingTop = '';
        content.style.paddingBottom = '';
    } else {
        content.style.paddingTop = '';
        content.style.paddingBottom = '';
        applyNormalContentSize(content);
    }
}

// The one function both buttons call through - see the state-machine
// comment above transitionPanel's supporting helpers for the reasoning.
// button is 'minimize' or 'maximize'.
//
// Hand-verified against all 10 reachable (mode, button) transitions - the 3
// modes x each non-normal mode's 2 possible own-restore-values gives 5
// distinct starting situations, x2 buttons:
//   normal + minimize -> minimized, minRestore='normal' (span untouched,
//     collapses in place)
//   normal + maximize -> maximized, maxRestore='normal' (saves rect, span
//     -> fullscreen)
//   (minimized, minRestore=normal) + minimize -> normal (toggle-back; span
//     untouched, un-collapses)
//   (minimized, minRestore=normal) + maximize -> maximized,
//     maxRestore='minimized' (saves rect - the true small rect, since the
//     span never moved while merely minimized - span -> fullscreen; THE fix
//     for the "minimize then maximize directly" bug above: minRestore stays
//     'normal', untouched, so a later minimize-button click can still find
//     its way back to the small window instead of bouncing forever)
//   (minimized, minRestore=maximized) + minimize -> maximized (toggle-back;
//     span untouched, already fullscreen; un-collapses)
//   (minimized, minRestore=maximized) + maximize -> maximized,
//     maxRestore='minimized' (span untouched, already fullscreen;
//     un-collapses - "a fully visible fullscreen panel", matching the
//     documented requirement)
//   (maximized, maxRestore=normal) + maximize -> normal (toggle-back;
//     restores the true saved rect)
//   (maximized, maxRestore=normal) + minimize -> minimized,
//     minRestore='maximized' (span untouched, already fullscreen; collapses
//     - "minimized, remembered-maximized", a full-width collapsed header)
//   (maximized, maxRestore=minimized) + maximize -> minimized (toggle-back;
//     span untouched, already fullscreen; collapses - back to "minimized,
//     remembered-maximized", matching the documented requirement)
//   (maximized, maxRestore=minimized) + minimize -> minimized,
//     minRestore='maximized' (span untouched; collapses)
function transitionPanel(panel, content, button) {
    const oldMode = getPanelMode(panel);
    const isMinimize = button === 'minimize';
    const myMode = isMinimize ? 'minimized' : 'maximized';
    // The button being clicked only ever reads/writes ITS OWN map - this is
    // the whole fix: a maximize click can never clobber what the minimize
    // button remembers, and vice versa, no matter how many times the two
    // are interleaved.
    const myRestoreMap = isMinimize ? panelMinRestore : panelMaxRestore;

    const wasFullscreen = isRectFullscreen(oldMode, panelMinRestore.get(panel));

    let newMode;
    if (oldMode === myMode) {
        // Toggle back: restore whatever THIS button's own map remembered.
        newMode = myRestoreMap.get(panel) || 'normal';
    } else {
        // Entering myMode fresh - from 'normal', or a direct cross-jump from
        // the OTHER non-normal mode - record what's being left, in THIS
        // button's own map only.
        newMode = myMode;
        myRestoreMap.set(panel, oldMode);
    }

    const willBeFullscreen = isRectFullscreen(newMode, panelMinRestore.get(panel));

    // top/left/right/width - the panel's SPAN - follow the fullscreen-vs-
    // home family above (this is what makes "minimize while maximized,
    // then maximize again" land back on the SAME full-width collapsed
    // header instead of snapping to the small pre-maximize rect and back).
    if (!wasFullscreen && willBeFullscreen) {
        panelSavedRect.set(panel, { top: panel.style.top, left: panel.style.left, right: panel.style.right, width: panel.style.width });
        panel.style.top = '10px';
        panel.style.left = '10px';
        panel.style.right = '10px';
        panel.style.width = 'auto';
    } else if (wasFullscreen && !willBeFullscreen) {
        const saved = panelSavedRect.get(panel) || {};
        panel.style.top = saved.top || '';
        panel.style.left = saved.left || '';
        panel.style.right = saved.right || '';
        panel.style.width = saved.width || '';
        panelSavedRect.delete(panel);
    }
    // else the span is already correct for the new mode - left untouched.

    // bottom is handled completely separately from the span above, and
    // deliberately isn't part of panelSavedRect: it must track whether
    // content is ACTUALLY being shown fullscreen right now, not which span
    // family (home-width vs fullscreen-width) the panel currently borrows
    // its width from. A real, hand-reported bug this way: leaving a prior
    // maximize's bottom:10px in place while minimized (even "minimized,
    // remembers maximized") pins the PANEL's own box to the bottom of the
    // screen, leaving a big empty square below the collapsed header instead
    // of the header collapsing - a minimized panel must always shrink to
    // just its header's natural height, regardless of how wide it's
    // currently showing. 'auto' (not '') matches the value makeDraggable/
    // makeResizable already use elsewhere for "not bottom-anchored".
    panel.style.bottom = newMode === 'maximized' ? '10px' : 'auto';

    panel.classList.remove('minimized', 'maximized');
    if (newMode !== 'normal') panel.classList.add(newMode);
    // No explicit restore-map write here - myRestoreMap.set() above already
    // recorded the right value at the moment newMode was decided (only on a
    // fresh entry; a toggle-back deliberately leaves it as-is, see this
    // function's own comment on why that's safe - it'll be overwritten
    // correctly the next time this mode is entered fresh, and is never read
    // in between).

    const icon = panel.querySelector('.toggle-icon');
    if (icon) icon.innerText = newMode === 'minimized' ? '+' : '-';
    const maxBtn = panel.querySelector(':scope > .panel-header .panel-maximize-btn');
    if (maxBtn) maxBtn.title = newMode === 'maximized' ? 'Restore window' : 'Maximize window';

    applyContentForMode(content, newMode);
}

function toggleMinimize(content) {
    transitionPanel(content.parentElement, content, 'minimize');
}

function toggleMaximize(panel, content) {
    transitionPanel(panel, content, 'maximize');
}

// Panels (chat/log/VFS-trace/SQL-terminal/schema-explorer/docs) used to have
// fixed positions the app tried to keep from overlapping (a stacking
// container, individually hand-picked corners, etc.) - that approach kept
// needing revisiting every time a new panel showed up. Dragging is the
// actual fix: the user resolves any overlap themselves, once, by moving the
// panel where they want it.
//
// Both makeDraggable and makeResizable below take real ELEMENTS, not id
// strings - the same functions wire up the 6 original singleton panels
// AND every clone opened via openNewPanelInstance, so there is exactly one
// implementation of drag/resize/minimize/close behavior, not one per
// instance. Attaches to a panel's .panel-header - mousedown-and-move
// repositions the panel (converting its CSS anchor from right/bottom to
// left/top, in viewport pixels, clamped so the header can't be dragged fully
// offscreen); a plain click with no real movement still toggles minimize.
let panelZIndexCounter = 11; // one above .ui-panel's base z-index:10
function makeDraggable(panel, content) {
    const header = panel.querySelector(':scope > .panel-header');
    let dragging = false;
    let moved = false;
    let startX = 0, startY = 0, startLeft = 0, startTop = 0;

    header.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return; // left button only
        if (e.target.closest('.panel-close-btn')) return; // close button handles its own click, not a drag start
        if (e.target.closest('.panel-maximize-btn')) return; // maximize button handles its own click, not a drag start
        // Deliberately still sets dragging=true even while maximized - the
        // guard against actually MOVING a maximized panel (there's nothing
        // meaningful to drag it to) lives in mousemove below, not here.
        // Bailing out this early instead would have also skipped mouseup's
        // "no real movement happened -> toggleMinimize" path below, since
        // that's implemented as a special case of THIS SAME dragging state
        // machine - confirmed as a real regression this way: a maximized
        // panel's minimize button stopped doing anything at all, not just
        // its drag.
        dragging = true;
        moved = false;
        const rect = panel.getBoundingClientRect();
        startX = e.clientX;
        startY = e.clientY;
        startLeft = rect.left;
        startTop = rect.top;
        e.preventDefault(); // avoid text selection while dragging
    });

    window.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (!moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
            moved = true;
        }
        if (!moved) return;

        // Dragging a MAXIMIZED panel un-maximizes it first, at its CURRENT
        // (fullscreen) footprint - not the older pre-maximize rect a real
        // maxBtn click would restore to - then falls through to the normal
        // repositioning below so it follows the cursor from there, same as
        // dragging a maximized window's titlebar in a real OS. The content
        // height is preserved the same way a manual resize would be
        // (panelResizedHeight - applyContentForMode's 'normal' branch
        // already reads this), so un-maximizing via drag doesn't also
        // shrink the content back to the plain default height.
        if (panel.classList.contains('maximized')) {
            const rect = panel.getBoundingClientRect();
            const contentRect = content.getBoundingClientRect();
            panelResizedHeight.set(content, contentRect.height);
            panel.classList.remove('maximized');
            panelMinRestore.delete(panel);
            panelMaxRestore.delete(panel);
            panelSavedRect.delete(panel);
            panel.style.width = rect.width + 'px';
            panel.style.bottom = 'auto';
            const maxBtn = panel.querySelector(':scope > .panel-header .panel-maximize-btn');
            if (maxBtn) maxBtn.title = 'Maximize window';
            applyContentForMode(content, 'normal');
        }

        // A MINIMIZED panel (a collapsed header bar) CAN be dragged - it
        // isn't blocked like a truly maximized one above - but if it's
        // currently "minimized, remembers maximized" (panelMinRestore=
        // 'maximized'), manually repositioning that header bar makes that
        // memory stale: without this, de-minimizing afterward would restore
        // 'maximized' anyway (transitionPanel trusts the remembered mode,
        // not the actual rendered rect), landing on the SAME fullscreen box
        // this drag just moved AWAY from - a real, hand-reported bug this
        // way ("bugged maximized mode"). Dragging is exactly the user
        // action that should sever that memory: from here on this panel is
        // just a plain minimized panel at its own new position, remembering
        // 'normal' like any other - the drag becomes its new home rect.
        if (panel.classList.contains('minimized')) {
            panelMinRestore.delete(panel);
            panelMaxRestore.delete(panel);
            panelSavedRect.delete(panel);
        }

        const maxLeft = Math.max(0, window.innerWidth - panel.offsetWidth);
        const maxTop = Math.max(0, window.innerHeight - header.offsetHeight);
        const newTop = Math.max(0, Math.min(maxTop, startTop + dy));
        panel.style.left = Math.max(0, Math.min(maxLeft, startLeft + dx)) + 'px';
        panel.style.top = newTop + 'px';
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
        // Only the ORIGINAL chat-box instance is bottom-anchored (see
        // reanchorChatBottom below) - a cloned chat window (openNewPanelInstance)
        // is a plain floating panel like any other, positioned wherever the
        // user drags/resizes it, not tied to the timeline controller's edge.
        if (panel.id === 'chat-box') chatBottomAnchor = newTop + panel.offsetHeight;
    });

    window.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        if (!moved) toggleMinimize(content); // plain click - same as the old onclick
    });
}

// 8 resize hit-zones per panel (main.css's .resize-handle.{n,s,e,w,ne,nw,se,sw}),
// independent of makeDraggable's header-drag-to-move above - the header
// moves the panel, these resize it, same split as a real OS window. Each
// zone drags only the edges its direction implies: e/w change width, n/s
// change .panel-content's height (the panel itself has no explicit height -
// flexbox sizes it from header + content, and content's min/max-height,
// forced equal, is what actually forces a real box size instead of just
// capping one - see toggleMinimize's comment above for why both are always
// set together). Dragging the TOP or LEFT edge also has to move the panel's
// own top/left so the edge under the cursor actually follows it (the
// opposite edge stays put) rather than only ever growing down-right.
const MIN_PANEL_WIDTH = 200;
const MIN_CONTENT_HEIGHT = 60;
const RESIZE_DIRS = [
    { cls: 'n', top: true },
    { cls: 's', bottom: true },
    { cls: 'e', right: true },
    { cls: 'w', left: true },
    { cls: 'ne', top: true, right: true },
    { cls: 'nw', top: true, left: true },
    { cls: 'se', bottom: true, right: true },
    { cls: 'sw', bottom: true, left: true },
];
function makeResizable(panel, content) {
    RESIZE_DIRS.forEach((dir) => {
        const handle = document.createElement('div');
        handle.className = 'resize-handle ' + dir.cls;
        panel.appendChild(handle);

        let resizing = false;
        let startX = 0, startY = 0, startRect = null, startContentHeight = 0;

        handle.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return; // left button only
            if (panel.classList.contains('minimized')) return; // nothing to resize while collapsed
            if (panel.classList.contains('maximized')) return; // a maximized window fills the screen - nothing meaningful to resize it to
            resizing = true;
            startX = e.clientX;
            startY = e.clientY;
            startRect = panel.getBoundingClientRect();
            startContentHeight = content.offsetHeight;
            content.style.transition = 'none'; // that transition is for the minimize animation, not a live drag
            e.preventDefault(); // avoid text selection while dragging
            e.stopPropagation(); // don't let this bubble into anything header-drag-related
        });

        window.addEventListener('mousemove', (e) => {
            if (!resizing) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;

            if (dir.right || dir.left) {
                let newWidth = dir.right ? startRect.width + dx : startRect.width - dx;
                newWidth = Math.max(MIN_PANEL_WIDTH, Math.min(newWidth, window.innerWidth - 10));
                panel.style.width = newWidth + 'px';
                if (dir.left) {
                    const newLeft = Math.max(0, startRect.right - newWidth);
                    panel.style.left = newLeft + 'px';
                    panel.style.right = 'auto';
                }
            }

            if (dir.bottom || dir.top) {
                // headerHeight (header + panel's own border) is constant
                // through the drag - only content's own box actually resizes.
                const headerHeight = startRect.height - startContentHeight;
                let newContentHeight = dir.bottom ? startContentHeight + dy : startContentHeight - dy;
                newContentHeight = Math.max(MIN_CONTENT_HEIGHT, newContentHeight);
                if (dir.top) {
                    // top edge follows the cursor - clamp so it can't push
                    // past the bottom edge staying in view.
                    const maxContentHeight = startRect.bottom - headerHeight - 10;
                    newContentHeight = Math.min(newContentHeight, Math.max(MIN_CONTENT_HEIGHT, maxContentHeight));
                    const newTop = startRect.bottom - headerHeight - newContentHeight;
                    panel.style.top = Math.max(0, newTop) + 'px';
                    panel.style.bottom = 'auto';
                } else {
                    const maxContentHeight = window.innerHeight - startRect.top - headerHeight - 10;
                    newContentHeight = Math.min(newContentHeight, Math.max(MIN_CONTENT_HEIGHT, maxContentHeight));
                }
                content.style.minHeight = newContentHeight + 'px';
                content.style.maxHeight = newContentHeight + 'px';
                // See toggleMinimize's comment on the same pattern: equal
                // min/max-height alone isn't a "definite" height for a
                // percentage-height child to resolve against in Firefox.
                content.style.height = newContentHeight + 'px';
                panelResizedHeight.set(content, newContentHeight);
                // Only the ORIGINAL chat-box instance is bottom-anchored (see
                // reanchorChatBottom below) - an independent ResizeObserver
                // there re-derives `top` from this anchor on every size
                // change, which is exactly right for a TOP-edge drag (bottom
                // should stay put) but would fight a BOTTOM-edge drag (which
                // needs the anchor itself to move down with the cursor, top
                // staying put) - keeping the anchor in sync with wherever
                // this drag just put the bottom edge, the same way
                // makeDraggable already does, makes both directions correct
                // instead of only one.
                if (panel.id === 'chat-box') chatBottomAnchor = panel.getBoundingClientRect().bottom;
            }
        });

        window.addEventListener('mouseup', () => {
            if (!resizing) return;
            resizing = false;
            content.style.transition = '';
        });
    });
}

// Makes a panel root behave like a real window: drag-to-move + click-to-
// minimize, 8-direction resize, and a close button - the one function shared
// by every panel instance, original or cloned, of any of the 6 types in
// PANEL_TYPES. A close click on the ORIGINAL singleton (still carrying its
// literal main.html id - clones never do, see openNewPanelInstance) hides it
// and unchecks its hamburger checkbox, exactly like unchecking the checkbox
// itself; a close click on a clone actually removes it from the document.
function wirePanelInstance(panel) {
    const header = panel.querySelector(':scope > .panel-header');
    const content = panel.querySelector(':scope > .panel-content');
    makeDraggable(panel, content);
    makeResizable(panel, content);
    ensurePanelZoomWrap(content);

    // Click ANYWHERE on a window - not just its header (drag) or its resize
    // handles, the only two spots that used to bump z-index - and it comes
    // to front, matching every real OS window manager. Capture phase, not
    // bubble: several descendants (the close button, each resize handle)
    // call stopPropagation() on their own mousedown to stop it reaching a
    // header-drag/other handler, which would otherwise also block this from
    // ever seeing those clicks; capture fires top-down before any of that
    // can happen, so nothing inside the panel needs to know this exists.
    panel.addEventListener('mousedown', () => {
        panel.style.zIndex = String(++panelZIndexCounter);
    }, true);

    const closeBtn = header.querySelector('.panel-close-btn');
    closeBtn.addEventListener('mousedown', (e) => e.stopPropagation()); // don't also start a header drag
    closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closePanelInstance(panel);
    });

    const maximizeBtn = header.querySelector('.panel-maximize-btn');
    maximizeBtn.addEventListener('mousedown', (e) => e.stopPropagation()); // don't also start a header drag
    maximizeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleMaximize(panel, content);
    });
}

// Ctrl+Scroll over a window's content zooms its text (and everything else
// in that box - CSS `zoom` scales the whole rendered subtree, not just
// font-size, which is what actually makes bigger text possible here: nearly
// every rule in this stylesheet sets an explicit px font-size rather than
// inheriting one, so changing a parent's font-size alone wouldn't reach any
// of them).
//
// Critical: `zoom` is applied to a plain WRAPPER div inserted INSIDE
// .panel-content (ensurePanelZoomWrap, below) - NEVER to .panel-content
// itself. .panel-content is the element with the real box constraints
// (main.css's `max-height: 174px`, plus whatever inline min/max-height a
// resize or minimize/restore has set) - `zoom` scales EVERY length on the
// zoomed element, including its own max-height, so zooming .panel-content
// directly would grow that cap right along with the text, visibly resizing
// the whole panel on every scroll tick instead of just its text (confirmed
// directly: zoom:1.5 on .panel-content grew its rendered box by 1.5x).
// The wrapper has no size opinion of its own, so .panel-content's existing
// overflow-y:auto - completely untouched by any of this - just clips/
// scrolls the now-larger wrapper exactly like any other overflowing
// content, while the panel's own on-screen footprint never moves.
//
// The actual wheel LISTENER for this lives on `window`, not here (see the
// wheel handler further down that already exists to keep scrolling over a
// panel from zooming the 3D camera) - NOT one listener per panel's own
// .panel-content. A per-content listener has a real gap: the 8 resize-handle
// divs (main.css's .resize-handle) are SIBLINGS of .panel-content, not
// descendants of it, positioned with negative offsets straddling the
// panel's border specifically so they're reachable near the edges - a wheel
// event landing on one of those (easy near a panel's top/bottom edge) would
// never bubble through .panel-content at all, so a per-content listener's
// preventDefault would simply never run, letting Firefox's native Ctrl+
// Scroll page-zoom through unimpeded right at exactly the spot a user's
// cursor commonly ends up. One shared listener scoped to `.ui-panel` (which
// wraps both .panel-content AND the resize handles) closes that gap - see
// its own comment below.
const TEXT_ZOOM_MIN = 0.6;
const TEXT_ZOOM_MAX = 2.5;
const TEXT_ZOOM_STEP = 0.1;
function applyTextZoomDelta(zoomWrap, deltaY) {
    const current = parseFloat(zoomWrap.style.zoom) || 1;
    const next = Math.max(TEXT_ZOOM_MIN, Math.min(TEXT_ZOOM_MAX, current + (deltaY < 0 ? TEXT_ZOOM_STEP : -TEXT_ZOOM_STEP)));
    zoomWrap.style.zoom = next.toFixed(2);
}

// Moves .panel-content's current children into a new .panel-zoom-wrap child
// (once - idempotent, since a CLONED panel via openNewPanelInstance already
// has the wrap baked into its copied markup and must reuse it, not nest a
// second one inside the first). Returns the wrap element, which is what
// applyTextZoomDelta actually operates on.
function ensurePanelZoomWrap(content) {
    let wrap = content.querySelector(':scope > .panel-zoom-wrap');
    if (!wrap) {
        wrap = document.createElement('div');
        wrap.className = 'panel-zoom-wrap';
        while (content.firstChild) wrap.appendChild(content.firstChild);
        content.appendChild(wrap);
    }
    if (!wrap.style.zoom) wrap.style.zoom = 1; // explicit baseline so later reads always see a real number
    return wrap;
}

function closePanelInstance(panel) {
    if (panel.id && PANEL_TYPES.includes(panel.id)) {
        setPanelVisible(panel.id, false);
        const checkbox = document.getElementById('panel-toggle-' + panel.id);
        if (checkbox) checkbox.checked = false;
    } else {
        panel.remove();
    }
}

// Clones the ORIGINAL instance of a panel type into a brand new, fully
// independent window - cloneNode(true) reuses the real markup (no parallel
// <template> blocks to keep in sync) rather than building each panel type's
// DOM by hand a second time. Every id in the clone is stripped (a document
// can't have two elements sharing an id, and nothing here should be looking
// panel-internal elements up by id anymore anyway - see Part 2's
// closest('[data-panel-type=...]') + querySelector('.class') pattern for
// SQL Terminal/Schema Explorer, the two types with real internal state).
function openNewPanelInstance(type) {
    const original = document.getElementById(type);
    const clone = original.cloneNode(true);
    clone.removeAttribute('id');
    clone.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
    clone.classList.remove('minimized', 'maximized');
    // cloneNode(true) also copies whatever inline min/max/height/padding
    // toggleMinimize/toggleMaximize had set on the ORIGINAL's own content at
    // clone time - strip those too so a clone of a currently-collapsed or
    // fullscreen-filled panel starts at its own plain default size, not a
    // stale copy of the original's current state.
    const cloneContent = clone.querySelector(':scope > .panel-content');
    if (cloneContent) {
        cloneContent.style.minHeight = '';
        cloneContent.style.maxHeight = '';
        cloneContent.style.height = '';
        cloneContent.style.paddingTop = '';
        cloneContent.style.paddingBottom = '';
    }
    document.body.appendChild(clone);
    wirePanelInstance(clone);

    // Same staggered top-right spawn spot setPanelVisible uses for the
    // original, counting how many OTHER instances of this exact type are
    // already visible right now.
    const alreadyVisible = Array.from(document.querySelectorAll(`[data-panel-type="${type}"]`))
        .filter((el) => el !== clone && getComputedStyle(el).display !== 'none').length;
    const offset = alreadyVisible * 30;
    clone.style.top = (20 + offset) + 'px';
    clone.style.right = (20 + offset) + 'px';
    clone.style.left = 'auto';
    clone.style.bottom = 'auto';
    clone.style.zIndex = String(++panelZIndexCounter);
    clone.style.display = 'flex';

    // A freshly cloned SQL Terminal/Schema Explorer inherited the ORIGINAL's
    // last-rendered DOM verbatim (whatever query/results/schema tree/typed
    // generator script happened to be showing) - give it its own blank,
    // independent state instead of a confusing duplicate of someone else's.
    if (type === 'sql-terminal-panel') initSqlTerminalInstance(clone);
    if (type === 'schema-explorer-panel') initSchemaExplorerInstance(clone);
    return clone;
}

PANEL_TYPES.forEach((type) => wirePanelInstance(document.getElementById(type)));

// Chat sits right above the timeline and should always grow/shrink from
// that fixed bottom edge - new messages push it taller upward, minimizing
// collapses it back down toward the same bottom edge - never the reverse.
// Plain CSS `bottom:` (main.css's default) gives this for free ONLY until
// the panel's `top`/`left` get set explicitly, which makeDraggable's drag
// handler above does the moment the user drags it even once; after that,
// height changes would anchor from the (now-fixed) top instead, growing
// the wrong direction. So the desired bottom Y is tracked explicitly here
// instead, and reapplied via ResizeObserver - which fires on every actual
// rendered size change, for ANY reason (a message appended, minimize/
// maximize's own 0.2s CSS transition animating frame by frame, a future
// unrelated content change) - rather than hand-wiring every individual
// call site that could change the panel's height and hoping none are missed.
let chatBottomAnchor = null;
function reanchorChatBottom() {
    if (chatBottomAnchor === null) return;
    const panel = document.getElementById('chat-box');
    if (getComputedStyle(panel).display === 'none') return;
    // Maximized (or minimized-while-remembering-maximized - a full-width
    // collapsed header) panels have BOTH top and bottom pinned directly by
    // transitionPanel (main.js's minimize/maximize state machine), not
    // derived from this bottom-anchor at all. This ResizeObserver fires on
    // EVERY rendered size change, including the minimize/maximize
    // transition itself (this function's own header comment already notes
    // that) - re-deriving top from chatBottomAnchor here, mid-transition,
    // would fight that pinning using a stale pre-maximize anchor value and
    // leave the panel positioned wrong. A real, hand-reported bug this way:
    // clicking maximize on the chat window looked like it did nothing,
    // because immediately after transitionPanel set top:10px, THIS callback
    // fired (triggered by the resulting size change) and overwrote it with
    // a bogus value computed from the small, pre-maximize bottom position -
    // chat is the only panel type with this bottom-anchor behavior at all,
    // which is why this bug was chat-specific.
    if (isRectFullscreen(getPanelMode(panel), panelMinRestore.get(panel))) return;
    panel.style.top = (chatBottomAnchor - panel.getBoundingClientRect().height) + 'px';
    panel.style.bottom = 'auto';
}
{
    const chatPanel = document.getElementById('chat-box');
    chatBottomAnchor = chatPanel.getBoundingClientRect().bottom; // starts from the CSS default (bottom:110px)
    reanchorChatBottom(); // convert to explicit top immediately - consistent from the very first render, not just after the first resize
    new ResizeObserver(reanchorChatBottom).observe(chatPanel);
}

function appendToConsoleLog(message) {
    // NOT gated on DEBUG_MODE: the System Logs panel itself is reachable by
    // every user regardless of mode (see DEBUG_MODE's own comment - "a
    // normal user must still be able to open... through the menu", only
    // which panels start VISIBLE differs by mode). Gating this instead left
    // a real bug: a non-debug user could open System Logs and see it
    // permanently frozen on the empty-state placeholder no matter what they
    // did, since nothing was ever allowed to write into it for them.
    activeLogs.push(message);
    if (activeLogs.length > 5) activeLogs.shift();
    const text = activeLogs.join('\n');
    panelContentElements('log-box').forEach((el) => { el.innerText = text; });
}

function getString(charPtr) {
    const memory = new Uint8Array(wasmInstance.exports.memory.buffer);
    let str = "";
    let ptr = charPtr;
    while (memory[ptr] !== 0) {
        str += String.fromCharCode(memory[ptr]);
        ptr++;
    }
    return str;
}

function writeStringToWasm(str, targetPtr) {
    const bytes = new TextEncoder().encode(str + '\0');
    const heap = new Uint8Array(wasmInstance.exports.memory.buffer);
    heap.set(bytes, targetPtr);
}

// main.wasm's import object - the WebGL binding shim, and only that. This
// module never touches the database; it just renders whatever position/team
// snapshot ends up in agent_buffer each frame.
const importObject = {
    env: {
        js_sin: Math.sin, js_cos: Math.cos, js_sqrt: Math.sqrt,
        js_print_string: console.log,
        js_log_string: (charPtr) => appendToConsoleLog(getString(charPtr)),
        gl_clear_color: (r, g, b, a) => gl.clearColor(r, g, b, a),
        gl_clear: (mask) => gl.clear(mask),
        gl_create_shader: (type) => { glObjects.shaders.push(gl.createShader(type)); return glObjects.shaders.length - 1; },
        gl_shader_source: (idx, srcPtr) => gl.shaderSource(glObjects.shaders[idx], getString(srcPtr)),
        gl_compile_shader: (idx) => gl.compileShader(glObjects.shaders[idx]),
        gl_create_program: () => { glObjects.programs.push(gl.createProgram()); return glObjects.programs.length - 1; },
        gl_attach_shader: (progIdx, shaderIdx) => gl.attachShader(glObjects.programs[progIdx], glObjects.shaders[shaderIdx]),
        gl_link_program: (progIdx) => gl.linkProgram(glObjects.programs[progIdx]),
        gl_use_program: (progIdx) => gl.useProgram(glObjects.programs[progIdx]),
        gl_get_uniform_location: (progIdx, namePtr) => {
            glObjects.uniforms.push(gl.getUniformLocation(glObjects.programs[progIdx], getString(namePtr)));
            return glObjects.uniforms.length - 1;
        },
        gl_get_attrib_location: (progIdx, namePtr) => gl.getAttribLocation(glObjects.programs[progIdx], getString(namePtr)),
        gl_create_buffer: () => { glObjects.buffers.push(gl.createBuffer()); return glObjects.buffers.length - 1; },
        gl_bind_buffer: (target, bufIdx) => gl.bindBuffer(target, glObjects.buffers[bufIdx]),
        gl_buffer_data: (target, dataPtr, numBytes, usage) => {
            const dataView = new Float32Array(wasmInstance.exports.memory.buffer, dataPtr, numBytes / 4);
            gl.bufferData(target, dataView, usage);
        },
        gl_enable_vertex_attrib_array: (index) => gl.enableVertexAttribArray(index),
        gl_vertex_attrib_pointer: (idx, size, type, norm, stride, offset) => gl.vertexAttribPointer(idx, size, type, norm, stride, offset),
        gl_uniform1f: (uLocIdx, x) => gl.uniform1f(glObjects.uniforms[uLocIdx], x),
        gl_uniform2f: (uLocIdx, x, y) => gl.uniform2f(glObjects.uniforms[uLocIdx], x, y),
        gl_uniform3f: (uLocIdx, r, g, b) => gl.uniform3f(glObjects.uniforms[uLocIdx], r, g, b),
        gl_uniform_matrix4fv: (uLocIdx, matPtr) => {
            const matrix = new Float32Array(wasmInstance.exports.memory.buffer, matPtr, 16);
            gl.uniformMatrix4fv(glObjects.uniforms[uLocIdx], false, matrix);
        },
        gl_draw_arrays: (mode, first, count) => gl.drawArrays(mode, first, count),
        gl_viewport: (x, y, w, h) => gl.viewport(x, y, w, h)
    }
};

function handleResize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    if (wasmInstance) {
        gl.viewport(0, 0, canvas.width, canvas.height);
        wasmInstance.exports.set_screen_dimensions(canvas.width, canvas.height);
    }
}
window.addEventListener('resize', handleResize);

// ---- Timeline UI - driven by the small `matches` summary array the loader
// worker sends once, plus the live replayTime/latestFrame state. No per-tick
// JS bookkeeping. ----

function createTimelineUI() {
    removeTimelineUI();

    const container = document.createElement('div');
    container.id = 'timeline-container';
    container.style.position = 'absolute';
    container.style.bottom = '20px';
    container.style.left = '20px';
    container.style.right = '20px';
    container.style.background = 'rgba(10, 10, 10, 0.95)';
    container.style.border = '1px solid #333';
    container.style.borderRadius = '8px';
    container.style.padding = '14px 20px';
    container.style.zIndex = '8';
    container.style.fontFamily = 'monospace';
    container.style.color = '#fff';
    container.style.boxShadow = '0 4px 20px rgba(0,0,0,0.8)';

    const infoRow = document.createElement('div');
    infoRow.style.display = 'flex';
    infoRow.style.justifyContent = 'space-between';
    infoRow.style.alignItems = 'center';
    infoRow.style.marginBottom = '12px';
    infoRow.style.fontSize = '12px';

    const matchDetails = document.createElement('div');
    matchDetails.id = 'tl-match-details';
    matchDetails.style.color = '#00ff00';
    matchDetails.style.fontWeight = 'bold';
    matchDetails.innerText = 'Initializing matches...';

    const timeDisplay = document.createElement('div');
    timeDisplay.id = 'tl-time-display';
    timeDisplay.style.color = '#888';
    timeDisplay.innerText = 'Frame: 0 / 0';

    // Export Battle is now the static #export-btn in main.html, docked under
    // #reset-btn - not created here anymore (see finishLoadAndStartPlayback/
    // triggerReset for its show/hide, matching #reset-btn's own lifecycle).

    infoRow.appendChild(matchDetails);
    infoRow.appendChild(timeDisplay);

    const controlsRow = document.createElement('div');
    controlsRow.style.display = 'flex';
    controlsRow.style.alignItems = 'center';
    controlsRow.style.gap = '15px';

    const playBtn = document.createElement('button');
    playBtn.id = 'tl-play-btn';
    playBtn.innerText = 'Pause';
    playBtn.style.background = '#1a1a1a';
    playBtn.style.color = '#00ff00';
    playBtn.style.border = '1px solid #00ff00';
    playBtn.style.padding = '6px 16px';
    playBtn.style.borderRadius = '4px';
    playBtn.style.cursor = 'pointer';
    playBtn.style.fontWeight = 'bold';
    playBtn.style.transition = 'all 0.1s';
    // "Play" and "Pause" are different lengths - without a fixed width the
    // button visibly resizes (and everything to its right in controlsRow
    // shifts) every single toggle. minWidth sized for the longer label
    // ("Pause"), textAlign keeps the shorter one centered rather than
    // hugging the left edge once there's slack.
    playBtn.style.minWidth = '76px';
    playBtn.style.textAlign = 'center';
    playBtn.onclick = () => {
        isPaused = !isPaused;
        playBtn.innerText = isPaused ? 'Play' : 'Pause';
        playBtn.style.color = isPaused ? '#ffaa00' : '#00ff00';
        playBtn.style.borderColor = isPaused ? '#ffaa00' : '#00ff00';
    };

    const speedSelect = document.createElement('select');
    speedSelect.style.background = '#1a1a1a';
    speedSelect.style.color = '#fff';
    speedSelect.style.border = '1px solid #333';
    speedSelect.style.padding = '5px 10px';
    speedSelect.style.borderRadius = '4px';
    speedSelect.style.cursor = 'pointer';
    [0.5, 1.0, 1.5, 2.0, 4.0, 8.0].forEach(sp => {
        const opt = document.createElement('option');
        opt.value = sp;
        opt.innerText = sp + 'x Speed';
        if (sp === 1.0) opt.selected = true;
        speedSelect.appendChild(opt);
    });
    speedSelect.onchange = (e) => {
        playbackSpeed = parseFloat(e.target.value);
    };

    const trackWrapper = document.createElement('div');
    trackWrapper.style.position = 'relative';
    trackWrapper.style.flexGrow = '1';
    trackWrapper.style.height = '24px';
    trackWrapper.style.background = '#141414';
    trackWrapper.style.borderRadius = '4px';
    trackWrapper.style.border = '1px solid #222';
    trackWrapper.style.overflow = 'hidden';

    const totalSpan = Math.max(1e-6, totalEndTime - totalStartTime);
    timelineLoadBars = [];
    matches.forEach((m, idx) => {
        const startPct = ((m.startTime - totalStartTime) / totalSpan) * 100;
        const widthPct = ((m.endTime - m.startTime) / totalSpan) * 100;

        const block = document.createElement('div');
        block.style.position = 'absolute';
        block.style.left = startPct + '%';
        block.style.width = widthPct + '%';
        block.style.height = '100%';
        block.style.background = idx % 2 === 0 ? 'rgba(0, 150, 255, 0.12)' : 'rgba(0, 255, 150, 0.08)';
        block.style.borderLeft = '2px solid #00ff00';
        block.style.cursor = 'pointer';
        block.title = `Jump to Match #${idx + 1} (Scene: ${m.sceneNo}, Factions: ${m.faction})`;
        block.onclick = (e) => {
            e.stopPropagation();
            seekTo(m.startTime);
        };

        // YouTube-style buffered indicator: a thin bar along the bottom of
        // this battle's block, brightness reflecting how "loaded" it is -
        // see updateLoadIndicators(). Purely visual, driven by the same
        // prefetchedBattles/primedBattles state the prefetch orchestration
        // (schedulePrefetch/schedulePriming) already tracks.
        const loadBar = document.createElement('div');
        loadBar.style.position = 'absolute';
        loadBar.style.bottom = '0';
        loadBar.style.left = '0';
        loadBar.style.width = '100%';
        loadBar.style.height = '3px';
        loadBar.style.background = 'transparent';
        loadBar.style.pointerEvents = 'none';
        block.appendChild(loadBar);
        timelineLoadBars[idx] = loadBar;

        trackWrapper.appendChild(block);
    });
    updateLoadIndicators();

    const slider = document.createElement('input');
    slider.id = 'tl-slider';
    slider.type = 'range';
    slider.min = totalStartTime.toString();
    slider.max = totalEndTime.toString();
    slider.step = "0.01";
    slider.value = totalStartTime.toString();
    slider.style.position = 'absolute';
    slider.style.top = '0';
    slider.style.left = '0';
    slider.style.width = '100%';
    slider.style.height = '100%';
    slider.style.margin = '0';
    slider.style.background = 'transparent';
    slider.style.outline = 'none';
    slider.style.cursor = 'pointer';
    slider.style.opacity = '0.95';
    slider.oninput = (e) => {
        seekTo(parseFloat(e.target.value));
    };

    trackWrapper.appendChild(slider);

    controlsRow.appendChild(playBtn);
    controlsRow.appendChild(speedSelect);
    controlsRow.appendChild(trackWrapper);

    container.appendChild(infoRow);
    container.appendChild(controlsRow);
    document.body.appendChild(container);
}

function removeTimelineUI() {
    const el = document.getElementById('timeline-container');
    if (el) el.remove();
}

// ---- Battle export (Phase 4) ----

let exportMatchIdxInFlight = -1;

function resetExportButton() {
    exportInFlight = false;
    const btn = document.getElementById('export-btn');
    if (btn) { btn.disabled = false; btn.innerText = 'Export Battle'; }
}

function exportActiveBattle() {
    if (exportInFlight) return;
    if (!playbackWorker || !latestFrame || latestFrame.activeMatchIndex < 0) {
        alert('No active battle to export - seek into a battle first.');
        return;
    }
    exportInFlight = true;
    exportMatchIdxInFlight = latestFrame.activeMatchIndex;
    const btn = document.getElementById('export-btn');
    if (btn) { btn.disabled = true; btn.innerText = 'Exporting...'; }
    // replay-worker.js's runExportBattle() supplies the real Unix-epoch
    // timestamp for manifest.json's generated_at_unix field internally
    // (replay_worker.wasm's only clock_gettime() import is performance.now()-
    // based, not wall-clock - see replay-worker.js) - nothing extra to send here.
    playbackWorker.postMessage({ type: 'exportBattle', matchIdx: exportMatchIdxInFlight });
}

function getOrCreateCompressWorker() {
    if (compressWorker) return compressWorker;
    compressWorker = new Worker('compress-worker.js?v=' + Date.now());
    compressWorker.onmessage = (e) => {
        const d = e.data;
        if (d.type === 'compressed') {
            finishExportDownload(d.out);
        } else if (d.type === 'error') {
            appendToConsoleLog('[Export] compression failed: ' + d.message);
            alert('Battle export failed during compression: ' + d.message);
            resetExportButton();
        }
        // 'compressProgress' ignored for now - a progress bar could read it later
    };
    return compressWorker;
}

// Phase 6: same navigator.deviceMemory tiering as computeReaderCount() above,
// applied to the LZMA dictionary size instead of Worker count - a bigger
// dictionary means more compression-time RAM (LZmaEnc's match-finder hash
// tables scale with it), which matters during export/derivation the same
// way it matters during playback. 24MiB is the existing capable-device
// default (a single battle's export is bounded - tens of MB, not 20GB - so
// even the "moderate" tier already captures most of the same redundancy a
// much bigger dictionary would, per the plan's extreme-compression-vs-128MB
// tradeoff note); constrained devices get progressively smaller.
function computeDictSizeMiB() {
    const mem = navigator.deviceMemory;
    if (mem === undefined) return 24;
    if (mem <= 1) return 4;
    if (mem <= 2) return 8;
    if (mem <= 4) return 16;
    return 24;
}

// Applied to the playback thread's own SQLite per-battle-index memory
// (replay_worker.c's g_priming_budget_bytes) - the soft ceiling
// replay_ensure_battle_ready()/replay_try_prime_battle() weigh against
// before building a new battle's index, evicting a farther-away one first
// if already over it. A ?primingBudgetMiB=N URL param overrides this for
// manual repro/testing without needing a real file large enough to exhaust
// memory organically - see testdata/ui_behavior_tests.js.
//
// Deliberately NOT the same small navigator.deviceMemory tiers
// computeReaderCount()/computeDictSizeMiB() use above (originally copied
// from there, then found - via a real multi-battle file that only reached
// 128MiB of committed-and-never-evicted-let-alone-real-need before
// plateauing, "using all available memory" it was not - deviceMemory
// reports at most 8 REGARDLESS of actual RAM, by spec, for fingerprinting
// resistance: a 64GB desktop and an 8GB one both report "8" and would get
// the identical, needlessly tiny budget). The point of this feature is to
// use memory that's actually available, evicting only once genuinely
// running low - not to impose an arbitrary low ceiling most machines never
// come close to needing. So the generous tier here targets a fraction of
// the REAL hard ceiling (WASM_MEMORY_MAX_PAGES, 2GiB) instead: most of it,
// leaving enough headroom below that ceiling for what else shares the same
// WebAssembly.Memory - up to 8 reader threads, the prefetch thread, fixed
// stack/TLS pools, and SQLite's own non-index working memory. Only devices
// deviceMemory can positively identify as constrained (<=4, still a
// meaningful signal at the low end even though it's meaningless at the
// high end) get a smaller cap, sized to not risk crashing the whole tab.
function computePrimingBudgetBytes() {
    const override = new URLSearchParams(location.search).get('primingBudgetMiB');
    if (override !== null) return parseInt(override, 10) * 1024 * 1024;
    const mem = navigator.deviceMemory;
    let mib;
    if (mem !== undefined && mem <= 1) mib = 128;
    else if (mem !== undefined && mem <= 2) mib = 384;
    else if (mem !== undefined && mem <= 4) mib = 768;
    else mib = 1536; // undefined (Firefox/Safari - could be any real desktop) or deviceMemory's own 8GB-and-up ceiling
    return mib * 1024 * 1024;
}

function handleExportedTar(matchIdx, tarBytes) {
    const dictSizeMiB = computeDictSizeMiB();
    appendToConsoleLog(`[Export] battle #${matchIdx + 1} raw tar: ${tarBytes.length} bytes, compressing (dict=${dictSizeMiB}MiB)...`);
    const worker = getOrCreateCompressWorker();
    worker.postMessage({ type: 'compress', data: tarBytes, dictSizeMiB }, [tarBytes.buffer]);
}

function finishExportDownload(compressedBytes) {
    const idx = exportMatchIdxInFlight;
    const m = matches[idx];
    const safeFaction = (m ? m.faction : 'battle').replace(/[^a-z0-9]+/gi, '_').slice(0, 40);
    const filename = `battle_${idx + 1}_${safeFaction}.tar.xz`;
    const blob = new Blob([compressedBytes], { type: 'application/x-xz' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    appendToConsoleLog(`[Export] battle #${idx + 1} exported: ${compressedBytes.length} bytes -> ${filename}`);
    resetExportButton();
}

function seekTo(t) {
    replayTime = t;
    const slider = document.getElementById('tl-slider');
    if (slider) slider.value = replayTime.toString();
    if (playbackWorker && !pendingFrameRequest) {
        pendingFrameRequest = true;
        playbackWorker.postMessage({ type: 'frame', time: replayTime, seek: true });
    }
}

function updateSliderPosition() {
    const timeDisplay = document.getElementById('tl-time-display');
    const matchDetails = document.getElementById('tl-match-details');
    if (!latestFrame) return;

    const activeMatchIdx = latestFrame.activeMatchIndex;

    if (timeDisplay) {
        timeDisplay.innerText = `Time: +${latestFrame.relativeTime.toFixed(2)}s`;
    }
    if (matchDetails) {
        if (activeMatchIdx >= 0 && activeMatchIdx < matches.length) {
            const m = matches[activeMatchIdx];
            matchDetails.innerText = `MATCH #${activeMatchIdx + 1} | Scene: ${m.sceneNo} | Factions: ${m.faction}`;
        } else {
            matchDetails.innerText = 'Out of match boundaries';
        }
    }
}

// Chat is nothing more than a visualization of a SQL query - "every chat
// message at or before the current moment" - re-run and fully re-rendered
// from scratch, NOT an append-only feed driven by frame events. That used to
// be a monotonic advance-only cursor on the C side (replay_get_new_chat_count/
// replay_advance_chat_cursor): scrubbing backward then forward past a
// message's tick re-delivered it as "new" a second time, since the cursor
// only ever moved forward and had no idea the user had rewound. A query
// keyed on "now" can't double-deliver - re-running it at the same tick just
// reproduces the same result set - and since it reads the live `chats` table
// directly (through the same SQL Terminal execution path a user's own query
// uses - see runSchemaQueryAsync), an UPDATE/DELETE against `chats` made from
// the SQL Terminal shows up here too, on the very next refresh.
let lastChatQueryKey = null; // `${activeMatchIndex}:${currentTickId}` - see refreshChatFromQuery

function parseTeamText(teamText) {
    // Mirrors replay_worker.c's parse_team() exactly - the chats.team column
    // is raw text ('0'/'1'/anything else), not a pre-parsed int.
    if (teamText === '0') return 0;
    if (teamText === '1') return 1;
    return -1;
}

// Chat is a single shared feed, not per-window state (see panelContentElements)
// - every currently open chat-box window gets the same full rebuild, each
// keeping its OWN near-bottom/scroll bookkeeping (one window might be
// scrolled back through history while another follows live).
function renderChatMessages(rows) {
    const NEAR_BOTTOM_PX = 24;
    for (const chatContent of panelContentElements('chat-box')) {
        // panelContentElements returns the .panel-zoom-wrap CHILD (for the
        // Ctrl+Scroll zoom feature), not the actual scrolling element -
        // .panel-content, the wrap's OWN parent, is the one with
        // overflow-y:auto (main.css). Reading/writing scrollTop on the wrap
        // itself is a no-op (it never clips its own content, so its
        // scrollTop is always 0) - confirmed as the actual cause of "follow
        // to bottom" silently never doing anything.
        const scrollEl = chatContent.parentElement;
        // Measured BEFORE rebuilding, since rebuilding changes scrollHeight.
        const wasNearBottom = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight <= NEAR_BOTTOM_PX;

        const frag = document.createDocumentFragment();
        if (rows.length === 0) {
            // An empty box reads as broken, not "no messages yet" - match
            // the same placeholder triggerReset() shows before any replay
            // is even loaded.
            const note = document.createElement('div');
            note.textContent = 'System: No chat messages yet.';
            frag.appendChild(note);
        }
        for (const [username, message, teamText] of rows) {
            const team = parseTeamText(teamText);
            let color = '#00ff00';
            if (team === 0) color = '#ff5151';
            else if (team === 1) color = '#51adff';
            const msgDiv = document.createElement('div');
            msgDiv.style.marginBottom = '5px';
            msgDiv.style.wordBreak = 'break-word';
            msgDiv.innerHTML = `<span style="color: ${color}; font-weight: bold;">${escapeHtml(username)}</span>: <span style="color: #e0e0e0;">${escapeHtml(message)}</span>`;
            frag.appendChild(msgDiv);
        }
        chatContent.innerHTML = '';
        chatContent.appendChild(frag);
        if (wasNearBottom) scrollEl.scrollTop = scrollEl.scrollHeight;
    }
}

// Re-runs the chat query and re-renders from scratch. Gated by the frame
// handler on `${activeMatchIndex}:${currentTickId}` actually changing, not
// fired on every animation frame - ticks advance far slower than rendered
// frames (interpolation alpha moves in between), so this naturally throttles
// to real tick-rate frequency. background:true (via runSchemaQueryAsync) so
// it can never sit ahead of a user's own explicit terminal query.
async function refreshChatFromQuery(activeMatchIndex) {
    if (!playbackWorker) return;
    // No active match (e.g. the gap between battles) - render as empty
    // rather than leaving whatever the PREVIOUS match's chat happened to be
    // stuck on screen.
    if (activeMatchIndex < 0) { renderChatMessages([]); return; }
    // @KIND=chat entries are JS-only (never reach the C render-query engine
    // - see renderQueries' own header comment) and run directly here, through
    // the same SQL Terminal execution path a user's own query uses. Multiple
    // enabled chat queries are allowed and concatenate in list order (per
    // the plan's row-shape convention for @KIND chat).
    const chatQueries = renderQueries.filter(q => q.kind === 'chat' && q.enabled);
    if (chatQueries.length === 0) { renderChatMessages([]); return; }
    try {
        let rows = [];
        for (const q of chatQueries) {
            const res = await runSchemaQueryAsync(q.sql);
            rows = rows.concat(res.rows);
        }
        renderChatMessages(rows);
    } catch (e) {
        // Transient (e.g. a reset landed mid-query) - the next tick change retries.
    }
}

// ---- Near-cursor prefetch orchestration ----

function matchIndexForTime(t) {
    for (let i = 0; i < matches.length; i++) {
        if (t >= matches[i].startTime && t <= matches[i].endTime) return i;
    }
    return -1;
}

// Priority order fans out from the cursor, forward-biased (playback usually
// moves forward): current+1, current-1, current+2, current-2, ... The
// currently-active battle itself is deliberately skipped - playbackWorker's
// own self-healing call already covers it on the very next frame request,
// same as a video player's initial buffer when you first press play.
function pickPrefetchTarget() {
    if (matches.length === 0) return -1;
    const current = latestFrame ? latestFrame.activeMatchIndex : matchIndexForTime(replayTime);
    const base = current >= 0 ? current : 0;
    for (let d = 1; d < matches.length; d++) {
        const fwd = base + d;
        if (fwd < matches.length && !prefetchedBattles.has(fwd)) return fwd;
        const back = base - d;
        if (back >= 0 && !prefetchedBattles.has(back)) return back;
    }
    return -1;
}

function schedulePrefetch() {
    if (!prefetchWorker || !prefetchWorkerReady || prefetchInFlight) return;
    const idx = pickPrefetchTarget();
    if (idx < 0) return; // every battle already prefetched (or none loaded yet) - idle
    prefetchInFlight = true;
    prefetchWorker.postMessage({
        type: 'prefetchBattle',
        matchIdx: idx,
        startTickId: matches[idx].startTickId,
        endTickId: matches[idx].endTickId,
    });
}

function startPrefetchWorker() {
    prefetchWorkerReady = false;
    prefetchWorker = new Worker(WORKER_SCRIPT_URL);
    prefetchWorker.onmessage = (e) => {
        const d = e.data;
        if (d.type === 'ready') {
            prefetchWorkerReady = true;
            schedulePrefetch();
        } else if (d.type === 'prefetched') {
            prefetchedBattles.add(d.matchIdx);
            prefetchInFlight = false;
            updateLoadIndicators();
            schedulePrefetch(); // always re-target the current cursor, not a stale one
            schedulePriming();  // this battle's bounds are ready - eligible to prime now
        } else if (d.type === 'error') {
            appendToConsoleLog('[Prefetch Worker Error] ' + d.message);
            // best-effort only (see comment above prefetchWorker decl) - drop
            // this attempt and move on rather than getting stuck retrying.
            prefetchInFlight = false;
            schedulePrefetch();
        }
    };
    prefetchWorker.postMessage({ type: 'init', role: 'prefetch', memory: sharedMemory, module: replayModule, threadId: PREFETCH_THREAD_ID });
}

// Same fan-out priority as pickPrefetchTarget, over every not-yet-primed
// battle - deliberately NOT gated on prefetchedBattles (bounds precomputed
// by the reader fan-out). That fan-out is a pure speed optimization: when it
// has already resolved a battle's rowid slice, replay_try_prime_battle()
// picks that up for free and skips straight to the index build; when it
// hasn't (either it hasn't gotten there yet, or - confirmed via real Firefox
// testing, see openSyncAccessHandleWithRetry's [OPFS DEBUG] logging in
// replay-worker.js - it can never succeed at all, because Firefox's OPFS
// won't grant a second concurrent handle on main.db while playbackWorker's
// is open), replay_try_prime_battle()/replay_ensure_battle_ready() resolve
// the bounds themselves on the fly (replay_worker.c:447-455), on the same
// connection that's already open and working. Gating priming eligibility on
// prefetchedBattles here was requiring an optimization's side effect as a
// correctness precondition - on a browser where that optimization can't run
// at all, it silently meant priming past the initially-active battle NEVER
// HAPPENED, no matter how much budget was available. Also skips anything
// replay_try_prime_battle() just declined (see declinedPrimingBattles) -
// re-requesting the identical target every tick with nothing having changed
// would just get declined again forever.
function pickPrimeTarget() {
    if (matches.length === 0) return -1;
    const current = latestFrame ? latestFrame.activeMatchIndex : matchIndexForTime(replayTime);
    const base = current >= 0 ? current : 0;
    for (let d = 1; d < matches.length; d++) {
        const fwd = base + d;
        if (fwd < matches.length && !primedBattles.has(fwd) && !declinedPrimingBattles.has(fwd)) return fwd;
        const back = base - d;
        if (back >= 0 && !primedBattles.has(back) && !declinedPrimingBattles.has(back)) return back;
    }
    return -1;
}

function schedulePriming() {
    // summaryPrewarmInFlight too - only one proactive, non-frame-critical
    // background operation against playbackWorker at a time (see
    // scheduleSummaryPrewarm's identical check just below): stacking a
    // CREATE INDEX and a roster/corpse fold back-to-back on the same idle
    // window compounds exactly the worker-monopolization lag this whole
    // rework exists to reduce, not fix.
    if (!playbackWorker || primingInFlight || summaryPrewarmInFlight || pendingFrameRequest) return; // only when playbackWorker is truly idle
    const idx = pickPrimeTarget();
    if (idx < 0) return;
    primingInFlight = true;
    const current = latestFrame ? latestFrame.activeMatchIndex : matchIndexForTime(replayTime);
    playbackWorker.postMessage({ type: 'primeBattle', matchIdx: idx, currentMatchIdx: current >= 0 ? current : 0 });
}

// Same outward-walk-from-cursor target selection as pickPrimeTarget above,
// for replay_export.c's roster/corpse summary cache instead of the
// agent_states partial index - independent completion state (a battle can
// be index-primed without being summary-cached, or vice versa), so this
// walks its own cachedSummaryBattles/declinedSummaryPrewarmBattles rather
// than reusing primedBattles/declinedPrimingBattles.
function pickSummaryPrewarmTarget() {
    if (matches.length === 0) return -1;
    const current = latestFrame ? latestFrame.activeMatchIndex : matchIndexForTime(replayTime);
    const base = current >= 0 ? current : 0;
    for (let d = 0; d < matches.length; d++) {
        const fwd = base + d;
        if (fwd < matches.length && !cachedSummaryBattles.has(fwd) && !declinedSummaryPrewarmBattles.has(fwd)) return fwd;
        const back = base - d;
        if (d > 0 && back >= 0 && !cachedSummaryBattles.has(back) && !declinedSummaryPrewarmBattles.has(back)) return back;
    }
    return -1;
}

function scheduleSummaryPrewarm() {
    // primingInFlight too - see schedulePriming's identical check above.
    if (!playbackWorker || summaryPrewarmInFlight || primingInFlight || pendingFrameRequest) return; // only when playbackWorker is truly idle
    const idx = pickSummaryPrewarmTarget();
    if (idx < 0) return;
    summaryPrewarmInFlight = true;
    const current = latestFrame ? latestFrame.activeMatchIndex : matchIndexForTime(replayTime);
    playbackWorker.postMessage({ type: 'prewarmSummary', matchIdx: idx, currentMatchIdx: current >= 0 ? current : 0 });
}

// YouTube-buffered-bar-style loading indicator, drawn along the bottom of
// each battle's timeline block: dim/transparent = not loaded at all, faint
// = bounds prefetched but index not built yet, bright = fully primed (an
// access to this battle would be instant). Called whenever prefetchedBattles/
// primedBattles change, and once from createTimelineUI() to paint the
// initial state.
function updateLoadIndicators() {
    for (let i = 0; i < timelineLoadBars.length; i++) {
        const bar = timelineLoadBars[i];
        if (!bar) continue;
        if (primedBattles.has(i)) {
            bar.style.background = 'rgba(255, 255, 255, 0.9)';
        } else if (prefetchedBattles.has(i)) {
            bar.style.background = 'rgba(255, 255, 255, 0.35)';
        } else {
            bar.style.background = 'transparent';
        }
    }
}

// Resyncs primedBattles against replay_get_battle_ready_mask()'s bitmask
// (sent on every 'frame'/'battlePrimed'/'primingDeclined' message) instead
// of trying to track individual evict events - a battle's bit can go from
// 1 back to 0 when replay_evict_battle() (replay_worker.c) drops its index
// to make room for another one, and diffing against the mask is what makes
// that visible here (its loading bar fading back down) without needing a
// dedicated "evicted" message that could lose an event if two evictions
// happened between messages (see replay_get_battle_ready_mask's comment in
// replay_worker.c for why a last-evicted scalar was rejected). Also clears
// declinedPrimingBattles whenever the ready set actually changes - an
// eviction may have made a previously-declined target worth reconsidering.
function resyncLoadState(readyMask) {
    if (readyMask === undefined) return; // older/unrelated message shapes - nothing to resync
    let changed = false;
    for (let i = 0; i < matches.length; i++) {
        const ready = (readyMask & (1 << i)) !== 0;
        if (ready === primedBattles.has(i)) continue;
        changed = true;
        if (ready) { primedBattles.add(i); prefetchedBattles.add(i); }
        else primedBattles.delete(i);
    }
    if (changed) {
        declinedPrimingBattles = new Set();
        updateLoadIndicators();
    }
}

// ---- Worker orchestration ----

function startReplayLoad(file) {
    uploadOverlay.style.display = 'none';
    loadingOverlay.style.display = 'flex';
    document.getElementById('progress-fill').style.width = '0%';
    document.getElementById('progress-text').innerText = 'Starting worker pool...';

    sharedMemory = new WebAssembly.Memory({ initial: WASM_MEMORY_INITIAL_PAGES, maximum: WASM_MEMORY_MAX_PAGES, shared: true });

    pendingWorkerTeardown
        .then(() => fetch('replay_worker.wasm', { cache: 'no-store' }))
        .then(res => res.arrayBuffer())
        .then(WebAssembly.compile)
        .then(module => {
            replayModule = module;
            playbackWorker = new Worker(WORKER_SCRIPT_URL);
            playbackWorker.onmessage = onLoaderMessage;
            playbackWorker.onerror = (e) => {
                appendToConsoleLog('[Worker Error] ' + e.message);
            };
            playbackWorker.postMessage({ type: 'init', role: 'loader', memory: sharedMemory, module: replayModule, threadId: 0 });
            // 'ready' response triggers the actual load in onLoaderMessage.
            playbackWorker._pendingFile = file;
        })
        .catch(err => {
            alert("Failed to start replay engine: " + err.message);
            triggerReset();
        });
}

// Phase 5: load a previously-exported single battle's .tar.xz directly,
// skipping the full multi-battle scan_matches() path entirely - fetch the
// file's bytes, decompress via compress-worker.js (compress.wasm's xz
// decoder), extract replay.db out of the resulting ustar tar (parseTar,
// top of this file), then hand those bytes to a fresh loader worker via
// the 'loadBattleFile' message (replay-worker.js's runLoadBattleFile ->
// replay_finish_load_battle_file()). Reuses the exact same playbackWorker/
// onLoaderMessage 'loaded'-handling path startReplayLoad() does - the two
// only diverge in how the bytes reach the loader worker.
function startBattleFileLoad(file) {
    uploadOverlay.style.display = 'none';
    loadingOverlay.style.display = 'flex';
    document.getElementById('progress-fill').style.width = '0%';
    document.getElementById('progress-text').innerText = 'Decompressing battle file...';

    file.arrayBuffer().then(buf => {
        const compressedBytes = new Uint8Array(buf);
        const decompressWorker = new Worker('compress-worker.js?v=' + Date.now());
        decompressWorker.onmessage = (e) => {
            const d = e.data;
            if (d.type === 'decompressed') {
                decompressWorker.terminate();
                const entries = parseTar(d.out);
                const replayEntry = entries.find(en => en.name === 'replay.db');
                if (!replayEntry) {
                    alert('Battle file is missing replay.db - not a valid export from this app.');
                    triggerReset();
                    return;
                }
                beginBattleFileWorkerLoad(replayEntry.data.slice()); // detach from the shared tar buffer
            } else if (d.type === 'error') {
                decompressWorker.terminate();
                alert('Failed to decompress battle file: ' + d.message);
                triggerReset();
            }
        };
        decompressWorker.postMessage({ type: 'decompress', data: compressedBytes }, [compressedBytes.buffer]);
    }).catch(err => {
        alert('Failed to read battle file: ' + err.message);
        triggerReset();
    });
}

function beginBattleFileWorkerLoad(replayDbBytes) {
    document.getElementById('progress-text').innerText = 'Starting worker pool...';
    sharedMemory = new WebAssembly.Memory({ initial: WASM_MEMORY_INITIAL_PAGES, maximum: WASM_MEMORY_MAX_PAGES, shared: true });

    pendingWorkerTeardown
        .then(() => fetch('replay_worker.wasm', { cache: 'no-store' }))
        .then(res => res.arrayBuffer())
        .then(WebAssembly.compile)
        .then(module => {
            replayModule = module;
            playbackWorker = new Worker(WORKER_SCRIPT_URL);
            playbackWorker.onmessage = onLoaderMessage;
            playbackWorker.onerror = (e) => {
                appendToConsoleLog('[Worker Error] ' + e.message);
            };
            playbackWorker.postMessage({ type: 'init', role: 'loader', memory: sharedMemory, module: replayModule, threadId: 0 });
            // 'ready' response triggers the actual load in onLoaderMessage.
            playbackWorker._pendingBattleFileBytes = replayDbBytes;
        })
        .catch(err => {
            alert("Failed to start replay engine: " + err.message);
            triggerReset();
        });
}

function onLoaderMessage(e) {
    const d = e.data;
    switch (d.type) {
        case 'ready': {
            if (playbackWorker._pendingBattleFileBytes) {
                const bytes = playbackWorker._pendingBattleFileBytes;
                document.getElementById('progress-text').innerText = 'Streaming battle file into engine...';
                playbackWorker.postMessage({ type: 'loadBattleFile', replayDbBytes: bytes }, [bytes.buffer]);
            } else {
                const file = playbackWorker._pendingFile;
                document.getElementById('progress-text').innerText = 'Streaming file into engine...';
                playbackWorker.postMessage({ type: 'load', file });
            }
            break;
        }
        case 'progress': {
            const pct = d.total > 0 ? Math.round((d.loaded / d.total) * 100) : 0;
            document.getElementById('progress-fill').style.width = pct + '%';
            document.getElementById('progress-text').innerText = `Loading... ${pct}%`;
            break;
        }
        case 'loaded': {
            matches = d.matches;
            totalStartTime = d.totalStart;
            totalEndTime = d.totalEnd;
            // "#0 checkpoint by default... the initial state" - already
            // created C-side by the time this message arrives
            // (sql_checkpoint_init_baseline, called from
            // replay_finish_load/replay_finish_load_battle_file right before
            // either returns) - this just seeds JS's own view of it.
            knownCheckpointIds = [0];
            currentCheckpointId = 0;
            refreshAllCheckpointDropdowns();
            // New phase, new bar - the fill was left at 100% from the byte-
            // streaming progress above, which would otherwise sit frozen
            // there (looking finished, or "fake") for however long the
            // parallel bounds computation below actually takes against a
            // multi-hundred-MB file - genuinely real, uneven time, not a
            // formality. Reset to 0% here and let startBoundsComputation's
            // reader-completion handler drive it back up for real.
            document.getElementById('progress-fill').style.width = '0%';
            document.getElementById('progress-text').innerText = `Computing map bounds (parallel)... 0/${READER_COUNT} readers done`;
            playbackWorker.postMessage({ type: 'setPrimingBudget', bytes: computePrimingBudgetBytes() });
            playbackWorker.postMessage({ type: 'getDefaultRenderQueries' });
            playbackWorker.postMessage({ type: 'getSampleNatoSymbolSql' });
            // initDefaultRenderQueries' own pushRenderQueriesToEngine() call
            // (fired from the 'defaultRenderQueries' reply above) lands
            // before "b" is attached and populated (that only happens
            // inside build_frame_at_time's own replay_ensure_db_view(2)
            // call, itself only reachable once a battle is actually active -
            // see replay_worker.c's own comment there), so its trial-prepare
            // validation harmlessly fails and leaves a stale
            // "no such table: roster_history"/"no such table: corpses" on
            // every default query's status line even though real per-frame
            // rebuilds succeed fine thereafter. Re-pushing once, the first
            // time a battle actually goes active, re-validates against the
            // now-real schema and clears that stale status - see the
            // 'frame' case below.
            renderQueriesNeedRevalidate = true;
            startBoundsComputation();
            // Delayed past the reader stagger window (startBoundsComputation
            // spaces up to READER_COUNT readers 25ms apart) rather than fired
            // in the same synchronous tick - this worker's own bootstrap()
            // opens an OPFS handle on the same file too, so starting it
            // right alongside the reader storm was part of the same Firefox
            // contention issue openSyncAccessHandleWithRetry/the reader
            // stagger above exist to address. Independent of bounds
            // computation otherwise - it doesn't need to wait for readers to
            // finish, just to not pile onto their handle-open burst.
            setTimeout(startPrefetchWorker, READER_COUNT * 25 + 50);
            break;
        }
        case 'boundsCombined': {
            wasmInstance.exports.set_map_bounds(d.minX, d.maxX, d.minY, d.maxY);
            finishLoadAndStartPlayback();
            break;
        }
        case 'frame': {
            pendingFrameRequest = false;
            latestFrame = { renderSlots: d.renderSlots, activeMatchIndex: d.activeMatchIndex, relativeTime: d.relativeTime };
            if (renderQueriesNeedRevalidate && d.activeMatchIndex >= 0) {
                renderQueriesNeedRevalidate = false;
                pushRenderQueriesToEngine();
            }
            {
                const chatKey = d.activeMatchIndex + ':' + d.currentTickId;
                if (chatKey !== lastChatQueryKey) {
                    lastChatQueryKey = chatKey;
                    refreshChatFromQuery(d.activeMatchIndex);
                }
            }
            updateNatoSymbolLayer(d.activeMatchIndex, d.activeMatchIndex + ':' + d.currentTickId, d.alpha || 0);
            updateSliderPosition();
            // A battle can become ready without ever going through the
            // prefetch/prime pipeline - e.g. the very first battle on load,
            // or the user jumping straight to one (playbackWorker's own
            // self-healing call covers it live) - and, under a memory
            // budget, an access here can also EVICT a farther-away battle to
            // make room. readyMask is the source of truth for both:
            // resyncLoadState adds the just-readied active battle and drops
            // anything replay_ensure_battle_ready() had to sacrifice for it.
            resyncLoadState(d.readyMask);
            schedulePrefetch(); // re-target in case the cursor moved (playback, seek, or scrub)
            schedulePriming();  // playbackWorker is idle right now - a good moment to prime, if anything's eligible
            scheduleSummaryPrewarm(); // ditto, for the roster/corpse summary cache
            refreshDbViewForActiveBattleIfNeeded(d.activeMatchIndex);
            if (cameraFollowActiveBattle && d.activeMatchIndex >= 0 && d.activeMatchIndex !== cameraCenteredOnMatchIndex) {
                cameraCenteredOnMatchIndex = d.activeMatchIndex;
                recenterCameraOnActiveBattle();
            }
            break;
        }
        case 'battlePrimed': {
            primingInFlight = false;
            resyncLoadState(d.readyMask);
            // Both, not just schedulePriming() - see scheduleSummaryPrewarm's
            // own comment: without this, priming re-triggering itself every
            // time it finds a new eligible target starves summary pre-warm
            // out of the idle slot indefinitely (confirmed directly: under a
            // tight budget with more battles than fit, priming always has a
            // next target, so summary pre-warm never got a single turn).
            schedulePriming();
            scheduleSummaryPrewarm();
            break;
        }
        case 'primingDeclined': {
            // Budget's tight and this target wasn't worth evicting for
            // (replay_try_prime_battle in replay_worker.c) - "it should
            // stop" from the feature request. Don't re-request the same
            // target every tick; pickPrimeTarget() skips anything in here
            // until resyncLoadState sees the ready-set actually change.
            primingInFlight = false;
            resyncLoadState(d.readyMask);
            declinedPrimingBattles.add(d.matchIdx);
            scheduleSummaryPrewarm(); // see battlePrimed's comment on fair alternation
            break;
        }
        case 'summaryPrewarmed': {
            summaryPrewarmInFlight = false;
            cachedSummaryBattles.add(d.matchIdx);
            // d.evictedMatchIdx (-1 = none) is the ONE thing that can make
            // cachedSummaryBattles stale here - see
            // replay_get_last_prewarm_evicted_match's own comment for why
            // this scalar is enough, unlike primedBattles' fuller
            // readyMask/resyncLoadState mechanism.
            if (d.evictedMatchIdx >= 0) cachedSummaryBattles.delete(d.evictedMatchIdx);
            schedulePriming(); // see battlePrimed's comment on fair alternation
            scheduleSummaryPrewarm();
            break;
        }
        case 'summaryPrewarmDeclined': {
            // Same reasoning as 'primingDeclined' above, for
            // replay_prewarm_battle_summary (replay_export.c) instead of
            // replay_try_prime_battle - covers both a real decline (budget
            // tight, not worth evicting for) and the rare compute error
            // (nothing meaningful to retry differently, so treated the same:
            // don't re-request every tick).
            summaryPrewarmInFlight = false;
            declinedSummaryPrewarmBattles.add(d.matchIdx);
            schedulePriming(); // see battlePrimed's comment on fair alternation
            break;
        }
        case 'exported': {
            handleExportedTar(d.matchIdx, d.tar);
            break;
        }
        case 'error': {
            appendToConsoleLog('[Replay Engine Error] ' + d.message);
            if (d.role === 'export') {
                alert('Battle export failed: ' + d.message);
                resetExportButton();
            } else if (currentSimulationState !== 'RUNNING') {
                alert('Failed to load replay: ' + d.message);
                triggerReset();
            } else {
                // A 'frame', 'primeBattle', or 'prewarmSummary' message
                // against playbackWorker threw (e.g. a transient SQLITE_BUSY
                // racing the prefetch connection's brief SHARED lock during
                // heavy evict/rebuild churn - see replay_prefetch_battle's
                // comment in replay_worker.c). replay-worker.js's outer catch
                // reports this as a generic {role: workerRole} error, not
                // tagged with which in-flight request caused it - so
                // whichever of pendingFrameRequest/primingInFlight/
                // summaryPrewarmInFlight is actually stuck can't be
                // identified here and must all be cleared unconditionally,
                // or the render loop's/schedulePriming's/
                // scheduleSummaryPrewarm's own gate never reopens and
                // playback silently hangs forever. Clearing ones that
                // weren't actually stuck is a harmless no-op; leaving the
                // real one stuck is not.
                pendingFrameRequest = false;
                primingInFlight = false;
                summaryPrewarmInFlight = false;
            }
            break;
        }
        // Debug-only diagnostics - see DEBUG_MODE above and debugPanelOutput()
        // below. These four message types already existed in
        // replay-worker.js's protocol (used only by testdata/real_file_test.html
        // until now) - wiring them here is Phase 0's plumbing sanity check
        // before building the full SQL terminal on top in a later phase.
        case 'debugIndexVisible':
            debugPanelOutput(`idx_as_b${d.matchIdx} visible: ${d.result}`);
            break;
        case 'vfsTracesReset':
            debugPanelOutput('VFS traces reset.');
            break;
        case 'vfsTraces':
            debugPanelOutput(`lockTrace: ${d.lockTrace}\nioTrace: ${d.ioTrace}`);
            break;
        case 'lockCounters':
            debugPanelOutput(`sharedCount=${d.sharedCount} exclusiveKind=${d.exclusiveKind}`);
            break;
        case 'heapDebug':
            debugPanelOutput(`regionCount=${d.regionCount} extendFailures=${d.extendFailures} playbackHeapBytes=${d.playbackHeapBytes} battleReadyMask=${d.battleReadyMask} (0b${(d.battleReadyMask >>> 0).toString(2)}) lastError=${d.lastError}`);
            break;
        // Phase 5 SQL terminal - see sqlTerminalRun() and replay-worker.js's runSql()
        // sql*/schema* both route through the one shared sqlRequestQueue
        // (see its comment above) by requestId - which window's DOM (if
        // any, for kind:'sql') or which pending promise (kind:'schema')
        // gets the response depends only on that id, never on which of the
        // two prefixes the worker happened to use for this particular call.
        case 'sqlColumns': case 'schemaColumns':
            onSqlRequestColumns(d.requestId, d.columns);
            break;
        case 'sqlRows': case 'schemaRows':
            onSqlRequestRows(d.requestId, d.rows);
            break;
        case 'sqlDone': case 'schemaDone':
            onSqlRequestDone(d.requestId, d.rowCount);
            break;
        case 'sqlError': case 'schemaError':
            onSqlRequestError(d.requestId, d.message, d.offset);
            break;
        // Checkpoints are connection-wide (real SQLite SAVEPOINTs) AND one
        // global "current selection" (see currentCheckpointId) - broadcast to
        // every open SQL Terminal AND Schema Explorer window, same as Chat/
        // System Logs.
        case 'checkpointSaved':
            onCheckpointSaved(d.id);
            break;
        case 'checkpointReverted': {
            // Undoes edits to anything - agent positions, tick times, match
            // boundaries, table shapes - so this resyncs every piece of JS
            // state built from the database, the same way a fresh load would,
            // rather than trusting whatever was cached before the revert.
            matches = d.matches;
            totalStartTime = d.totalStart;
            totalEndTime = d.totalEnd;
            createTimelineUI(); // rebuilds the match-boundary bars against the reverted data (idempotent - calls removeTimelineUI() itself)
            knownSchemas = {};
            knownSchemasBootstrapped = false; // table/column shapes may have changed too
            lastChatQueryKey = null; // force a chat re-query even if the tick itself didn't move
            // "b" (the arbitrary, user-editable Battle DB schema the default
            // render queries read from) was ALSO detached server-side by the
            // same replay_detach_generator_views call (replay_worker.c's
            // replay_invalidate_caches_after_revert) - exactly the same
            // transient "no such table: roster_history"/"corpses" gap a
            // fresh load has before its first battle-activation (see
            // onLoaderMessage's 'loaded' case), just triggered by a revert
            // instead. Same fix: re-validate/re-push once the next real
            // active frame lands post-revert (the 'frame' case below).
            renderQueriesNeedRevalidate = true;
            // r/b generator views were detached server-side (sql_checkpoint_revert,
            // via replay_detach_generator_views) - make every SQL Terminal
            // window currently viewing one notice and transparently
            // re-attach+repopulate on next use instead of silently going stale.
            document.querySelectorAll('[data-panel-type="sql-terminal-panel"]').forEach((panel) => {
                if (panel.sqlState) panel.sqlState.lastDbViewMatchIdx = -1;
            });
            document.querySelectorAll('[data-panel-type="schema-explorer-panel"]').forEach((panel) => {
                if (getComputedStyle(panel).display !== 'none') refreshSchemaExplorerPanel(panel);
            });
            if (playbackWorker) seekTo(replayTime); // re-request the current frame - positions may have changed
            broadcastCheckpointStatus(`Reverted to checkpoint #${d.id}.`);
            break;
        }
        case 'checkpointError':
            broadcastCheckpointStatus('Checkpoint error: ' + d.message);
            break;
        // Multi-database SQL terminal: on-demand replay.db/battle.db views
        // (main.js's ensureDbView/sqlTerminalDbChanged), generator scripts
        // (share dbViewReady/dbViewError) - viewKind-keyed, not per-window
        // (see the comment on generatorScriptEditors/knownSchemas above).
        case 'dbViewReady':
            onDbViewReady(d.viewKind, d.rebuilt);
            break;
        case 'dbViewError':
            onDbViewError(d.viewKind, d.message, d.offset);
            break;
        case 'defaultGeneratorSql':
            onDefaultGeneratorSql(d.viewKind, d.sql);
            break;
        case 'defaultRenderQueries':
            initDefaultRenderQueries(d.queries);
            break;
        case 'sampleNatoSymbolSql':
            sampleNatoSymbolSql = d.sql;
            break;
        case 'renderQueriesConfigured':
            // d.errors is [{index, message, offset}, ...] - index is a slot
            // position into the dots-kind sublist as of the most recent
            // pushRenderQueriesToEngine() call, mapped back to that query's
            // own card via lastPushedDotsIds (see that array's own comment).
            for (const err of d.errors) {
                const id = lastPushedDotsIds[err.index];
                if (id == null) continue;
                const q = renderQueries.find(q => q.id === id);
                setRenderQueryStatus(id, 'Error: ' + err.message, q ? q.sql : '', err.offset);
            }
            break;
    }
}

// ---- SQL debug terminal (DEBUG_MODE only, Phase 5; multi-instance since
// task #68) ----
// Rows stream in from replay-worker.js's runSql() in bounded batches
// (sqlRows) - appended straight into the <tbody> as they arrive rather than
// buffered in a JS array first, so a large result set doesn't hold two
// copies of itself in memory (one in JS, one in the DOM) at once - which is
// also why the SQL Data Viewer "pop out" (task #68 Part 4) RE-RUNS a query
// rather than reusing a buffered copy of its rows.
//
// Every element lookup below is scoped to a specific panel root
// (`this.closest('[data-panel-type="sql-terminal-panel"]')` from whatever
// was clicked/typed in) rather than a hardcoded id, and every window's
// mutable state (which DB it's querying, its last result columns, etc.)
// lives on that panel's own `panel.sqlState` object instead of a module-
// level global - see initSqlTerminalInstance below, called once for the
// original at startup and once per clone in openNewPanelInstance.

// ---- Shared SQL execution queue ----
// sql_terminal.c's g_terminal_stmt is a single global "live" prepared
// statement - a second sql_terminal_run() call unconditionally finalizes
// whatever the first was still stepping through. That's fine as long as
// exactly one request is ever in flight, which used to be true for free
// (one terminal, one query at a time) - now that any number of SQL Terminal
// windows can fire queries independently (and Schema Explorer's own
// background probing shares this exact same C entry point), everything that
// executes SQL through it funnels through ONE explicit FIFO queue here,
// tagged with a requestId the worker echoes back on every response message
// (replay-worker.js's runSqlGeneric) - so responses route to the right
// window even though only one request is ever actually posted to the worker
// at a time.
let sqlRequestSeq = 0;
let activeSqlRequest = null; // {requestId, kind, sql, panelEl, onStart, onColumns, onRows, onDone, onError}
const sqlRequestQueue = [];

function postSqlRequest(req) {
    req.requestId = ++sqlRequestSeq;
    if (req.background) {
        sqlRequestQueue.push(req);
    } else {
        // A direct user action (Run/Ctrl+Enter, Save changes, popping out
        // data) must never sit behind already-QUEUED background probing
        // (runSchemaQueryAsync's schema-bootstrap chain, the per-battle-
        // switch camera recenter query, schema-explorer refreshes) that
        // hasn't started yet - only behind whatever's already actively
        // running, which genuinely can't be interrupted (sql_terminal.c has
        // exactly one live prepared statement). Confirmed directly: without
        // this, a query typed the instant the SQL Terminal is first opened
        // during active playback could sit at "Queued..." for 10+ seconds
        // behind an entire unrelated schema-bootstrap chain, indistinguishable
        // from the shortcut "not working" at all. Insert ahead of the first
        // still-queued background entry; keep FIFO order among foreground
        // requests themselves (insert after any earlier ones).
        const idx = sqlRequestQueue.findIndex((r) => r.background);
        if (idx < 0) sqlRequestQueue.push(req);
        else sqlRequestQueue.splice(idx, 0, req);
    }
    pumpSqlRequestQueue();
    return req.requestId;
}

function pumpSqlRequestQueue() {
    if (activeSqlRequest || sqlRequestQueue.length === 0 || !playbackWorker) return;
    const req = sqlRequestQueue.shift();
    activeSqlRequest = req;
    if (req.onStart) req.onStart();
    if (req.kind === 'sql') {
        // CURSOR_X()/CURSOR_Y() (replay_worker.c) read whatever's sent along
        // with the query - main.wasm (a separate WASM instance/memory from
        // the SQL engine) is the only thing with cam_x/cam_y, so main.js
        // ferries it across on every run rather than needing a continuous
        // sync channel.
        const cursorX = wasmInstance ? wasmInstance.exports.get_cam_x() : 0;
        const cursorY = wasmInstance ? wasmInstance.exports.get_cam_y() : 0;
        playbackWorker.postMessage({ type: 'runSql', requestId: req.requestId, sql: req.sql, cursorX, cursorY });
    } else {
        playbackWorker.postMessage({ type: 'schemaQuery', requestId: req.requestId, sql: req.sql });
    }
}

function finishActiveSqlRequest() {
    activeSqlRequest = null;
    pumpSqlRequestQueue();
}

// Dispatched from onLoaderMessage for sqlColumns/sqlRows/sqlDone/sqlError
// AND schemaColumns/sqlRows/schemaDone/schemaError alike - both message
// families share this one queue (see above), so routing only needs the
// requestId, not which prefix the worker happened to use.
function onSqlRequestColumns(requestId, columns) {
    if (activeSqlRequest && activeSqlRequest.requestId === requestId && activeSqlRequest.onColumns) activeSqlRequest.onColumns(columns);
}
function onSqlRequestRows(requestId, rows) {
    if (activeSqlRequest && activeSqlRequest.requestId === requestId && activeSqlRequest.onRows) activeSqlRequest.onRows(rows);
}
function onSqlRequestDone(requestId, rowCount) {
    if (!activeSqlRequest || activeSqlRequest.requestId !== requestId) return;
    const req = activeSqlRequest;
    finishActiveSqlRequest();
    if (req.onDone) req.onDone(rowCount);
}
function onSqlRequestError(requestId, message, offset) {
    if (!activeSqlRequest || activeSqlRequest.requestId !== requestId) return;
    const req = activeSqlRequest;
    finishActiveSqlRequest();
    if (req.onError) req.onError(message, offset);
}

// Initializes (or re-initializes, for a clone that inherited the original's
// live DOM verbatim - see openNewPanelInstance) one SQL Terminal window's
// state and event wiring. Called once for the original singleton at startup,
// once per newly opened clone.
function initSqlTerminalInstance(panel) {
    panel.sqlState = {
        dbSelection: 'main', lastDbViewMatchIdx: -1,
        resultColumns: [], resultRowCount: 0, lastResults: null,
    };
    panel.querySelector('.sql-terminal-input').value = '';
    panel.querySelector('.sql-terminal-results').innerHTML = '';
    panel.querySelector('.sql-terminal-status').innerText = '';
    panel.querySelector('.sql-terminal-db-select').value = 'main';
    panel.querySelector('.sql-terminal-db-status').innerText = '';
    rebuildCheckpointDropdown(panel.querySelector('.sql-terminal-checkpoints')); // checkpoints are global - a new/cloned window shows whatever already exists, not an empty list

    const textarea = panel.querySelector('.sql-terminal-input');
    const backdrop = panel.querySelector('.sql-terminal-highlight');
    renderSqlHighlightInto(textarea, backdrop);
    textarea.addEventListener('focus', ensureKnownSchemasBootstrapped);
    textarea.addEventListener('input', () => renderSqlHighlightInto(textarea, backdrop));
    textarea.addEventListener('scroll', () => {
        backdrop.scrollTop = textarea.scrollTop;
        backdrop.scrollLeft = textarea.scrollLeft;
    });

    // Autocomplete (task: "auto completion should work everywhere where SQL
    // can be edited") - the same attachSqlAutocomplete used for every
    // generator-script editor, embedded or popped out (buildGeneratorScriptEditor).
    // getDbSelection reads panel.sqlState LIVE (a closure, not a snapshot),
    // so switching the DB selector re-prioritizes suggestions immediately.
    panel.sqlEditor = {
        textarea, backdrop,
        getDbSelection: () => panel.sqlState.dbSelection,
    };
    attachSqlAutocomplete(panel.sqlEditor);

    // Ctrl+Enter runs the query from the keyboard - the main SQL Terminal's
    // own input never actually had this (only generator-script editors did,
    // via wireGeneratorScriptEditorBehavior's identical listener), even
    // though it's the most-used SQL-editing surface in the app. Skipped
    // while the autocomplete dropdown is open so it doesn't fire alongside
    // that listener's own plain-Enter accept-suggestion handling (both
    // listen on the same textarea).
    textarea.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !panel.sqlEditor.autocomplete.active) {
            e.preventDefault();
            sqlTerminalRun(textarea);
        }
    });
}

// ---- Shared results-table rendering (main SQL Terminal results AND the
// pop-out Data Viewer both build through these same functions/classes, so
// the two can never visually drift apart - see main.css's own comment on
// .sql-terminal-results for the same point from the style side). ----

// One row's <tr>. `editable` makes every data cell directly contenteditable
// with a dirty-marker on change (main.css's .cell-dirty) plus a trailing ×
// button to mark the whole row for deletion; `rowid`, when given, is
// stashed on the row (data-rowid) so collectResultsTableEdits can target it
// later regardless of how rows get reordered/removed in between.
function buildResultsRow(rowValues, editable, rowid) {
    const tr = document.createElement('tr');
    if (rowid !== undefined) tr.dataset.rowid = rowid;
    tr.__originalValues = rowValues.map((v) => (v === null ? 'NULL' : String(v)));
    tr.__originalValues.forEach((text, colIdx) => {
        const td = document.createElement('td');
        td.textContent = text;
        if (editable) {
            td.contentEditable = 'true';
            td.spellcheck = false;
            td.addEventListener('input', () => {
                td.classList.toggle('cell-dirty', td.textContent !== tr.__originalValues[colIdx]);
            });
            // A single-line cell value, not a text block - Enter confirms
            // (blurs) rather than inserting a newline into it, matching
            // every other single-line editable-cell UI.
            td.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); td.blur(); }
            });
        }
        tr.appendChild(td);
    });
    if (editable) {
        const delTd = document.createElement('td');
        delTd.className = 'results-row-delete';
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.textContent = '×';
        delBtn.title = 'Mark this row for deletion (applied on Save changes)';
        delBtn.onclick = () => {
            tr.dataset.deleted = tr.dataset.deleted === '1' ? '' : '1';
            tr.classList.toggle('results-row-deleted', tr.dataset.deleted === '1');
        };
        delTd.appendChild(delBtn);
        tr.appendChild(delTd);
    }
    return tr;
}

// The <table>/<thead> shell - just the header row plus an empty <tbody> for
// buildResultsRow's own output to stream into afterward (the main SQL
// Terminal appends rows across possibly several onRows batches; the Data
// Viewer appends them all at once - either way, into this same shell).
function buildResultsTableHead(columns, editable) {
    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const col of columns) {
        const th = document.createElement('th');
        th.textContent = col;
        headRow.appendChild(th);
    }
    if (editable) headRow.appendChild(document.createElement('th')); // blank header cell above the × column
    thead.appendChild(headRow);
    table.appendChild(thead);
    table.appendChild(document.createElement('tbody'));
    return table;
}

// Reads whatever's currently dirty/deleted in a table built by the two
// functions above and turns it into UPDATE/DELETE statements against
// `tableName` - each row's real rowid (captured on its own <tr> at render
// time) is the anchor, not its position, so this stays correct even after a
// delete reorders what's left. Only genuinely changed cells produce a SET
// clause; an untouched row produces no statement at all.
function collectResultsTableEdits(table, columns, tableName) {
    const statements = [];
    for (const tr of table.querySelectorAll('tbody tr')) {
        const rowid = tr.dataset.rowid;
        if (tr.dataset.deleted === '1') {
            statements.push(`DELETE FROM ${tableName} WHERE rowid = ${rowid}`);
            continue;
        }
        const cells = Array.from(tr.children).slice(0, columns.length); // excludes the trailing × cell
        const sets = [];
        cells.forEach((td, colIdx) => {
            const newVal = td.textContent;
            const oldVal = tr.__originalValues[colIdx];
            if (newVal !== oldVal) sets.push(`${columns[colIdx]} = '` + newVal.replace(/'/g, "''") + `'`);
        });
        if (sets.length > 0) statements.push(`UPDATE ${tableName} SET ${sets.join(', ')} WHERE rowid = ${rowid}`);
    }
    return statements;
}

// ---- SQL error line/char reporting ("SQL errors are to also report line
// number and char number... if possible") - built on sqlite3_error_offset()
// (sql_terminal.c's terminal_set_sqlite_error / replay_export.c's exec_sql),
// which only ever returns a byte offset for an error that references a
// specific token - most syntax errors and unresolved-identifier errors do,
// most runtime errors (constraint failures, etc.) don't and get -1, matching
// exactly the "if possible" the ask itself anticipated. ----

// A byte offset (SQLite's own unit - UTF-8 assumed) into 1-based
// {line, col} against `sqlText`. Encodes to real UTF-8 bytes first rather
// than assuming byte offset == JS string index, so this stays correct even
// when the SQL text itself contains non-ASCII characters (a non-ASCII chat
// message embedded in a query, a non-ASCII identifier, ...).
function sqlOffsetToLineCol(sqlText, byteOffset) {
    if (byteOffset == null || byteOffset < 0) return null;
    const bytes = new TextEncoder().encode(sqlText);
    const clamped = Math.min(byteOffset, bytes.length);
    const prefix = new TextDecoder().decode(bytes.slice(0, clamped));
    const lines = prefix.split('\n');
    return { line: lines.length, col: lines[lines.length - 1].length + 1 };
}

// Appends " (line N, char M)" when a real offset is available, otherwise
// returns `message` unchanged (offset -1/undefined - genuinely not knowable
// for this particular error, not a bug).
function formatSqlErrorMessage(message, sqlText, byteOffset) {
    const pos = sqlOffsetToLineCol(sqlText, byteOffset);
    return pos ? `${message} (line ${pos.line}, char ${pos.col})` : message;
}

// Runs `sql` into panel's own results area, building a real (optionally
// editable) table as rows stream in - shared by the user's own "Run" click
// and the post-save refresh (re-fetches the same query fresh rather than
// trusting an edit was applied verbatim, same principle the Data Viewer's
// own refresh already used). `writeBackTable`, when set (queryWriteBackTable),
// silently augments the query with its rowid (buildRowidFetchSql) so each
// row can be targeted by an edit later - that column is never shown, only
// used, and the "Save changes" button only appears when this is set.
function runSqlIntoResultsTable(panel, sql, dbSelection, writeBackTable) {
    const state = panel.sqlState;
    const statusEl = panel.querySelector('.sql-terminal-status');
    const resultsEl = panel.querySelector('.sql-terminal-results');
    const saveBtn = panel.querySelector('.sql-terminal-save-btn');
    const fetchSql = writeBackTable ? buildRowidFetchSql(sql, writeBackTable) : sql;
    const wasIdle = !activeSqlRequest && sqlRequestQueue.length === 0;
    statusEl.innerText = wasIdle ? 'Running...' : 'Queued...';
    resultsEl.innerHTML = '';
    state.resultColumns = [];
    state.resultRowCount = 0;
    state.lastResults = null;
    if (saveBtn) saveBtn.style.display = 'none';

    let table = null;
    let tbody = null;
    return new Promise((resolve) => {
        postSqlRequest({
            kind: 'sql', sql: fetchSql, panelEl: panel,
            onStart: () => { statusEl.innerText = 'Running...'; },
            onColumns: (columns) => {
                const displayColumns = writeBackTable ? columns.slice(1) : columns;
                state.resultColumns = displayColumns;
                table = buildResultsTableHead(displayColumns, !!writeBackTable);
                tbody = table.querySelector('tbody');
                resultsEl.appendChild(table);
            },
            onRows: (rows) => {
                if (!tbody) return;
                const frag = document.createDocumentFragment();
                for (const row of rows) {
                    const rowid = writeBackTable ? row[0] : undefined;
                    const values = writeBackTable ? row.slice(1) : row;
                    frag.appendChild(buildResultsRow(values, !!writeBackTable, rowid));
                }
                tbody.appendChild(frag);
                state.resultRowCount += rows.length;
            },
            onDone: (rowCount) => {
                statusEl.innerText = state.resultColumns.length > 0 ? `${rowCount} row(s), ${state.resultColumns.length} column(s).` : 'OK (no result set).';
                if (state.resultColumns.length > 0) {
                    state.lastResults = { sql, dbSelection, columns: state.resultColumns, writeBackTable };
                }
                if (saveBtn) saveBtn.style.display = writeBackTable ? '' : 'none';
                resolve();
            },
            onError: (message, offset) => {
                statusEl.innerText = 'Error: ' + formatSqlErrorMessage(message, fetchSql, offset);
                resolve();
            },
        });
    });
}

function sqlTerminalRun(btn) {
    if (!playbackWorker) return;
    const panel = btn.closest('[data-panel-type="sql-terminal-panel"]');
    const state = panel.sqlState;
    const textarea = panel.querySelector('.sql-terminal-input');
    let sql = textarea.value;
    if (!sql.trim()) return;
    sql = qualifyBareTableNames(sql, state.dbSelection);
    runSqlIntoResultsTable(panel, sql, state.dbSelection, queryWriteBackTable(sql));
}

// "add data modification ability directly to SQL results" - edits made
// directly in the results table (buildResultsRow's contenteditable cells
// and × delete buttons) are collected and applied here, then the exact same
// query is re-run fresh so the table reflects the DB's real post-write
// state (trigger side effects, etc.) rather than just trusting the edits
// were applied verbatim.
async function saveSqlTerminalResultsChanges(btn) {
    const panel = btn.closest('[data-panel-type="sql-terminal-panel"]');
    const state = panel.sqlState;
    const statusEl = panel.querySelector('.sql-terminal-status');
    const last = state.lastResults;
    if (!playbackWorker || !last || !last.writeBackTable) return;
    const table = panel.querySelector('.sql-terminal-results table');
    if (!table) return;
    const statements = collectResultsTableEdits(table, last.columns, last.writeBackTable);
    if (statements.length === 0) { statusEl.innerText = 'No changes.'; return; }
    statusEl.innerText = `Saving ${statements.length} change(s)...`;
    try {
        await runSqlStatementsInOrder(statements);
        statusEl.innerText = `Saved ${statements.length} change(s). Refreshing...`;
        await runSqlIntoResultsTable(panel, last.sql, last.dbSelection, last.writeBackTable);
    } catch (err) {
        statusEl.innerText = 'Save error: ' + err.message;
    }
}

// ---- Checkpoints: real SQLite SAVEPOINTs on the one shared connection
// every window ultimately queries - genuinely connection-wide, not
// per-window state, so "the current checkpoint" is kept as ONE global
// selection (per explicit direction: "the current checkpoint is to be
// global for simplicity") rather than each window tracking its own
// <select>'s value independently. Every SQL Terminal window AND the Schema
// Explorer share the exact same list and the exact same selection - picking
// one anywhere (setCurrentCheckpoint) updates it everywhere. #0 always
// exists once a database is loaded (sql_checkpoint_init_baseline,
// sql_terminal.c) - "the initial state", auto-created right after load, not
// something the user has to remember to save themselves. ----
let knownCheckpointIds = []; // e.g. [0, 1, 2] - populated as checkpoints are created; reset on triggerReset
let currentCheckpointId = null; // the one globally-selected checkpoint, or null before any database is loaded

function rebuildCheckpointDropdown(select) {
    const prevValue = select.value;
    select.innerHTML = '';
    for (const id of knownCheckpointIds) {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = id === 0 ? '#0 (initial state)' : `#${id}`;
        select.appendChild(opt);
    }
    const target = currentCheckpointId !== null ? String(currentCheckpointId) : prevValue;
    if (knownCheckpointIds.some((id) => String(id) === target)) select.value = target;
}

function refreshAllCheckpointDropdowns() {
    document.querySelectorAll('.sql-terminal-checkpoints, .schema-explorer-checkpoints')
        .forEach(rebuildCheckpointDropdown);
}

function broadcastCheckpointStatus(text) {
    document.querySelectorAll('[data-panel-type="sql-terminal-panel"] .sql-terminal-status')
        .forEach((el) => { el.innerText = text; });
    document.querySelectorAll('[data-panel-type="schema-explorer-panel"] .schema-explorer-checkpoint-status')
        .forEach((el) => { el.innerText = text; });
}

// Fired by any checkpoint <select>'s onchange - one dropdown's pick becomes
// THE global selection, and every other open dropdown (any window, either
// panel type) snaps to match it immediately.
function setCurrentCheckpoint(value) {
    const id = parseInt(value, 10);
    if (Number.isNaN(id)) return;
    currentCheckpointId = id;
    refreshAllCheckpointDropdowns();
}

function checkpointSave(btn) {
    if (playbackWorker) playbackWorker.postMessage({ type: 'checkpointSave' });
}

function onCheckpointSaved(id) {
    knownCheckpointIds.push(id);
    currentCheckpointId = id;
    refreshAllCheckpointDropdowns();
    broadcastCheckpointStatus(`Saved checkpoint #${id}.`);
}

function checkpointRevert(btn) {
    if (!playbackWorker) return;
    if (currentCheckpointId === null) { broadcastCheckpointStatus('No checkpoint selected.'); return; }
    playbackWorker.postMessage({ type: 'checkpointRevert', id: currentCheckpointId });
}

// ---- Multi-database SQL terminal: DB selector, schema explorer, editable
// generator scripts, syntax highlighting, autocomplete ----
// viewKind convention throughout (matches replay_export.c): 1 = replay.db
// (schema alias "r"), 2 = battle.db (schema alias "b").
//
// generatorScriptEditors/knownSchemas stay module-level globals, NOT
// per-window state: replay.db/battle.db are one shared attached schema each
// (there's one "r", one "b", regardless of how many windows are open), and
// the fetched table/column shape is a fact about the database, not a UI
// preference - every SQL Terminal/Schema Explorer window reads the SAME
// knownSchemas cache, and every generator-script editor (wherever it's
// rendered) edits the SAME underlying script.
//
// generatorScriptEditors[viewKind] is an ARRAY, not a single record - one
// entry per currently open editor for that schema (the one embedded in
// Schema Explorer's tree, plus any popped-out windows - see
// createGeneratorScriptPopoutPanel). Every entry stays text-synced with
// every other one for the same viewKind (syncGeneratorScriptText) and shows
// the same status (setAllGeneratorStatus) - they're different VIEWS onto the
// one script, not independent copies. Entries for elements no longer in the
// document (a closed pop-out, or Schema Explorer's own tree having been
// torn down and rebuilt by a refresh) are pruned lazily wherever this is
// iterated, rather than needing exact removal bookkeeping at every possible
// DOM-destruction site.
const generatorScriptEditors = {}; // viewKind -> [{textarea, backdrop, status}, ...]
let knownSchemas = {}; // schema name -> [{name, columns:[{name,type}]}] - populated by refreshSchemaExplorer, read by qualifyBareTableNames/autocomplete

function pruneDeadGeneratorScriptEditors(viewKind) {
    const list = generatorScriptEditors[viewKind];
    if (!list) return [];
    const alive = list.filter((e) => e.textarea.isConnected);
    generatorScriptEditors[viewKind] = alive;
    return alive;
}

// errorOffset (optional): a byte offset from sqlite3_error_offset() - see
// formatSqlErrorMessage's own comment. Computed per-editor against that
// editor's OWN textarea.value (not a single shared string built once) since
// that's the exact text the offset is actually relative to.
function setAllGeneratorStatus(viewKind, text, errorOffset) {
    const isError = text.startsWith('Error');
    for (const e of pruneDeadGeneratorScriptEditors(viewKind)) {
        e.status.innerText = isError ? formatSqlErrorMessage(text, e.textarea.value, errorOffset) : text;
        e.status.classList.toggle('is-error', isError);
    }
}

// Mirrors a text change from one generator-script editor into every OTHER
// open editor for the same viewKind - typing in a pop-out window updates the
// embedded one live, and vice versa, since they're editing the one shared
// script, not independent copies. `source` is excluded so the window
// actually being typed into never has its own cursor position clobbered by
// a redundant self-write.
function syncGeneratorScriptText(viewKind, text, source) {
    for (const e of pruneDeadGeneratorScriptEditors(viewKind)) {
        if (e.textarea === source) continue;
        e.textarea.value = text;
        renderSqlHighlightInto(e.textarea, e.backdrop);
        renderLineNumbersInto(e.textarea, e.gutter);
    }
}

function sqlTerminalDbChanged(selectEl) {
    const panel = selectEl.closest('[data-panel-type="sql-terminal-panel"]');
    const state = panel.sqlState;
    state.dbSelection = selectEl.value;
    const statusEl = panel.querySelector('.sql-terminal-db-status');
    if (state.dbSelection === 'main') { statusEl.innerText = ''; return; }
    if (!playbackWorker) return;
    const viewKind = state.dbSelection === 'replay' ? 1 : 2;
    statusEl.innerText = 'Building...';
    state.lastDbViewMatchIdx = latestFrame ? latestFrame.activeMatchIndex : -1;
    ensureDbViewAsync(viewKind).catch(() => {}); // coalesces with any other concurrent request for the same schema - see ensureDbViewAsync
}

// Called from the 'frame' handler on every response - re-attaches/rebuilds
// replay.db/battle.db automatically, for every currently open SQL Terminal
// window independently, when the timeline cursor moves to a different
// battle while one of them is selected in that window (the confirmed
// "follow the active battle" design) - a no-op for a window otherwise
// (replay_ensure_db_view's own cache-key check makes a same-battle
// re-request cheap regardless, but tracking the match index per-window here
// avoids even sending the message every single frame from every window).
function refreshDbViewForActiveBattleIfNeeded(activeMatchIndex) {
    for (const panel of document.querySelectorAll('[data-panel-type="sql-terminal-panel"]')) {
        const state = panel.sqlState;
        if (!state) continue;
        if (state.dbSelection === 'main') { state.lastDbViewMatchIdx = activeMatchIndex; continue; }
        if (activeMatchIndex === state.lastDbViewMatchIdx || activeMatchIndex < 0 || !playbackWorker) continue;
        state.lastDbViewMatchIdx = activeMatchIndex;
        const viewKind = state.dbSelection === 'replay' ? 1 : 2;
        panel.querySelector('.sql-terminal-db-status').innerText = 'Battle changed - rebuilding...';
        ensureDbViewAsync(viewKind).catch(() => {}); // coalesces with any other concurrent request for the same schema - see ensureDbViewAsync
    }
}

// Makes the currently active battle's own agent_states position bounds
// LOOK centered on screen - NOT main.wasm's set_map_bounds bounding box,
// which spans every battle in the whole loaded file - via main.wasm's
// set_view_shift, a render-only offset that never touches cam_x/cam_y
// itself (see that function's own comment for why: an earlier version of
// this moved the camera directly and got explicitly rejected for it).
// Called automatically every time the active battle changes, as long as
// cameraFollowActiveBattle is still true (the 'frame' handler above), and
// again on demand from the "Recenter Camera" menu button (resumeFollow),
// which turns following back on if a manual pan had turned it off. Reuses
// the exact same CURRENT_BATTLE_ROWID_LO()/CURRENT_BATTLE_ROWID_HI() SQL
// functions the terminal's own generator scripts already rely on to scope
// a query to just this battle's rows - no new query logic, just a MIN/MAX
// read over the existing columns, run through the same request queue every
// other one-off SQL read uses.
async function recenterCameraOnActiveBattle(resumeFollow) {
    if (!playbackWorker || !wasmInstance) return;
    if (resumeFollow) cameraFollowActiveBattle = true;
    try {
        const res = await runSchemaQueryAsync(
            'SELECT MIN(pos_x), MAX(pos_x), MIN(pos_y), MAX(pos_y) FROM agent_states ' +
            'WHERE id BETWEEN CURRENT_BATTLE_ROWID_LO() AND CURRENT_BATTLE_ROWID_HI()'
        );
        const row = res.rows[0];
        if (!row || row[0] == null) return; // no agent_states rows in this battle's slice - nothing to center on
        const centerX = (parseFloat(row[0]) + parseFloat(row[1])) / 2;
        const centerY = (parseFloat(row[2]) + parseFloat(row[3])) / 2;
        // Render-only shift, NOT the camera itself - see set_view_shift's
        // comment. get_cam_x()/get_cam_y() (and therefore CURSOR_X()/
        // CURSOR_Y()) are completely unaffected by this call.
        const shiftX = wasmInstance.exports.get_cam_x() - centerX;
        const shiftY = wasmInstance.exports.get_cam_y() - centerY;
        wasmInstance.exports.set_view_shift(shiftX, shiftY);
        // Phase 6: main.wasm has no getter for its own view_shift_x/y (main.js
        // is the only thing that ever sets them, right here) - tracked so
        // worldToScreen (the nato_symbol dom-overlay's projection) can apply
        // the exact same per-object shift render_frame's GL draw loop does,
        // without adding a getter export purely to read back a value this
        // function already computed itself.
        currentViewShiftX = shiftX;
        currentViewShiftY = shiftY;
    } catch (e) {
        appendToConsoleLog('[System] Could not recenter camera: ' + e.message);
    }
}

function updateDbStatusUI(viewKind, rebuilt, errorMessage, errorOffset) {
    const label = viewKind === 1 ? 'Replay DB' : 'Battle DB';
    const wantsSelection = viewKind === 1 ? 'replay' : 'battle';
    for (const panel of document.querySelectorAll('[data-panel-type="sql-terminal-panel"]')) {
        if (panel.sqlState && panel.sqlState.dbSelection === wantsSelection) {
            const statusEl = panel.querySelector('.sql-terminal-db-status');
            statusEl.innerText = errorMessage ? (label + ' error: ' + errorMessage) : (rebuilt ? label + ' rebuilt' : label + ' ready');
        }
    }
    setAllGeneratorStatus(viewKind, errorMessage ? ('Error: ' + errorMessage) : 'OK.', errorOffset);
}

function onDbViewReady(viewKind, rebuilt) {
    updateDbStatusUI(viewKind, rebuilt, null);
    const p = dbViewPending[viewKind];
    if (p) { delete dbViewPending[viewKind]; p.resolve(rebuilt); }
    // Keep every open Schema Explorer honest about what just got rebuilt,
    // without forcing a refresh on every unrelated query.
    if (rebuilt) {
        document.querySelectorAll('[data-panel-type="schema-explorer-panel"]').forEach((panel) => {
            if (getComputedStyle(panel).display !== 'none') refreshSchemaExplorerPanel(panel);
        });
    }
}
function onDbViewError(viewKind, message, offset) {
    updateDbStatusUI(viewKind, false, message, offset);
    const p = dbViewPending[viewKind];
    if (p) { delete dbViewPending[viewKind]; p.reject(new Error(message)); }
}

const dbViewPending = {}; // viewKind -> {resolve, reject} - see ensureDbViewAsync
// viewKind -> Promise of a request already posted to the worker but not yet
// resolved. Every caller of ensureDbViewAsync for the same viewKind (the
// schema explorer's own r-then-b sequence, a SQL Terminal window's DB
// selector, refreshDbViewForActiveBattleIfNeeded across every open window,
// and - since this session's schema-explorer auto-load change - simply
// showing/opening a Schema Explorer window) COALESCES onto this one shared
// promise instead of each posting its own 'ensureDbView' message: two
// overlapping real requests for the same schema made the C layer try to
// ATTACH it twice, surfacing as SQLite's own "database b is already in use"
// (a genuine race, confirmed reachable in practice, not hypothetical).
const dbViewInFlight = {};
function ensureDbViewAsync(viewKind) {
    if (dbViewInFlight[viewKind]) return dbViewInFlight[viewKind];
    const p = new Promise((resolve, reject) => {
        dbViewPending[viewKind] = { resolve, reject };
        playbackWorker.postMessage({ type: 'ensureDbView', viewKind });
    });
    dbViewInFlight[viewKind] = p.finally(() => { delete dbViewInFlight[viewKind]; });
    return dbViewInFlight[viewKind];
}

// ---- Schema explorer: PRAGMA database_list -> per-schema sqlite_master ->
// per-table PRAGMA table_info, all through the shared sqlRequestQueue above
// (kind:'schema') - the exact same sql_terminal_run/step exports the user's
// own queries use, just routed through their own onColumns/onRows/onDone
// callbacks so a background refresh never overwrites the results table the
// user is looking at in some OTHER window. No new WASM exports needed for
// any of this - genuinely dynamic, reflects whatever's actually attached
// right now. ----

// Every caller of this helper (ensureKnownSchemasBootstrapped, the schema
// explorer's own refresh, recenterCameraOnActiveBattle) is passive metadata/
// informational probing, never a direct user action someone's actively
// waiting on the instant they pressed something - background:true (see
// postSqlRequest) lets a real user action jump ahead of it in the shared
// queue instead of queuing FIFO behind however much of this is pending.
function runSchemaQueryAsync(sql) {
    return new Promise((resolve, reject) => {
        let columns = [];
        let rows = [];
        postSqlRequest({
            kind: 'schema', sql, background: true,
            onColumns: (c) => { columns = c; },
            onRows: (r) => { rows.push(...r); },
            onDone: () => resolve({ columns, rows }),
            onError: (message) => reject(new Error(message)),
        });
    });
}

function schemaDisplayLabel(schema) {
    if (schema === 'main') return 'Main';
    if (schema === 'r') return 'Replay DB';
    if (schema === 'b') return 'Battle DB';
    return schema;
}

// Entry point wired from main.html's onclick/onchange attributes (`this`) -
// resolves which Schema Explorer window this refers to, then delegates.
function refreshSchemaExplorer(el) {
    refreshSchemaExplorerPanel(el.closest('[data-panel-type="schema-explorer-panel"]'));
}

// Guards against a real feedback loop: this function's own ensureDbViewAsync
// calls can complete with rebuilt=true (playback's per-frame writes to main
// bump the same data-generation counter r/b's cache key is built from, so a
// rebuild can legitimately look "needed again" moments later), and
// onDbViewReady responds to ANY rebuild by re-refreshing every visible
// Schema Explorer - including this one, while it's still mid-refresh. Left
// unguarded that's a genuine unbounded loop (confirmed directly: the SQL
// request queue ran up into the tens of thousands within seconds). A panel
// already refreshing just skips the re-entrant call; the in-flight refresh
// will render the latest data anyway once it completes.
const schemaExplorerRefreshing = new WeakSet();

async function refreshSchemaExplorerPanel(panel) {
    if (schemaExplorerRefreshing.has(panel)) return;
    schemaExplorerRefreshing.add(panel);
    try {
        await refreshSchemaExplorerPanelInner(panel);
    } finally {
        schemaExplorerRefreshing.delete(panel);
    }
}

async function refreshSchemaExplorerPanelInner(panel) {
    const treeEl = panel.querySelector('.schema-explorer-tree');
    const statusEl = panel.querySelector('.schema-explorer-status');
    const hasRealTree = !!treeEl.querySelector('.schema-tree-schema');
    if (!playbackWorker) {
        if (!hasRealTree) treeEl.innerText = '(no database loaded)';
        return;
    }
    const filter = panel.querySelector('.schema-explorer-filter').value;
    // A background refresh (rebuilt-triggered, or the periodic re-check
    // this session's other fixes made much more frequent) leaves whatever
    // tree is ALREADY showing untouched while the new data loads - only the
    // status line says "Loading...". Wiping straight to a bare "Loading..."
    // string on every refresh was the actual flicker/reset the tree
    // appeared to have: expand/collapse state, scroll position, and an
    // in-progress generator-script edit all got destroyed and rebuilt from
    // scratch on every single automatic refresh, not just user-visible
    // ones. updateSchemaExplorerTree below patches the tree in place
    // instead of replacing it, so there's nothing left to reset once this
    // finishes either.
    statusEl.classList.remove('is-error');
    statusEl.innerText = 'Loading...';
    if (!hasRealTree) treeEl.innerText = 'Loading...';

    // The filter can name a schema (r/b) that isn't attached yet - build it
    // first so the tree can actually show it, same on-demand mechanism the
    // main DB selector uses.
    try {
        if (filter === 'all' || filter === 'r') await ensureDbViewAsync(1).catch(() => {});
        if (filter === 'all' || filter === 'b') await ensureDbViewAsync(2).catch(() => {});

        const dbListRes = await runSchemaQueryAsync('PRAGMA database_list');
        const nameIdx = dbListRes.columns.indexOf('name');
        let schemaNames = dbListRes.rows.map((r) => r[nameIdx]);
        if (filter !== 'all') schemaNames = schemaNames.filter((n) => n === filter);

        knownSchemas = {};
        for (const schema of schemaNames) {
            const tablesRes = await runSchemaQueryAsync(
                `SELECT name FROM ${schema}.sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name`
            );
            const tables = [];
            for (const row of tablesRes.rows) {
                const tableName = row[0];
                const colsRes = await runSchemaQueryAsync(`PRAGMA ${schema}.table_info(${tableName})`);
                const nameCol = colsRes.columns.indexOf('name');
                const typeCol = colsRes.columns.indexOf('type');
                const notNullCol = colsRes.columns.indexOf('notnull');
                const pkCol = colsRes.columns.indexOf('pk');

                // A view has no real foreign keys of its own - PRAGMA
                // foreign_key_list on one just returns zero rows, so this is
                // safe to call unconditionally rather than needing to know
                // table vs view ahead of time.
                const fkRes = await runSchemaQueryAsync(`PRAGMA ${schema}.foreign_key_list(${tableName})`);
                const fromCol = fkRes.columns.indexOf('from');
                const toCol = fkRes.columns.indexOf('to');
                const refTableCol = fkRes.columns.indexOf('table');
                const fkByColumn = {};
                for (const fkRow of fkRes.rows) {
                    fkByColumn[fkRow[fromCol]] = { table: fkRow[refTableCol], column: fkRow[toCol] };
                }

                tables.push({
                    name: tableName,
                    // Every value here comes back through sql_terminal_run's
                    // TEXT-only column reader (replay-worker.js's
                    // sql_terminal_column_text) regardless of the real
                    // SQLite column type - notnull/pk arrive as the STRINGS
                    // "0"/"1", not real numbers/booleans. `!!r[notNullCol]`
                    // would be true for EVERY row here ("0" is a non-empty,
                    // truthy JS string) - confirmed directly, this showed
                    // every column as PK/NOT NULL before the Number() below.
                    columns: colsRes.rows.map((r) => ({
                        name: r[nameCol],
                        type: r[typeCol],
                        notNull: Number(r[notNullCol]) !== 0,
                        // PRAGMA table_info's own pk column is the column's
                        // 1-based POSITION within a (possibly composite)
                        // primary key, 0 meaning "not part of it" - only
                        // whether it's nonzero matters here, not the order.
                        pk: Number(r[pkCol]) !== 0,
                        fk: fkByColumn[r[nameCol]] || null,
                    })),
                });
            }
            knownSchemas[schema] = tables;
        }
        statusEl.innerText = '';
        updateSchemaExplorerTree(panel, schemaNames);
    } catch (err) {
        // A transient failure (e.g. a busy database mid-rebuild) shouldn't
        // blank out an otherwise-still-valid tree - report it in the status
        // line and leave the tree exactly as it was. Only fall back to
        // replacing the tree itself when there was never anything real in
        // it to preserve.
        statusEl.classList.add('is-error');
        statusEl.innerText = 'Error: ' + err.message;
        if (!hasRealTree) treeEl.innerText = 'Error: ' + err.message;
    }
}

// Patches the tree in place instead of wiping and rebuilding it (the old
// renderSchemaExplorerTree always did `treeEl.innerHTML = ''` first) - this
// is what actually fixes the "flickers and resets on every SQL run" report:
// a full rebuild destroyed every node on every refresh (automatic ones
// included, which happen far more often than any user action - see
// refreshSchemaExplorerPanelInner's own comment), throwing away
// expand/collapse state (.collapsed), scroll position, and the generator-
// script editor's live textarea (focus/cursor/undo history) for no reason
// when the underlying schema usually hasn't actually changed at all.
//
// Reuses existing DOM nodes by name (data-schema-name/data-table-name) and
// only touches what's different: schemas/tables no longer present get
// removed, new ones get created, and an existing table's columns are only
// re-rendered when their content actually changed (tracked via a cheap
// JSON signature in data-col-sig) - a table whose row DATA changed but
// whose COLUMN LIST didn't (the overwhelmingly common case - schema
// explorer only ever shows the latter) touches nothing at all. Re-inserting
// an already-attached node via appendChild is a no-op reorder, not a
// destroy+recreate, which is what keeps declared order correct without
// ever discarding a node that's already right.
function updateSchemaExplorerTree(panel, schemaNames) {
    const treeEl = panel.querySelector('.schema-explorer-tree');
    if (schemaNames.length === 0) {
        if (!treeEl.querySelector('.schema-tree-schema')) {
            treeEl.innerText = '(nothing attached - select Replay DB/Battle DB above, or in the SQL terminal, to build one)';
        }
        return;
    }
    if (!treeEl.querySelector('.schema-tree-schema')) treeEl.innerHTML = ''; // clear a stray placeholder/loading string, not real nodes

    const wantedSchemas = new Set(schemaNames);
    for (const existing of Array.from(treeEl.querySelectorAll(':scope > .schema-tree-schema'))) {
        if (!wantedSchemas.has(existing.dataset.schemaName)) existing.remove();
    }

    for (const schema of schemaNames) {
        let schemaDiv = treeEl.querySelector(`:scope > .schema-tree-schema[data-schema-name="${schema}"]`);
        if (!schemaDiv) {
            schemaDiv = document.createElement('div');
            schemaDiv.className = 'schema-tree-node schema-tree-schema'; // starts expanded (no .collapsed) - matches the original default
            schemaDiv.dataset.schemaName = schema;
            const header = document.createElement('div');
            header.className = 'schema-tree-header';
            header.textContent = `${schemaDisplayLabel(schema)} (${schema})`;
            header.onclick = () => schemaDiv.classList.toggle('collapsed');
            schemaDiv.appendChild(header);
            const tablesDiv = document.createElement('div');
            tablesDiv.className = 'schema-tree-tables';
            schemaDiv.appendChild(tablesDiv);
        }
        updateSchemaTablesTree(schemaDiv.querySelector('.schema-tree-tables'), schema);

        if (schema === 'r' || schema === 'b') {
            // Built once and left alone from then on - buildGeneratorScriptEditor
            // already keeps itself in sync via generatorScriptEditors/
            // syncGeneratorScriptText; recreating it here on every refresh
            // would tear down and rebuild its live textarea (losing focus,
            // cursor position, and undo history) for no reason.
            if (!schemaDiv.querySelector('.generator-script-editor')) {
                schemaDiv.appendChild(buildGeneratorScriptEditor(schema === 'r' ? 1 : 2));
            }
        }

        treeEl.appendChild(schemaDiv); // no-op if already last in order, moves it into place otherwise - never destroys it
    }
}

function updateSchemaTablesTree(tablesDiv, schema) {
    const tables = knownSchemas[schema] || [];
    const wantedTables = new Set(tables.map((t) => t.name));
    for (const existing of Array.from(tablesDiv.querySelectorAll(':scope > .schema-tree-table'))) {
        if (!wantedTables.has(existing.dataset.tableName)) existing.remove();
    }

    for (const table of tables) {
        let tableDiv = tablesDiv.querySelector(`:scope > .schema-tree-table[data-table-name="${table.name}"]`);
        const sig = JSON.stringify(table.columns);
        if (!tableDiv) {
            tableDiv = document.createElement('div');
            tableDiv.className = 'schema-tree-node schema-tree-table collapsed'; // starts collapsed - matches the original default
            tableDiv.dataset.tableName = table.name;
            const tHeader = document.createElement('div');
            tHeader.className = 'schema-tree-header';
            tHeader.textContent = table.name;
            tHeader.onclick = () => tableDiv.classList.toggle('collapsed');
            tableDiv.appendChild(tHeader);
            const colsDiv = document.createElement('div');
            colsDiv.className = 'schema-tree-columns';
            tableDiv.appendChild(colsDiv);
        }
        if (tableDiv.dataset.colSig !== sig) {
            tableDiv.dataset.colSig = sig;
            renderSchemaTableColumns(tableDiv.querySelector('.schema-tree-columns'), table.columns);
        }
        tablesDiv.appendChild(tableDiv); // same no-op-reorder trick as the schema level above
    }
}

function renderSchemaTableColumns(colsDiv, columns) {
    colsDiv.innerHTML = ''; // a table's own column list is small and changes atomically as a whole - not worth diffing column-by-column
    for (const col of columns) {
        const colDiv = document.createElement('div');
        colDiv.className = 'schema-tree-column';
        const label = document.createElement('span');
        label.textContent = `${col.name} (${col.type || 'any'})`;
        colDiv.appendChild(label);
        if (col.pk) {
            const badge = document.createElement('span');
            badge.className = 'schema-tree-badge schema-tree-badge-pk';
            badge.textContent = 'PK';
            colDiv.appendChild(badge);
        }
        if (col.fk) {
            const badge = document.createElement('span');
            badge.className = 'schema-tree-badge schema-tree-badge-fk';
            badge.textContent = `FK → ${col.fk.table}.${col.fk.column}`;
            colDiv.appendChild(badge);
        }
        if (col.notNull) {
            const badge = document.createElement('span');
            badge.className = 'schema-tree-badge schema-tree-badge-notnull';
            badge.textContent = 'NOT NULL';
            colDiv.appendChild(badge);
        }
        colsDiv.appendChild(colDiv);
    }
}

// Resets a freshly cloned Schema Explorer window's own tree/filter back to a
// blank starting state (it otherwise inherits the ORIGINAL's last-rendered
// tree verbatim via cloneNode) - no extra event wiring needed beyond this:
// the cloned markup's onclick/onchange attributes already resolve their own
// panel via closest(), same as the original's.
function initSchemaExplorerInstance(panel) {
    panel.querySelector('.schema-explorer-tree').innerHTML = '';
    panel.querySelector('.schema-explorer-filter').value = 'all';
    panel.querySelector('.schema-explorer-checkpoint-status').innerText = '';
    rebuildCheckpointDropdown(panel.querySelector('.schema-explorer-checkpoints')); // checkpoints are global - see main.js's checkpoint section
    refreshSchemaExplorerPanel(panel); // load immediately, don't wait for a Refresh click
}

// ---- Editable generator scripts (replay_export.c's on-demand r/b views) ----

const defaultGeneratorSqlPending = {}; // viewKind -> resolve
function getDefaultGeneratorSqlAsync(viewKind) {
    return new Promise((resolve) => {
        defaultGeneratorSqlPending[viewKind] = resolve;
        playbackWorker.postMessage({ type: 'getDefaultGeneratorSql', viewKind });
    });
}
function onDefaultGeneratorSql(viewKind, sql) {
    const resolve = defaultGeneratorSqlPending[viewKind];
    if (resolve) { delete defaultGeneratorSqlPending[viewKind]; resolve(sql); }
}

// Builds one editor instance for a generator script - called for the
// embedded copy inside Schema Explorer's tree AND for every popped-out
// window (createGeneratorScriptPopoutPanel just wraps this same builder in
// its own panel chrome). Every instance this creates stays live-synced with
// every other open instance for the same viewKind - see
// syncGeneratorScriptText/setAllGeneratorStatus and the comment on
// generatorScriptEditors above.
// Shared behavior behind EVERY generator-script editor instance, regardless
// of which DOM/CSS shell it's mounted in (the compact tree-embedded widget
// below, or the dedicated pop-out editor further down) - highlighting,
// autocomplete, Run/Reset handlers, Ctrl+Enter-to-run, initial text
// population, and registration into generatorScriptEditors[viewKind] for
// cross-instance sync. `els` is {textarea, backdrop, status, runBtn?,
// resetBtn?} - runBtn/resetBtn are OPTIONAL (the pop-out has no buttons at
// all, only Ctrl+Enter - see buildGeneratorScriptPopoutEditor); the caller
// owns layout, this function owns behavior.
function wireGeneratorScriptEditorBehavior(viewKind, els) {
    const { textarea, backdrop, gutter, status, runBtn, resetBtn } = els;
    attachSqlHighlighting(textarea, backdrop, gutter);

    // Autocomplete ("everywhere SQL can be edited", not just the main SQL
    // Terminal) - same shared machinery, just pointed at this editor's own
    // elements. No getDbSelection override: a generator script mostly reads
    // FROM main (see the default scripts themselves) while writing INTO its
    // own r/b schema, so the plain 'main'-first candidate ordering
    // (autocompleteCandidates' default) fits better than prioritizing r/b.
    // onTextChanged propagates an autocomplete-accepted suggestion to every
    // other open editor for this viewKind, same as a normal keystroke does.
    const editor = { textarea, backdrop, gutter };
    editor.onTextChanged = () => syncGeneratorScriptText(viewKind, textarea.value, textarea);
    attachSqlAutocomplete(editor);
    textarea.addEventListener('input', () => syncGeneratorScriptText(viewKind, textarea.value, textarea));

    const runScript = () => {
        setAllGeneratorStatus(viewKind, 'Running...');
        playbackWorker.postMessage({ type: 'runGeneratorScript', viewKind, sql: textarea.value });
    };
    const resetScript = () => {
        setAllGeneratorStatus(viewKind, 'Resetting...');
        playbackWorker.postMessage({ type: 'resetGeneratorScript', viewKind });
        getDefaultGeneratorSqlAsync(viewKind).then((sql) => {
            textarea.value = sql;
            renderSqlHighlightInto(textarea, backdrop);
            renderLineNumbersInto(textarea, gutter);
            syncGeneratorScriptText(viewKind, sql, textarea);
        });
    };
    if (runBtn) { runBtn.textContent = 'Run'; runBtn.onclick = runScript; }
    if (resetBtn) { resetBtn.textContent = 'Reset to default'; resetBtn.onclick = resetScript; }

    // Ctrl+Enter runs the script from the keyboard, everywhere a generator
    // script can be edited - not just via a button, and the ONLY way to run
    // it in the pop-out (which has no Run button at all). Skipped while the
    // autocomplete dropdown is open so it doesn't fire alongside that
    // listener's own plain-Enter accept-suggestion handling (both listen on
    // the same textarea).
    textarea.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !editor.autocomplete.active) {
            e.preventDefault();
            runScript();
        }
    });

    // A brand new viewKind (nothing else open for it yet) starts from the
    // real default script; opening a SECOND view onto an already-open one
    // (a pop-out while the embedded editor already has something loaded -
    // possibly mid-edit, not yet saved as the new default) copies that
    // instance's CURRENT text instead, so popping out never silently
    // discards unsaved edits in favor of the stored default.
    const existing = pruneDeadGeneratorScriptEditors(viewKind);
    if (existing.length > 0) {
        textarea.value = existing[0].textarea.value;
        renderSqlHighlightInto(textarea, backdrop);
        renderLineNumbersInto(textarea, gutter);
    } else {
        getDefaultGeneratorSqlAsync(viewKind).then((sql) => {
            textarea.value = sql;
            renderSqlHighlightInto(textarea, backdrop);
            renderLineNumbersInto(textarea, gutter);
        }).catch(() => {
            textarea.value = '';
            renderSqlHighlightInto(textarea, backdrop);
            renderLineNumbersInto(textarea, gutter);
        });
    }
    generatorScriptEditors[viewKind] = existing.concat([{ textarea, backdrop, gutter, status }]);
}

function buildGeneratorScriptEditor(viewKind) {
    const wrap = document.createElement('div');
    wrap.className = 'generator-script-editor';

    const label = document.createElement('div');
    label.className = 'generator-script-label';
    label.textContent = 'Generator script (populates this schema - see Docs):';
    wrap.appendChild(label);

    // Row: line-number gutter (main.css's .generator-script-gutter) to the
    // left of the existing backdrop-<pre>-behind-transparent-textarea
    // technique the main terminal uses (renderSqlHighlightInto/
    // attachSqlHighlighting, above) - a separate flex sibling rather than
    // folded into the backdrop, so the backdrop/textarea's own pixel-perfect
    // box model (must match each other exactly) never has to account for a
    // variable-width number column. class-based CSS since multiple of these
    // can exist on screen at once, one per schema.
    const editorRow = document.createElement('div');
    editorRow.className = 'generator-script-editor-row';

    const gutter = document.createElement('pre');
    gutter.className = 'generator-script-gutter';
    gutter.setAttribute('aria-hidden', 'true');
    editorRow.appendChild(gutter);

    const editorWrap = document.createElement('div');
    editorWrap.className = 'generator-script-editor-wrap';

    const backdrop = document.createElement('pre');
    backdrop.className = 'generator-script-highlight';
    backdrop.setAttribute('aria-hidden', 'true');
    editorWrap.appendChild(backdrop);

    const textarea = document.createElement('textarea');
    textarea.rows = 6;
    textarea.className = 'generator-script-textarea';
    textarea.spellcheck = false;
    textarea.autocomplete = 'off';
    textarea.value = 'Loading...';
    editorWrap.appendChild(textarea);

    editorRow.appendChild(editorWrap);
    wrap.appendChild(editorRow);

    const btnRow = document.createElement('div');
    const runBtn = document.createElement('button');
    const resetBtn = document.createElement('button');
    const popoutBtn = document.createElement('button');
    popoutBtn.textContent = 'Open in window';
    popoutBtn.title = 'Edit this generator script in its own separate window, kept in sync with every other open copy';
    popoutBtn.onclick = () => createGeneratorScriptPopoutPanel(viewKind);
    btnRow.appendChild(runBtn);
    btnRow.appendChild(resetBtn);
    btnRow.appendChild(popoutBtn);
    wrap.appendChild(btnRow);

    const status = document.createElement('div');
    status.className = 'generator-script-status';
    wrap.appendChild(status);

    wireGeneratorScriptEditorBehavior(viewKind, { textarea, backdrop, gutter, status, runBtn, resetBtn });
    return wrap;
}

// The dedicated pop-out layout: a genuinely different, larger "proper text
// editor" shell (main.css's .generator-popout-* rules) - no buttons at all,
// the editor fills the entire window edge to edge and resizes with it, Run
// is Ctrl+Enter (wireGeneratorScriptEditorBehavior), and status/errors show
// in an Emacs-style minibuffer line pinned to the bottom instead of a
// toolbar. "Reset to default" is intentionally NOT available here - it
// stays exclusive to the compact schema-explorer-embedded editor below.
// Behavior is otherwise 100% shared with that compact widget via
// wireGeneratorScriptEditorBehavior; only the DOM differs.
function buildGeneratorScriptPopoutEditor(viewKind) {
    const root = document.createElement('div');
    root.className = 'generator-popout-root';

    // Row: line-number gutter + the existing backdrop/textarea pair, same
    // split as the compact editor above - a flex sibling, not folded into
    // the backdrop, so that box model stays exactly what it was.
    const editorRow = document.createElement('div');
    editorRow.className = 'generator-popout-editor-row';

    const gutter = document.createElement('pre');
    gutter.className = 'generator-popout-gutter';
    gutter.setAttribute('aria-hidden', 'true');
    editorRow.appendChild(gutter);

    const editorWrap = document.createElement('div');
    editorWrap.className = 'generator-popout-editor-wrap';

    const backdrop = document.createElement('pre');
    backdrop.className = 'generator-popout-highlight';
    backdrop.setAttribute('aria-hidden', 'true');
    editorWrap.appendChild(backdrop);

    const textarea = document.createElement('textarea');
    textarea.className = 'generator-popout-textarea';
    textarea.spellcheck = false;
    textarea.autocomplete = 'off';
    textarea.value = 'Loading...';
    editorWrap.appendChild(textarea);

    editorRow.appendChild(editorWrap);
    root.appendChild(editorRow);

    const status = document.createElement('div');
    status.className = 'generator-popout-minibuffer';
    root.appendChild(status);

    wireGeneratorScriptEditorBehavior(viewKind, { textarea, backdrop, gutter, status });
    return root;
}

// Pops a generator-script editor out into its own independent, draggable/
// resizable/closable window - built the same way the SQL Data Viewer is
// (task #68 Part 4: a fresh panel with no static main.html markup, wired
// through the same wirePanelInstance every other window uses), but UNLIKE
// the Data Viewer this one stays LIVE-SYNCED with wherever else the same
// script is open (buildGeneratorScriptEditor/syncGeneratorScriptText),
// rather than being a frozen snapshot.
function createGeneratorScriptPopoutPanel(viewKind) {
    const label = viewKind === 1 ? 'Replay DB (r)' : 'Battle DB (b)';
    const panel = document.createElement('div');
    panel.className = 'ui-panel';
    panel.setAttribute('data-panel-type', 'generator-script-popout-panel');

    const header = document.createElement('div');
    header.className = 'panel-header';
    const title = document.createElement('span');
    title.textContent = `[Generator Script: ${label}]`;
    const controls = document.createElement('span');
    controls.className = 'panel-header-controls';
    controls.innerHTML = '<span class="toggle-icon">-</span><span class="panel-maximize-btn" title="Maximize window"></span><span class="panel-close-btn" title="Close window">&times;</span>';
    header.appendChild(title);
    header.appendChild(controls);
    panel.appendChild(header);
    panel.appendChild(document.createElement('div')).className = 'panel-content';

    document.body.appendChild(panel);
    wirePanelInstance(panel);

    const content = panel.querySelector('.panel-content');
    ensurePanelZoomWrap(content).appendChild(buildGeneratorScriptPopoutEditor(viewKind));

    const alreadyVisible = document.querySelectorAll('[data-panel-type="generator-script-popout-panel"]').length - 1;
    const offset = alreadyVisible * 30;
    panel.style.top = (20 + offset) + 'px';
    panel.style.right = (20 + offset) + 'px';
    panel.style.left = 'auto';
    panel.style.bottom = 'auto';
    panel.style.zIndex = String(++panelZIndexCounter);
    panel.style.display = 'flex';
    return panel;
}

// ---- Query auto-qualification: best-effort convenience, not required (you
// can always type r./b. explicitly) - rewrites bare table-name references
// that match a KNOWN table in the selected non-main schema, using the real
// tokenizer so string/comment/quoted-identifier contents and already-
// qualified references (x.y) are never touched. ----

function tokenNear(tokens, i, dir) {
    for (let k = i + dir; k >= 0 && k < tokens.length; k += dir) {
        if (tokens[k].type !== 'whitespace' && tokens[k].type !== 'comment') return tokens[k];
    }
    return null;
}

function qualifyBareTableNames(sql, dbSelection) {
    if (dbSelection === 'main' || typeof tokenizeSQL !== 'function') return sql;
    const schema = dbSelection === 'replay' ? 'r' : 'b';
    const tableNames = new Set((knownSchemas[schema] || []).map((t) => t.name));
    if (tableNames.size === 0) return sql;

    const tokens = tokenizeSQL(sql);
    let out = '';
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.type === 'identifier' && tableNames.has(t.text)) {
            const prev = tokenNear(tokens, i, -1);
            const next = tokenNear(tokens, i, 1);
            const alreadyQualified = prev && prev.type === 'punctuation' && prev.text === '.';
            const isSchemaPart = next && next.type === 'punctuation' && next.text === '.';
            out += (alreadyQualified || isSchemaPart) ? t.text : (schema + '.' + t.text);
        } else {
            out += t.text;
        }
    }
    return out;
}

// ---- SQL Data Viewer eligibility (task #68 Part 4): reuses the exact same
// tokenizer as highlighting/auto-qualification above, no separate parser -
// determines whether a query is a plain single-table SELECT (optionally
// schema-qualified, e.g. r.agent_states) with no JOIN/GROUP BY/set operator
// and no old-style comma-join (`FROM a, b`), which is the only shape where
// "this row" has an unambiguous rowid to target an UPDATE/DELETE at. Returns
// the table reference string (e.g. "agent_states" or "r.agent_states") when
// eligible, or null otherwise - null means the popped-out viewer opens
// read-only rather than silently allowing edits that couldn't be saved back
// anywhere sensible. ----
const WRITE_BACK_FORBIDDEN_KEYWORDS = new Set(['JOIN', 'GROUP', 'UNION', 'INTERSECT', 'EXCEPT']);
function queryWriteBackTable(sql) {
    if (typeof tokenizeSQL !== 'function') return null;
    const tokens = tokenizeSQL(sql).filter((t) => t.type !== 'whitespace' && t.type !== 'comment');
    // Must itself be a top-level SELECT - without this, an UPDATE/DELETE/
    // INSERT whose WHERE clause happens to contain a "(SELECT ... FROM ...)"
    // subquery would find that nested FROM instead (tokens are flat, with no
    // paren-depth awareness below) and get misclassified as an eligible
    // write-back SELECT, corrupting the actual statement when
    // buildRowidFetchSql then splices a rowid column into that subquery.
    if (!(tokens[0] && tokens[0].type === 'keyword' && tokens[0].text.toUpperCase() === 'SELECT')) return null;
    for (const t of tokens) {
        if (t.type === 'keyword' && WRITE_BACK_FORBIDDEN_KEYWORDS.has(t.text.toUpperCase())) return null;
    }
    const fromIdx = tokens.findIndex((t) => t.type === 'keyword' && t.text.toUpperCase() === 'FROM');
    if (fromIdx < 0) return null;
    let i = fromIdx + 1;
    const isNameToken = (t) => t && (t.type === 'identifier' || t.type === 'quoted_identifier');
    if (!isNameToken(tokens[i])) return null;
    let tableRef = tokens[i].text;
    i++;
    if (tokens[i] && tokens[i].type === 'punctuation' && tokens[i].text === '.') {
        i++;
        if (!isNameToken(tokens[i])) return null;
        tableRef += '.' + tokens[i].text;
        i++;
    }
    // Old-style comma-join (`FROM a, b`) has no JOIN keyword to catch above.
    if (tokens[i] && tokens[i].type === 'punctuation' && tokens[i].text === ',') return null;
    return tableRef;
}

// ---- Syntax highlighting: backdrop <pre> rendered exactly under the real
// textarea (sql-tokenizer.js drives the token classification; the CSS side
// of this - transparent textarea text, matching font metrics - lives in
// main.css). ----

const SQL_TOKEN_CSS_CLASS = {
    keyword: "tok-keyword", identifier: "tok-identifier", quoted_identifier: "tok-identifier",
    string: "tok-string", blob: "tok-string", number: "tok-number", comment: "tok-comment",
    bind_param: "tok-param", operator: "tok-operator", punctuation: "tok-punct",
};

function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Pure tokenize -> colored-span HTML string, shared by every highlighted
// surface (the main terminal's backdrop, each generator-script editor's own
// backdrop, and the docs panel's static <code> examples) - one real
// tokenizer, one rendering rule, reused everywhere rather than re-derived
// per surface.
function highlightedSqlHtml(text) {
    if (typeof tokenizeSQL !== 'function') return escapeHtml(text);
    let html = '';
    for (const t of tokenizeSQL(text)) {
        const cls = SQL_TOKEN_CSS_CLASS[t.type];
        const escaped = escapeHtml(t.text);
        html += cls ? `<span class="${cls}">${escaped}</span>` : escaped;
    }
    return html;
}

// Renders `textarea`'s current text into `backdrop` as colored spans -
// generic over which textarea/backdrop pair, so the same function drives
// the main SQL terminal input and every generator-script editor's own
// backdrop (buildGeneratorScriptEditor, below) instead of a copy per
// surface.
function renderSqlHighlightInto(textarea, backdrop) {
    if (!textarea || !backdrop) return;
    const text = textarea.value;
    // A textarea always keeps room for one more line after a trailing '\n' -
    // matching that here keeps the backdrop's height in sync.
    backdrop.innerHTML = highlightedSqlHtml(text) + (text.endsWith('\n') ? ' ' : '');
    backdrop.scrollTop = textarea.scrollTop;
    backdrop.scrollLeft = textarea.scrollLeft;
}

// Line-number gutter (task: "add line numbers to schema pop out editor and
// to internal schema sql editor itself") - a separate <pre> to the LEFT of
// the editor, not folded into the highlighting backdrop, so the backdrop's
// own pixel-perfect box model (must match the real textarea exactly, see
// renderSqlHighlightInto's comment) never has to account for a variable-
// width number column. `gutter` is optional and a no-op when absent (the
// main SQL Terminal's own input has no gutter - out of scope here, only the
// generator-script/render-query editors this drives get one).
//
// gutter.style.height is set explicitly here, every call, to the textarea's
// OWN real rendered height - this is load-bearing, not cosmetic. Every
// gutter'd editor's row is `display:flex; align-items:stretch` over
// [gutter (flex:0 0 auto, sized by its own text content), editor-wrap
// (flex:1 1 auto, sized by the textarea inside it)]. Left to natural
// flex sizing, a gutter's PREFERRED height is driven by how many line
// numbers it contains - for a long query/script, that height can exceed
// the textarea's own (rows-based or user-resized) height, and
// align-items:stretch then inflates the WHOLE ROW - editor-wrap included -
// to match the taller gutter. Since editor-wrap's absolutely-positioned
// backdrop spans edge-to-edge of editor-wrap (top/right/bottom/left:0), it
// grows right along with it - past where the real (invisible) textarea's
// own typing/scrolling area actually ends. That gap is exactly the
// symptom reported and reproduced by hand: colored text extending below
// where the cursor can actually go, and a native scrollbar whose thumb
// implies far more hidden content than what's really there. Two
// separately-authored CSS blocks (gutter vs. textarea) were never going to
// reliably agree on this by hand - the max line count is content-
// dependent and can't be predicted in CSS at all. Pinning gutter's height
// to the textarea's real, measured height turns "must stay in sync"
// from a convention someone has to remember into an invariant this
// function enforces on every single call (also re-run from the
// ResizeObserver in attachSqlHighlighting below, so a native
// resize-drag - which fires neither 'input' nor 'scroll' - can't leave it
// stale either).
function renderLineNumbersInto(textarea, gutter) {
    if (!textarea || !gutter) return;
    const lineCount = textarea.value.split('\n').length;
    // Only actually rebuild the text when the count changes - cheap check
    // avoids pointless DOM churn on every keystroke within the same line.
    if (gutter.dataset.lineCount !== String(lineCount)) {
        gutter.dataset.lineCount = String(lineCount);
        let text = '';
        for (let i = 1; i <= lineCount; i++) text += i + '\n';
        gutter.textContent = text;
    }
    gutter.style.height = textarea.offsetHeight + 'px';
    gutter.scrollTop = textarea.scrollTop;
}

// Wires live highlighting (+ line numbers, when `gutter` is given) onto any
// textarea+backdrop pair (input/scroll listeners only - autocomplete stays
// specific to the main terminal, see updateAutocomplete's own dedicated
// wiring below, since a generator script's own identifier vocabulary -
// table/column names it's ABOUT to populate - isn't the settled "known
// schema" autocomplete already relies on). Used for the main terminal's own
// pair (no gutter), and for each dynamically created generator-script editor
// (gutter given - see buildGeneratorScriptEditor/buildGeneratorScriptPopoutEditor).
function attachSqlHighlighting(textarea, backdrop, gutter) {
    textarea.addEventListener('input', () => {
        renderSqlHighlightInto(textarea, backdrop);
        renderLineNumbersInto(textarea, gutter);
    });
    textarea.addEventListener('scroll', () => {
        backdrop.scrollTop = textarea.scrollTop;
        backdrop.scrollLeft = textarea.scrollLeft;
        if (gutter) gutter.scrollTop = textarea.scrollTop;
    });
    // Dragging a textarea's native resize handle (CSS resize:vertical,
    // every one of these editors has it) fires NEITHER 'input' NOR 'scroll'
    // - so without this, the backdrop's own scroll position (and thus which
    // lines of colored text line up with the real, invisible textarea
    // content underneath), and the gutter's own pinned height (see
    // renderLineNumbersInto's own comment on why that pin is load-bearing),
    // can both go stale the moment the textarea's real size changes, until
    // the next keystroke or manual scroll happens to fire and correct them.
    // A real, reported symptom this causes: colored text appearing to drift
    // out of sync with where the cursor actually is after resizing.
    // ResizeObserver is the same established pattern this codebase already
    // uses for the identical "native resize doesn't fire the events I'd
    // normally listen for" gap (see the chat panel's own
    // reanchorChatBottom/ResizeObserver pairing).
    new ResizeObserver(() => {
        renderLineNumbersInto(textarea, gutter); // re-pins gutter height to the textarea's new size
        backdrop.scrollTop = textarea.scrollTop;
        backdrop.scrollLeft = textarea.scrollLeft;
        if (gutter) gutter.scrollTop = textarea.scrollTop;
    }).observe(textarea);
    renderSqlHighlightInto(textarea, backdrop);
    renderLineNumbersInto(textarea, gutter);
}

// One-shot highlighting for STATIC code (the docs panel's <code> examples) -
// no backdrop overlay needed since there's nothing to keep in sync with:
// it's not editable, so this just replaces the element's own text with the
// same tokenizer's colored spans, once.
function highlightStaticCode(codeElement) {
    codeElement.innerHTML = highlightedSqlHtml(codeElement.textContent);
}

// One-shot: the docs panel's <code> snippets are static SQL examples, not
// live-edited text - applied once here (after SQL_TOKEN_CSS_CLASS/
// highlightedSqlHtml above are actually initialized - a top-of-file call
// site would hit a temporal-dead-zone ReferenceError against those, since
// `const`/`function` bodies referencing them only become safe to invoke
// once script execution actually reaches their own declarations) rather
// than wiring up a backdrop overlay there's nothing to keep in sync with.
document.querySelectorAll('.sql-docs-content code').forEach(highlightStaticCode);

// ---- Autocomplete: tokenizer-based caret-token detection (not a word-
// boundary regex - correctly excludes matches inside strings/comments/
// quoted identifiers), mirror-div caret pixel positioning (the standard
// technique for a plain <textarea>, which exposes no caret-coordinate API
// of its own). ----

const SQL_VARIABLE_FUNCTIONS = [
    "CURRENT_TICK", "CURRENT_TIME", "CURRENT_BATTLE", "CURRENT_BATTLE_TICK_START",
    "CURRENT_BATTLE_TICK_END", "CURRENT_BATTLE_ROWID_LO", "CURRENT_BATTLE_ROWID_HI",
    "CURSOR_X", "CURSOR_Y",
];

// ---- Generic autocomplete - works on ANY SQL textarea, not just the main
// SQL Terminal's. An "editor" here is a plain object bundling everything
// autocomplete needs to operate on one textarea:
//   { textarea, backdrop, getDbSelection?, onTextChanged? }
// getDbSelection is optional (defaults to 'main' priority ordering - see
// autocompleteCandidates); onTextChanged is called after autocomplete edits
// the textarea's value programmatically (accepting a suggestion doesn't
// fire a real 'input' event), so callers that need to react to text changes
// - generator-script editors syncing to their other open windows - still see
// it. attachSqlAutocomplete (below) wires the actual event listeners; this
// section is just the shared state-machine the main SQL Terminal and every
// generator-script editor both drive through the same code.
//
// The suggestion list itself is ONE shared floating popup (below), not an
// element embedded per-editor - only one textarea can have an active
// autocomplete session at a time (blur hides it), so a single
// position:fixed element reused across every editor, appended straight to
// <body> above every panel's own stacking context, is both simpler and the
// only way it can never be clipped by whichever panel it's summoned from -
// an embedded, per-panel-contained list was exactly the old bug: typing on
// a bottom line left the popup rendering partly (or fully) behind the
// panel's own border/overflow, or underneath a neighboring window. ----

function autocompleteCandidates(dbSelection) {
    const order = dbSelection === 'replay' ? ['r', 'b', 'main'] : dbSelection === 'battle' ? ['b', 'r', 'main'] : ['main', 'r', 'b'];
    const candidates = [];
    for (const schema of order) {
        for (const table of knownSchemas[schema] || []) {
            candidates.push({ text: table.name, kind: 'table' });
            for (const col of table.columns) candidates.push({ text: col.name, kind: 'column' });
        }
    }
    for (const fn of SQL_VARIABLE_FUNCTIONS) candidates.push({ text: fn + '()', kind: 'variable' });
    for (const kw of SQL_KEYWORDS) candidates.push({ text: kw, kind: 'keyword' });
    return candidates;
}

// The one shared popup - see the section comment above for why a single
// element, not one per editor. Lazily created (mirrors caretMirrorEl
// below), position:fixed and above every panel (main.css).
let sharedAutocompleteList = null;
// Which editor's suggestions the shared popup currently shows - see
// hideAutocomplete's own comment on why this matters.
let sharedAutocompleteOwner = null;
function ensureSharedAutocompleteList() {
    if (sharedAutocompleteList) return sharedAutocompleteList;
    sharedAutocompleteList = document.createElement('div');
    sharedAutocompleteList.className = 'autocomplete-list';
    sharedAutocompleteList.style.display = 'none';
    document.body.appendChild(sharedAutocompleteList);
    return sharedAutocompleteList;
}

function hideAutocomplete(editor) {
    editor.autocomplete = { active: false, items: [], selectedIndex: 0, tokenStart: 0, tokenEnd: 0 };
    // Only actually hide the shared DOM popup if THIS editor is the one
    // currently showing in it. A blur's hide is delayed 150ms (so a
    // suggestion's own mousedown still lands first) - within that window,
    // focus can already have moved to a DIFFERENT editor that rendered its
    // OWN suggestions into the same shared element, and that popup must not
    // vanish out from under it just because the PREVIOUS editor's delayed
    // hide finally fires. Confirmed reproducible: moving focus straight from
    // one SQL-editing textarea into another and typing immediately hit this
    // race in practice, not just in theory.
    if (sharedAutocompleteList && sharedAutocompleteOwner === editor) {
        sharedAutocompleteList.style.display = 'none';
        sharedAutocompleteOwner = null;
    }
}

function renderAutocompleteList(editor) {
    const ac = editor.autocomplete;
    const list = ensureSharedAutocompleteList();
    sharedAutocompleteOwner = editor;
    list.innerHTML = '';
    ac.items.forEach((item, i) => {
        const div = document.createElement('div');
        div.className = 'autocomplete-item' + (i === ac.selectedIndex ? ' selected' : '');
        div.textContent = item.text;
        div.title = item.kind;
        div.onmousedown = (e) => { e.preventDefault(); acceptAutocomplete(editor, i); };
        list.appendChild(div);
    });
    list.style.display = ac.items.length ? 'block' : 'none';
}

// Shared, transient scratch element (not per-editor state) - only ever
// measures whichever textarea currently has focus, and only one can at a
// time, so there's nothing to gain from a per-instance copy.
let caretMirrorEl = null;
// Positions the shared popup in real VIEWPORT coordinates (position:fixed),
// Emacs corfu-style: below the caret's line by default (like every other
// completion popup), flipped above it only when there's genuinely more room
// there, and clamped into the viewport either way so a window near a screen
// edge never pushes it partly or fully off-screen - the exact bug this
// floating-popup redesign exists to fix (an embedded, per-panel list could
// render behind the panel's own border on a bottom line, with nowhere to
// escape to).
function positionAutocompleteList(editor) {
    const ac = editor.autocomplete;
    const textarea = editor.textarea;
    const list = ensureSharedAutocompleteList();
    if (!caretMirrorEl) {
        caretMirrorEl = document.createElement('div');
        caretMirrorEl.style.position = 'absolute';
        caretMirrorEl.style.visibility = 'hidden';
        caretMirrorEl.style.whiteSpace = 'pre-wrap';
        caretMirrorEl.style.wordBreak = 'break-word';
        caretMirrorEl.style.top = '0';
        caretMirrorEl.style.left = '0';
        document.body.appendChild(caretMirrorEl);
    }
    const cs = getComputedStyle(textarea);
    for (const prop of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'padding', 'border', 'boxSizing']) {
        caretMirrorEl.style[prop] = cs[prop];
    }
    caretMirrorEl.style.width = textarea.clientWidth + 'px';
    caretMirrorEl.textContent = textarea.value.slice(0, ac.tokenEnd);
    const marker = document.createElement('span');
    marker.textContent = '​';
    caretMirrorEl.appendChild(marker);

    const mirrorRect = caretMirrorEl.getBoundingClientRect();
    const markerRect = marker.getBoundingClientRect();
    const textareaRect = textarea.getBoundingClientRect();
    // Unitless line-height (every textarea style here uses one) resolves to
    // a real px value in getComputedStyle - the fallback chain only matters
    // if that were ever untrue (e.g. the browser returning "normal" as-is).
    const lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2 || 16;

    const caretX = textareaRect.left + (markerRect.left - mirrorRect.left) - textarea.scrollLeft;
    const caretTop = textareaRect.top + (markerRect.top - mirrorRect.top) - textarea.scrollTop;
    const caretBottom = caretTop + lineHeight;

    // renderAutocompleteList (called before this, in updateAutocomplete)
    // already set display:block, so real offsetWidth/Height are available
    // to measure before deciding where to place it.
    const listHeight = list.offsetHeight;
    const listWidth = list.offsetWidth;
    const margin = 4;

    const spaceBelow = window.innerHeight - caretBottom;
    const spaceAbove = caretTop;
    let top = (spaceBelow >= listHeight || spaceBelow >= spaceAbove) ? caretBottom : (caretTop - listHeight);
    top = Math.max(margin, Math.min(top, window.innerHeight - listHeight - margin));

    const left = Math.max(margin, Math.min(caretX, window.innerWidth - listWidth - margin));

    list.style.left = left + 'px';
    list.style.top = top + 'px';
}

function updateAutocomplete(editor) {
    const textarea = editor.textarea;
    if (!textarea || typeof tokenizeSQL !== 'function') return;
    const pos = textarea.selectionStart;
    if (pos !== textarea.selectionEnd) { hideAutocomplete(editor); return; } // no suggestions over a real selection
    const tokens = tokenizeSQL(textarea.value);
    const tok = tokenAtPosition(tokens, pos);
    if (!tok || (tok.type !== 'identifier' && tok.type !== 'keyword')) { hideAutocomplete(editor); return; }
    const prefix = tok.text.slice(0, pos - tok.start).toUpperCase();
    if (!prefix) { hideAutocomplete(editor); return; }

    const dbSelection = editor.getDbSelection ? editor.getDbSelection() : 'main';
    const matches = autocompleteCandidates(dbSelection)
        .filter((c) => c.text.toUpperCase().startsWith(prefix) && c.text.toUpperCase() !== prefix)
        .filter((c, i, arr) => arr.findIndex((o) => o.text === c.text) === i) // de-dupe (same column name across schemas, etc.)
        .slice(0, 20);
    if (matches.length === 0) { hideAutocomplete(editor); return; }

    editor.autocomplete = { active: true, items: matches, selectedIndex: 0, tokenStart: tok.start, tokenEnd: pos };
    renderAutocompleteList(editor);
    positionAutocompleteList(editor);
}

function acceptAutocomplete(editor, index) {
    const ac = editor.autocomplete;
    const textarea = editor.textarea;
    const item = ac.items[index !== undefined ? index : ac.selectedIndex];
    if (!item) return;
    const before = textarea.value.slice(0, ac.tokenStart);
    const after = textarea.value.slice(ac.tokenEnd);
    textarea.value = before + item.text + after;
    const newPos = before.length + item.text.length;
    textarea.selectionStart = textarea.selectionEnd = newPos;
    hideAutocomplete(editor);
    renderSqlHighlightInto(textarea, editor.backdrop);
    renderLineNumbersInto(textarea, editor.gutter);
    textarea.focus();
    if (editor.onTextChanged) editor.onTextChanged();
}

// Wires up the actual keyboard/mouse event listeners an autocomplete
// "editor" needs (see the section comment above for the editor object
// shape) - called once per textarea, whether that's the main SQL Terminal's
// own input or a generator-script editor, embedded or popped out.
function attachSqlAutocomplete(editor) {
    editor.autocomplete = { active: false, items: [], selectedIndex: 0, tokenStart: 0, tokenEnd: 0 };
    const textarea = editor.textarea;
    textarea.addEventListener('input', () => updateAutocomplete(editor));
    textarea.addEventListener('click', () => hideAutocomplete(editor));
    textarea.addEventListener('blur', () => setTimeout(() => hideAutocomplete(editor), 150)); // delayed so a suggestion's mousedown still lands first
    textarea.addEventListener('keydown', (e) => {
        const ac = editor.autocomplete;
        if (!ac.active) return;
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            ac.selectedIndex = (ac.selectedIndex + 1) % ac.items.length;
            renderAutocompleteList(editor);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            ac.selectedIndex = (ac.selectedIndex - 1 + ac.items.length) % ac.items.length;
            renderAutocompleteList(editor);
        } else if (e.key === 'Tab' || e.key === 'Enter') {
            e.preventDefault();
            acceptAutocomplete(editor);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            hideAutocomplete(editor);
        }
    });
}

// Autocomplete's table/column candidates come entirely from knownSchemas - a
// SHARED cache (see its declaration above), so this bootstrap genuinely only
// needs to run ONCE regardless of how many SQL Terminal windows exist -
// without it, autocomplete would silently only ever suggest keywords/
// variable functions until the user happened to open Schema Explorer at
// least once. Fetching just "main" here (not the full all-databases flow
// refreshSchemaExplorer's own filter dropdown drives, which would also
// force-attach r/b the user may never want) the first time ANY terminal
// window is actually used gets real table/column suggestions working
// immediately, with no visible extra step.
let knownSchemasBootstrapped = false;
async function ensureKnownSchemasBootstrapped() {
    if (knownSchemasBootstrapped || !playbackWorker) return;
    knownSchemasBootstrapped = true;
    try {
        const tablesRes = await runSchemaQueryAsync(
            "SELECT name FROM main.sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name"
        );
        const tables = [];
        for (const row of tablesRes.rows) {
            const tableName = row[0];
            const colsRes = await runSchemaQueryAsync(`PRAGMA main.table_info(${tableName})`);
            const nameCol = colsRes.columns.indexOf('name');
            const typeCol = colsRes.columns.indexOf('type');
            tables.push({ name: tableName, columns: colsRes.rows.map((r) => ({ name: r[nameCol], type: r[typeCol] })) });
        }
        knownSchemas.main = tables;
    } catch (err) {
        knownSchemasBootstrapped = false; // let a later focus try again
    }
}

// Initializes the ORIGINAL singleton instance of each type at startup -
// clones get the same treatment from openNewPanelInstance instead.
initSqlTerminalInstance(document.getElementById('sql-terminal-panel'));

// ---- SQL Data Viewer (task #68 Part 4) ----
// Not in PANEL_TYPES/main.html - there's nothing sensible to show empty, so
// unlike the other 6 types this one has no pre-existing singleton to clone;
// "Pop out data" (sqlTerminalRun's results area) builds one from scratch on
// demand instead, one new instance per click, all independently closable
// (wirePanelInstance) exactly like any other window.

// Splices "<table>.rowid AS __rowid__, " right after SELECT (and DISTINCT,
// if present) using the real tokenizer to find that exact insertion point -
// everything else in the original query text (WHERE/ORDER BY/LIMIT, the
// user's own column list) is left untouched, so the popped-out viewer stays
// scoped to the exact same rows the original query showed, refetched fresh.
function buildRowidFetchSql(sql, tableRef) {
    const tokens = tokenizeSQL(sql);
    const selectIdx = tokens.findIndex((t) => t.type === 'keyword' && t.text.toUpperCase() === 'SELECT');
    if (selectIdx < 0) return sql;
    let insertAt = tokens[selectIdx].end;
    const next = tokenNear(tokens, selectIdx, 1);
    if (next && next.type === 'keyword' && next.text.toUpperCase() === 'DISTINCT') insertAt = next.end;
    return sql.slice(0, insertAt) + ` ${tableRef}.rowid AS __rowid__,` + sql.slice(insertAt);
}

function createSqlDataViewerPanel() {
    const panel = document.createElement('div');
    panel.className = 'ui-panel';
    panel.setAttribute('data-panel-type', 'sql-data-viewer-panel');

    const header = document.createElement('div');
    header.className = 'panel-header';
    const title = document.createElement('span');
    title.textContent = '[SQL Data Viewer]';
    const controls = document.createElement('span');
    controls.className = 'panel-header-controls';
    controls.innerHTML = '<span class="toggle-icon">-</span><span class="panel-maximize-btn" title="Maximize window"></span><span class="panel-close-btn" title="Close window">&times;</span>';
    header.appendChild(title);
    header.appendChild(controls);
    panel.appendChild(header);
    panel.appendChild(document.createElement('div')).className = 'panel-content';

    document.body.appendChild(panel);
    wirePanelInstance(panel);

    const alreadyVisible = document.querySelectorAll('[data-panel-type="sql-data-viewer-panel"]').length - 1;
    const offset = alreadyVisible * 30;
    panel.style.top = (20 + offset) + 'px';
    panel.style.right = (20 + offset) + 'px';
    panel.style.left = 'auto';
    panel.style.bottom = 'auto';
    panel.style.zIndex = String(++panelZIndexCounter);
    panel.style.display = 'flex';
    return panel;
}

// Entry point for the SQL Terminal's "Pop out data" button - hands the LAST
// completed query off to a brand new Data Viewer window, for a bigger/
// separate/draggable view of the exact same editable table the terminal's
// own results area already shows (not a different, lesser copy of it - see
// renderSqlDataViewer). Re-runs the query (see the module comment on
// runSqlIntoResultsTable for why this doesn't just reuse buffered rows)
// rather than the live table's own DOM, so the viewer starts from a
// guaranteed-fresh read.
function sqlPopOutDataViewer(btn) {
    const sourcePanel = btn.closest('[data-panel-type="sql-terminal-panel"]');
    const last = sourcePanel.sqlState.lastResults;
    const statusEl = sourcePanel.querySelector('.sql-terminal-status');
    if (!last) { statusEl.innerText = 'Run a query first.'; return; }
    if (!playbackWorker) return;

    const viewerPanel = createSqlDataViewerPanel();
    const content = viewerPanel.querySelector('.panel-content');
    const loading = document.createElement('div');
    loading.className = 'sql-data-viewer-note';
    loading.textContent = 'Loading...';
    ensurePanelZoomWrap(content).appendChild(loading);

    fetchAndRenderDataViewer(viewerPanel, last);
}

// Fetches `last.sql` fresh (rowid-augmented when write-back eligible, same
// as runSqlIntoResultsTable) and renders it into an already-created Data
// Viewer panel - the one function both the initial pop-out AND the
// post-save refresh (saveSqlDataViewerChanges) go through, so there's only
// one fetch-and-render path to keep correct instead of two that could drift
// apart. `last` only needs {sql, writeBackTable} - the same shape
// panel.sqlState.lastResults already has.
function fetchAndRenderDataViewer(viewerPanel, last) {
    const eligible = !!last.writeBackTable;
    const fetchSql = eligible ? buildRowidFetchSql(last.sql, last.writeBackTable) : last.sql;
    let columns = [];
    const rows = [];
    return new Promise((resolve) => {
        postSqlRequest({
            kind: 'schema', sql: fetchSql,
            onColumns: (c) => { columns = c; },
            onRows: (r) => { rows.push(...r); },
            onDone: () => { renderSqlDataViewer(viewerPanel, last, columns, rows, eligible); resolve(); },
            onError: (message) => {
                const content = viewerPanel.querySelector('.panel-content');
                content.innerHTML = '';
                const err = document.createElement('div');
                err.className = 'sql-data-viewer-note';
                err.textContent = 'Error: ' + message;
                ensurePanelZoomWrap(content).appendChild(err);
                resolve();
            },
        });
    });
}

// Renders (or re-renders, after a save) one Data Viewer window's content
// from a freshly fetched column/row set, as a real .sql-terminal-results
// table (buildResultsTableHead/buildResultsRow) - the EXACT same markup/
// class/editing behavior the main SQL Terminal's own results use, not a
// separate style of its own. `last` only needs {sql, writeBackTable} - the
// same shape sqlState.lastResults already has.
function renderSqlDataViewer(viewerPanel, last, rawColumns, rawRows, eligible) {
    const content = viewerPanel.querySelector('.panel-content');
    content.innerHTML = ''; // also destroys the previous .panel-zoom-wrap - ensurePanelZoomWrap below rebuilds a fresh one
    const wrap = ensurePanelZoomWrap(content);

    // rawColumns[0]/rawRows[i][0] is the __rowid__ this fetch prepended
    // (buildRowidFetchSql) when eligible - real metadata for Save, not
    // something to show or let the user edit directly.
    const displayColumns = eligible ? rawColumns.slice(1) : rawColumns;

    const note = document.createElement('div');
    note.className = 'sql-data-viewer-note';
    note.textContent = eligible
        ? `Editable - table: ${last.writeBackTable}. Click a cell to edit it, then Save changes. Use the × column to mark a row for deletion. New rows aren't supported here - use the terminal to INSERT.`
        : `Read-only snapshot - the source query isn't a plain single-table SELECT (joins/aggregates/grouped results have no single row to write an edit back to).`;
    wrap.appendChild(note);

    const resultsWrap = document.createElement('div');
    resultsWrap.className = 'sql-terminal-results'; // same class as the main terminal's own results - see this function's own comment
    const table = buildResultsTableHead(displayColumns, eligible);
    const tbody = table.querySelector('tbody');
    const frag = document.createDocumentFragment();
    for (const row of rawRows) {
        const rowid = eligible ? row[0] : undefined;
        const values = eligible ? row.slice(1) : row;
        frag.appendChild(buildResultsRow(values, eligible, rowid));
    }
    tbody.appendChild(frag);
    resultsWrap.appendChild(table);
    wrap.appendChild(resultsWrap);

    viewerPanel.dataViewerState = { sql: last.sql, table: last.writeBackTable, columns: displayColumns, eligible };

    const status = document.createElement('div');
    status.className = 'sql-data-viewer-status';
    // Mirrors the main terminal's own post-refresh status text (sqlTerminalOnDone) -
    // without this, a save's "Saved N change(s)..." message would just vanish into a
    // blank line the moment this rebuild runs, with nothing replacing it.
    status.innerText = `${rawRows.length} row(s), ${displayColumns.length} column(s).`;

    if (eligible) {
        const btnRow = document.createElement('div');
        btnRow.className = 'button-row';
        const saveBtn = document.createElement('button');
        saveBtn.textContent = 'Save changes';
        saveBtn.onclick = () => saveSqlDataViewerChanges(viewerPanel);
        btnRow.appendChild(saveBtn);
        wrap.appendChild(btnRow);
    }
    wrap.appendChild(status);
}

// Runs a list of SQL statements strictly one after another through the
// shared sqlRequestQueue - NOT joined into one semicolon-separated string:
// sql_terminal_run (sql_terminal.c) calls sqlite3_prepare_v2 with a NULL
// tail pointer, so it only ever prepares the FIRST statement in whatever
// text it's given and silently drops the rest. Sequencing them as separate
// requests is what actually executes every one of them.
async function runSqlStatementsInOrder(statements) {
    for (const stmt of statements) {
        await new Promise((resolve, reject) => {
            postSqlRequest({
                kind: 'schema', sql: stmt,
                onDone: () => resolve(),
                onError: (message) => reject(new Error(message)),
            });
        });
    }
}

// Collects whatever's dirty/marked-for-deletion in the viewer's own results
// table (collectResultsTableEdits - the exact same function the main
// terminal's Save changes uses) and applies it, then re-fetches through
// fetchAndRenderDataViewer so the table reflects the DB's real post-write
// state rather than just trusting the edits were applied verbatim.
async function saveSqlDataViewerChanges(viewerPanel) {
    const state = viewerPanel.dataViewerState;
    const statusEl = viewerPanel.querySelector('.sql-data-viewer-status');
    if (!playbackWorker) return;
    const table = viewerPanel.querySelector('.sql-terminal-results table');
    if (!table) return;

    const statements = collectResultsTableEdits(table, state.columns, state.table);
    if (statements.length === 0) { statusEl.innerText = 'No changes.'; return; }

    statusEl.innerText = `Saving ${statements.length} change(s)...`;
    try {
        await runSqlStatementsInOrder(statements);
        statusEl.innerText = `Saved ${statements.length} change(s). Refreshing...`;
        await fetchAndRenderDataViewer(viewerPanel, { sql: state.sql, writeBackTable: state.table });
    } catch (err) {
        statusEl.innerText = 'Save error: ' + err.message;
    }
}

// ---- Debug panel (DEBUG_MODE only) ----
// These diagnostic pulls (VFS traces, lock counters, heap info) aren't
// correlated to a specific request the way SQL Terminal queries are (see
// Part 3) - the worker-side RPCs themselves have no per-request id, and the
// result is informational, not correctness-critical. So the OUTPUT is
// broadcast to every currently open debug-panel window (same treatment as
// Chat/System Logs, via panelContentElements), while the "match idx"
// INPUT is read from whichever window's own button was actually clicked
// (`this.closest(...)`) - so clicking window #2's button queries window #2's
// typed value, even though the answer then shows up in every open window.

function debugPanelOutput(text) {
    for (const el of panelContentElements('debug-panel')) {
        const out = el.querySelector('.debug-output');
        if (out) out.textContent = text;
    }
}

function debugCheckIndexVisible(btn) {
    if (!playbackWorker) return;
    const panel = btn.closest('[data-panel-type="debug-panel"]');
    const matchIdx = parseInt(panel.querySelector('.debug-match-idx').value, 10) || 0;
    playbackWorker.postMessage({ type: 'debugIndexVisible', matchIdx });
}

function debugGetVfsTraces() {
    if (playbackWorker) playbackWorker.postMessage({ type: 'getVfsTraces' });
}

function debugResetVfsTraces() {
    if (playbackWorker) playbackWorker.postMessage({ type: 'resetVfsTraces' });
}

function debugGetLockCounters() {
    if (playbackWorker) playbackWorker.postMessage({ type: 'getLockCounters' });
}

function debugGetHeapInfo() {
    if (playbackWorker) playbackWorker.postMessage({ type: 'heapDebug' });
}

let readerBoundsRemaining = 0;

// Real progress, not decorative: each reader independently bisects its own
// slice of matches against agent_states (a multi-million-row table for a
// realistic file) and reports back exactly once, whether it succeeded or
// gave up (readers can never open a handle at all on browsers without
// concurrent OPFS support - see replay-worker.js's openSyncAccessHandleWithRetry
// - and still count as "done" for progress purposes either way, since
// playbackWorker's own combineBounds/self-heal paths cover the rest
// regardless). "how many of the N readers have reported in" is a genuine,
// monotonic completion signal for however long this phase actually takes -
// unlike leaving the byte-streaming progress bar frozen at 100% through the
// whole thing, which looks finished when it isn't.
function reportBoundsProgress() {
    const done = READER_COUNT - readerBoundsRemaining;
    const pct = READER_COUNT > 0 ? Math.round((done / READER_COUNT) * 100) : 100;
    const fill = document.getElementById('progress-fill');
    const text = document.getElementById('progress-text');
    if (fill) fill.style.width = pct + '%';
    if (text) text.innerText = `Computing map bounds (parallel)... ${pct}% (${done}/${READER_COUNT} readers done)`;
}

// Phase 6: navigator.deviceMemory clamp, on top of the existing
// hardwareConcurrency cap. This is NOT about wasm_layout.h's per-thread
// memory floor (Phase 6a already fixed that independently - unused reader
// thread-id slots cost nothing since they're never grown into) - it's
// about the real, fixed per-Worker overhead of spinning up a whole extra
// browser Worker (its own JS engine context, base heap, thread) regardless
// of how little wasm heap that Worker's thread ends up using. Coarse and
// capped at 8GB by spec (fingerprinting resistance), and Chromium-only -
// Firefox/Safari report `undefined`, which falls back to the
// hardwareConcurrency-only cap this project already had.
function computeReaderCount() {
    const override = new URLSearchParams(location.search).get('readerCount');
    if (override !== null) return parseInt(override, 10);
    const hwCap = Math.min(navigator.hardwareConcurrency || 4, 8);
    const mem = navigator.deviceMemory;
    if (mem === undefined) return hwCap;
    if (mem <= 1) return 1;
    if (mem <= 2) return 2;
    if (mem <= 4) return 4;
    return hwCap;
}
const READER_COUNT = computeReaderCount();

function startBoundsComputation() {
    if (matches.length === 0) {
        // Nothing to bound against - keep main.c's default bounds.
        wasmInstance.exports.set_map_bounds(-100, 100, -100, 100);
        finishLoadAndStartPlayback();
        return;
    }
    readerBoundsRemaining = READER_COUNT;
    // Staggered, not all READER_COUNT (up to 8) Worker.postMessage('init')
    // calls fired in the same synchronous tick - confirmed via direct
    // Selenium+Firefox testing (real file upload) that firing this many
    // concurrent createSyncAccessHandle({mode:"readwrite-unsafe"}) requests
    // on the same OPFS file at once isn't reliably handled by Firefox's OPFS
    // implementation (some readers failed outright with
    // NoModificationAllowedError; Chrome never showed this). replay-worker.js's
    // openSyncAccessHandleWithRetry already makes each individual attempt
    // resilient to that - this staggering is the complementary fix: reduce
    // how often the contention happens in the first place, not just survive
    // it after the fact. 25ms/reader adds well under 200ms total even at the
    // 8-reader cap, negligible against real load times.
    for (let i = 0; i < READER_COUNT; i++) {
        setTimeout(() => {
            const w = new Worker(WORKER_SCRIPT_URL);
            activeReaderWorkers.add(w);
            const done = () => { activeReaderWorkers.delete(w); gracefulTerminateWorker(w); };
            w.onmessage = (e) => {
                if (e.data.type === 'ready') {
                    w.postMessage({ type: 'computeBounds', readerIdx: i, readerCount: READER_COUNT });
                } else if (e.data.type === 'boundsReady') {
                    done();
                    readerBoundsRemaining--;
                    reportBoundsProgress();
                    if (readerBoundsRemaining === 0) {
                        playbackWorker.postMessage({ type: 'combineBounds', readerCount: READER_COUNT });
                    }
                } else if (e.data.type === 'error') {
                    appendToConsoleLog('[Reader Worker Error] ' + e.data.message);
                    done();
                    readerBoundsRemaining--;
                    reportBoundsProgress();
                    if (readerBoundsRemaining === 0) {
                        playbackWorker.postMessage({ type: 'combineBounds', readerCount: READER_COUNT });
                    }
                }
            };
            w.postMessage({ type: 'init', role: 'reader', memory: sharedMemory, module: replayModule, threadId: i + 1 });
        }, i * 25);
    }
}

function finishLoadAndStartPlayback() {
    loadingOverlay.style.display = 'none';
    document.getElementById('hamburger-container').style.display = 'block';
    resetBtn.style.display = 'block';
    document.getElementById('export-btn').style.display = 'block';
    currentSimulationState = "RUNNING";
    replayTime = totalStartTime;
    isPaused = false;
    createTimelineUI();
    appendToConsoleLog(`[Replay Engine] Parse Complete! Matches detected: ${matches.length}`);
    if (!pendingFrameRequest) {
        pendingFrameRequest = true;
        playbackWorker.postMessage({ type: 'frame', time: replayTime, seek: true });
    }
}

Promise.all([
    // {cache: 'no-store'}: without it the browser can silently keep serving
    // a stale cached main.wasm after a rebuild - the exact class of bug
    // already fixed for replay_worker.wasm/replay-worker.js (see
    // WORKER_SCRIPT_URL's cache-bust comment above), just not caught here
    // until a newly added export once failed with "is not a function"
    // against an old cached binary that didn't have it yet.
    fetch('main.wasm', { cache: 'no-store' }).then(res => {
        if (!res.ok) throw new Error("main.wasm not found.");
        return res.arrayBuffer();
    }),
    fetch('shaders/main_vs.glsl').then(res => res.text()),
    fetch('shaders/main_fs.glsl').then(res => res.text()),
    fetch('shaders/grid_vs.glsl').then(res => res.text()),
    fetch('shaders/grid_fs.glsl').then(res => res.text()),
]).then(([wasmBuffer, mainVs, mainFs, gridVs, gridFs]) => {
    return WebAssembly.instantiate(wasmBuffer, importObject).then(result => {
        wasmInstance = result.instance;
        const exports = wasmInstance.exports;

        writeStringToWasm(mainVs, exports.get_vs_main_ptr());
        writeStringToWasm(mainFs, exports.get_fs_main_ptr());
        writeStringToWasm(gridVs, exports.get_vs_grid_ptr());
        writeStringToWasm(gridFs, exports.get_fs_grid_ptr());

        exports.init_engine();
        exports.init_gl_programs();
        handleResize();

        document.getElementById('file-input').addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            startReplayLoad(file);
        });

        document.getElementById('battle-file-input').addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            startBattleFileLoad(file);
        });

        document.getElementById('render-queries-import-input').addEventListener('change', (e) => {
            const file = e.target.files[0];
            e.target.value = ''; // allow re-importing the exact same filename twice in a row
            if (!file) return;
            importRenderQueriesSqlFile(file);
        });

        // Both the WASD/space camera shortcuts below and the wheel-zoom
        // handler further down used to fire unconditionally on `window`,
        // `preventDefault()`-ing every keystroke/scroll regardless of what
        // was focused or under the cursor - so typing into the SQL
        // terminal's textarea (or any future text field) silently did
        // nothing (preventDefault on keydown blocks the field's own
        // character-insertion default action), and scrolling the mouse
        // wheel over a panel's own scrollable content zoomed the map
        // instead of scrolling the panel. These two checks opt out of the
        // camera controls whenever the target is actually a form field or
        // inside one of the floating UI panels, letting normal browser/DOM
        // behavior handle it instead.
        function isTypingIntoFormField(e) {
            const el = e.target;
            const tag = el && el.tagName;
            return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el && el.isContentEditable);
        }

        window.addEventListener('keydown', (e) => {
            if (isTypingIntoFormField(e)) return;
            // Any of these genuinely PANS the camera (cam_x/cam_y itself,
            // not just the render-only view shift - see set_view_shift's
            // comment) - stop auto-following the active battle so this
            // manual move isn't fought on the next battle switch. Only WASD
            // and the canvas drag below count as "moved the camera"; zoom
            // alone (mouse wheel) is left following, since it doesn't
            // change where the view is centered.
            if (e.key === 'w' || e.key === 'W') { exports.set_key_state(0, 1); cameraFollowActiveBattle = false; }
            if (e.key === 'a' || e.key === 'A') { exports.set_key_state(1, 1); cameraFollowActiveBattle = false; }
            if (e.key === 's' || e.key === 'S') { exports.set_key_state(2, 1); cameraFollowActiveBattle = false; }
            if (e.key === 'd' || e.key === 'D') { exports.set_key_state(3, 1); cameraFollowActiveBattle = false; }
            if (e.key === ' ') {
                isPaused = !isPaused;
                const playBtn = document.getElementById('tl-play-btn');
                if (playBtn) {
                    playBtn.innerText = isPaused ? 'Play' : 'Pause';
                    playBtn.style.color = isPaused ? '#ffaa00' : '#00ff00';
                    playBtn.style.borderColor = isPaused ? '#ffaa00' : '#00ff00';
                }
            }
            e.preventDefault();
        });

        window.addEventListener('keyup', (e) => {
            if (isTypingIntoFormField(e)) return;
            if (e.key === 'w' || e.key === 'W') exports.set_key_state(0, 0);
            if (e.key === 'a' || e.key === 'A') exports.set_key_state(1, 0);
            if (e.key === 's' || e.key === 'S') exports.set_key_state(2, 0);
            if (e.key === 'd' || e.key === 'D') exports.set_key_state(3, 0);
        });

        // Single wheel handler for the whole page, not one per panel's own
        // content - see applyTextZoomDelta/ensurePanelZoomWrap's own comment
        // for why a per-content listener has a real gap (resize-handle divs
        // sit outside .panel-content's subtree). Scoping to '.ui-panel'
        // (which wraps both the content AND the resize handles) means ANY
        // wheel event whose target is anywhere inside a panel - not just its
        // content area - gets a chance to preventDefault before Firefox/
        // Chrome apply their own native Ctrl+Scroll page-zoom.
        window.addEventListener('wheel', (e) => {
            const panel = e.target && e.target.closest && e.target.closest('.ui-panel');
            if (panel) {
                if (!e.ctrlKey) return; // let the panel scroll its own content instead of zooming anything
                e.preventDefault(); // otherwise Ctrl+Scroll would ALSO zoom the whole browser page
                const content = panel.querySelector(':scope > .panel-content');
                const wrap = content && ensurePanelZoomWrap(content);
                if (wrap) applyTextZoomDelta(wrap, e.deltaY);
                return;
            }
            e.preventDefault();
            exports.apply_zoom(e.deltaY);
        }, { passive: false });

        let isDragging = false;
        let lastMouseX = 0;
        let lastMouseY = 0;

        canvas.addEventListener('mousedown', (e) => {
            isDragging = true;
            lastMouseX = e.clientX;
            lastMouseY = e.clientY;
        });

        window.addEventListener('mousemove', (e) => {
            if (isDragging) {
                const dx = e.clientX - lastMouseX;
                const dy = e.clientY - lastMouseY;
                lastMouseX = e.clientX;
                lastMouseY = e.clientY;
                if (exports.pan_camera) exports.pan_camera(dx, dy);
                cameraFollowActiveBattle = false; // a real camera pan - see the keydown handler's comment on why this stops auto-following
            }
        });

        window.addEventListener('mouseup', () => {
            isDragging = false;
        });

        let lastFrameTime = 0;

        function loop(time) {
            const dt = (time - lastFrameTime) * 0.001;
            lastFrameTime = time;

            if (currentSimulationState === "RUNNING" && playbackWorker) {
                if (!isPaused) {
                    replayTime += dt * playbackSpeed;
                    if (replayTime >= totalEndTime) {
                        replayTime = totalEndTime;
                        isPaused = true;
                        const playBtn = document.getElementById('tl-play-btn');
                        if (playBtn) playBtn.innerText = 'Play';
                    }
                    const slider = document.getElementById('tl-slider');
                    if (slider) slider.value = replayTime.toString();
                }

                // Decoupled from the render rate: the DB query round-trip
                // happens async in the Worker, so a slow query never blocks
                // a frame - the render loop just draws the most recently
                // received snapshot every tick.
                if (!pendingFrameRequest) {
                    pendingFrameRequest = true;
                    playbackWorker.postMessage({ type: 'frame', time: replayTime, seek: false });
                }

                if (latestFrame) {
                    // One [x,y,r,g,b]-per-point buffer per rendering-query
                    // slot (replay_worker.c's g_render_slots) - copied into
                    // main.wasm's OWN per-slot buffers (a separate wasm
                    // module/memory, see ensure_render_slot_capacity's own
                    // comment). No cap on point count - a long battle's
                    // corpse count is unbounded, main.wasm grows to fit.
                    for (let s = 0; s < latestFrame.renderSlots.length; s++) {
                        const slot = latestFrame.renderSlots[s];
                        const n = slot.count;
                        const slotBufferPtr = exports.ensure_render_slot_capacity(s, n);
                        const floatView = new Float32Array(wasmInstance.exports.memory.buffer, slotBufferPtr, n * 5);
                        floatView.set(slot.buffer.subarray(0, n * 5));
                        exports.update_render_slot_data(s, n, slot.shape);
                    }
                }
                exports.render_frame(dt);
            }
            requestAnimationFrame(loop);
        }
        requestAnimationFrame(loop);
    }).catch(err => {
        console.error("Wasm initialization error:", err);
        appendToConsoleLog("[WASM ERROR] " + err.message);
    });
}).catch(err => {
    console.error("Initialization failure:", err);
});
