# FEATURES.md — acceptance checklist for the overhaul

Every row is a user-visible behaviour of the **old** implementation (commit `b83c380`). The overhaul may
not drop or silently change any of them. Each row ends up with a **Proof/Test** reference (a gnatprove
unit, a differential test against the old engine, or a browser test) — empty means "not yet covered".
Source locations are in the old tree and are the oracle for behaviour.

Legend: `[ ]` not yet verified in the new implementation, `[x]` verified (link the proof/test).
Rows marked **(debug)** are only visible with `?debug=1` / `localStorage wb_debug`.

## Loading and startup
- [ ] Upload overlay, "Load Replay Database" (`.sqlite`) — `main.html:333-345`, `main.js:5205`, `startReplayLoad main.js:2692`
- [ ] "Load Battle Export (.tar.xz)" — `main.html:340`, `main.js:5211`, `startBattleFileLoad :2730`, `parseTar :12`
- [ ] Loading overlay with progress bar and status text — `main.html:351-358`, `main.js:5078`, `:5110`
- [ ] Parallel map-bounds readers, `?readerCount=` override, `deviceMemory` clamp — `main.js:5097-5101`
- [ ] `index.html` redirects to `main.html`
- [ ] Cross-origin isolation shim for static hosting — `coi-shim.js`; dev server COOP/COEP — `serve.py:17-38`
- [ ] URL/localStorage flags: `?debug=1`, `wb_debug` (`main.js:52`), `?primingBudgetMiB=N` (`:2339`)

## Playback and timeline
- [ ] Timeline bar with per-match coloured blocks, click to jump ("Jump to Match #n") — `main.js:2073-2245`
- [ ] Play/Pause button; Space toggles; auto-pause at end — `main.js:5255-5262`, `:5331-5336`
- [ ] Playback speed 0.5, 1, 1.5, 2, 4, 8 — `main.js:2146-2161`
- [ ] Per-match prefetch/prime indicators (dim / faint / bright), fade on eviction — `main.js:2649-2681`
- [ ] Scrub slider, seek, slider follows playback — `main.js:2375`, `:2385`
- [ ] Match info "MATCH #n | Scene | Factions", "Time: +x.xxs", "Out of match boundaries" — `main.js:2385-2412`
- [ ] Decoupled render loop, at most one frame request in flight — `main.js:5322-5356`

## Camera
- [ ] WASD pan (hold) — `main.c:293-296`, `main.js:5251-5254`
- [ ] Mouse-drag pan on canvas — `main.js:5301-5322`, `main.c:224`
- [ ] Mouse-wheel zoom (x0.9 / x1.1, clamp 0.02-40) — `main.js:5283-5297`, `main.c:217`
- [ ] Ctrl+Scroll over a panel zooms that panel's text only; plain scroll scrolls it — `main.js:5284-5291`, `:1855`
- [ ] Camera keys ignored while typing in a form field — `main.js:5236`
- [ ] Auto-fit to map bounds on load — `main.c:128`, `main.js:2862`
- [ ] Auto-follow: view-shift centres the active battle without touching camera state; WASD/drag cancels — `main.c:210`, `main.js:990-999`, `:3663`
- [ ] "Re-center on battle" menu item resumes follow — `main.html:286`
- [ ] Centre crosshair (also `CURSOR_X()/CURSOR_Y()`) — `main.html:22`, `main.css:12-35`, `replay_worker.c:1586`

## Rendering
- [ ] 3-adic multi-level grid background (27/9/3 cell lines) — `shaders/grid_fs.glsl:12-75`
- [ ] White map-bounds box — `main.c:339-344`
- [ ] Dots (triangle fan, radius 0.75) and rings (line loop, radius x1.6), drawn in slot order — `main.c:356-384`
- [ ] Default queries: corpses, living agents (team 0 red, team 1 blue, other grey, interpolated), chat — `sql/default_render_*.sql`
- [ ] NATO APP-6 symbol layer: frames (friend rectangle, hostile diamond, neutral square, unknown ellipse), arms (infantry, cavalry, artillery, rocket, engineer, medical, other), ranged amplifier, commander label, shortest-angle rotation blend, per-frame reprojection — `main.js:748-1000`
- [ ] Sample NATO query template — `sql/sample_render_nato_symbols.sql`

## Panels and window system
- [ ] Chat Replay panel: team-coloured names, auto-scroll when near bottom, "System: No chat messages yet." placeholder, follow-to-bottom — `main.js:2431`, `:2477`
- [ ] Draggable, resizable, minimise (header click), maximise, close, z-order focus on click — `main.js:1566`, `:1690`, `:1542`, `:1546`, `:1798`
- [ ] Multi-instance panels via "+" (Chat, Logs, VFS Trace, SQL Terminal, Schema Explorer, Docs) — `main.js:1896`, `:1878`
- [ ] Hamburger menu: Load Different Replay/Battle, Export Battle, Re-center, Panels section — `main.html:275-331`, `main.js:1234`
- [ ] Panel visibility checkboxes **(debug)** — `main.js:1290`

## Export and import
- [ ] Export active battle as `battle_N_faction.tar.xz` (manifest.json, replay.db, battle.db, sha256) — `main.js:2260-2375`, `replay_export.c:1265-1404`
- [ ] Load a previously exported battle — `main.js:2721-2790`
- [ ] Export / Import SQL Set (`rendering-queries.json`, incl. generator-script overrides) — `main.js:676-760`
- [ ] Dictionary size chosen by device memory — `main.js:2303`

## SQL tooling **(debug)**
- [ ] SQL Terminal: database selector, Run, Ctrl/Cmd+Enter, syntax highlight, line numbers — `main.html:94-150`, `main.js:3255`, `:4492`, `:4469`
- [ ] Shared floating autocomplete (Up/Down/Tab/Enter/Esc), works in generator-script editors — `main.js:4751-4775`
- [ ] Editable result cells, row deletion, "Save changes" write-back — `main.js:3272-3340`, `:3466`, `:5004`
- [ ] Error line/column — `main.js:3370`
- [ ] Checkpoints: Save checkpoint / Revert to — `main.js:3535-3560`, `sql_terminal.c:128`, `:188`
- [ ] Pop-out data viewer — `main.js:4836`, `:4875`
- [ ] Schema Explorer: database filter, refresh, table/column tree — `main.html:151`, `main.js:3784-4276`
- [ ] Generator-script editors with Run / Reset, pop-out window live-synced with the embedded widget
- [ ] Rendering Queries panel: Add Query, Reset to Defaults, drag-reorder, per-card name/enabled/kind (dots, chat, nato_symbol)/cache (tick, live, none)/interpolate/shape (dot, ring), pop-out editor, `-- @KIND/@CACHE/@INTERPOLATE/@SHAPE` directives — `main.js:126-148`, `:321-465`, `:502-640`
- [ ] SQL Docs panel — `main.html:222`
- [ ] SQL variables (public query API): `CURRENT_TICK`, `CURRENT_TICK_B`, `CURRENT_TIME`, `CURRENT_BATTLE`, `CURRENT_BATTLE_TICK_START/END`, `CURRENT_BATTLE_ROWID_LO/HI`, `CURSOR_X/Y` — `replay_worker.c:1527-1620`
- [ ] System Logs panel — `main.html:57`, `main.js:1986`
- [ ] VFS Trace panel: index visible, get VFS traces, reset traces, lock counters, heap info — `main.html:70`, `main.js:5035-5075`

## Engine behaviours with user-visible effect
- [ ] SQL-defined battle boundary detection (merge window 15 ticks, min span 10, tail >= 5, skip first 5 ticks) — `sql/default_boundary_detection.sql`, `replay_worker.c:1419-1487`
- [ ] Per-battle index priming and prefetch ahead of the cursor with memory budget; never evicts the live battle; Firefox no-concurrent-OPFS path — `replay_worker.c:396-677`, `main.js:2338`, `:2516-2640`
- [ ] Battle summary prewarm — `replay_export.c:649`, `main.js:2620`
- [ ] Checkpoint revert rebuilds derived data — `sql_terminal.c:188`, `replay_worker.c:1489`
- [ ] Error recovery: errors during playback clear in-flight gates instead of wedging — `main.js:2955-2985`

## Dev and test tooling
- [ ] `benchmark.html` / `benchmark.c` — microbenchmarks
- [ ] `testdata/*.html` test pages, `ground_truth.py` oracle, `make test` — `Makefile:195-214`
- [ ] Recording script `lua/main.lua` — **frozen, in production**
- [ ] Playwright / Selenium UI suites — `testdata/run_playwright_*.py`, `testdata/ui_behavior_tests.js`

## Behaviours to confirm with the owner (look like bugs, may be intended)
- `ticks.time` is whole seconds, so sub-second ticks collapse to the last tick at or before `t`.
- The default living-agents query only shows `is_human = 1`.
- SQL / Logs / VFS panels are debug-only.
- Corpses accumulate for the whole battle with no cap.
- The Docs panel claims edits appear "on the very next frame"; the default `@CACHE tick` query contradicts this.
