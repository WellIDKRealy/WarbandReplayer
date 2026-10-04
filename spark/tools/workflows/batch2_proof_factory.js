// Proof-factory workflow script for Claude Code's Workflow tool (run with ultracode). Pass args: {repo, data} (batch2 also group: '2a'|'2b').
// If Workflow/subagents are unavailable or too costly, follow the same loop by hand: author -> prove.sh -> mutation/differential/audit/robustness checks -> repair -> commit.
export const meta = {
  name: 'spark-proof-factory-batch2',
  description: 'Author, prove, adversarially verify and commit SPARK units for validators, sha256, write-back builder, camera, and state machines (group via args.group: 2a or 2b)',
  whenToUse: 'Proof-first port/new design of pure-logic units of WarbandReplayer in Ada/SPARK',
  phases: [
    { title: 'Author', detail: 'write SPARK spec+body, prove to 0 unproved, native differential tests' },
    { title: 'Verify', detail: 'mutation, independent differential, fidelity audit, robustness+simplicity+speed' },
    { title: 'Repair', detail: 'fix verifier findings, re-verify (max 2 rounds)' },
    { title: 'Commit', detail: 'serial commit per verified unit (retry on index.lock), then push' },
  ],
}

const REPO = (args && args.repo) || '/path/to/WarbandReplayer'  // pass args.repo
const DATA = (args && args.data) || '/path/to/data'  // pass args.data (extracted real replays live in DATA/replays; never commit them)
const GROUP = (args && args.group) || '2a'

const PREAMBLE = `
You are one worker in a proof-first redesign/port of the WarbandReplayer project (a Mount & Blade Warband replay viewer, bare-metal
WebAssembly) to Ada/SPARK. READ FIRST: ${REPO}/docs/CHARTER.md, ${REPO}/docs/PLAN.md, ${REPO}/docs/failure-modes.md, ${REPO}/docs/FEATURES.md.
The OLD implementation (C in ${REPO}/*.c, JS in ${REPO}/*.js, SQL in ${REPO}/sql/) is the behavioural ORACLE where a unit ports old behaviour: do
NOT modify any existing file. Work only inside your unit directory (given below). Do NOT run any git command that writes (no add/commit/push/
checkout/reset) - the orchestrator commits. Other workers are building other units concurrently in other directories: never touch them.
Owner's rules, all binding:
 * PROOFS BEFORE TESTS. SPARK_Mode On; \`${REPO}/spark/tools/prove.sh <unit-dir>\` must exit 0 (gnatprove 14.1, level 4: 0 unproved). Prove
   absence of run-time errors AND functional postconditions that PIN the intended behaviour (Gold level) - not trivially-true contracts. Never
   weaken a contract to pass a proof; never hide behaviour in Ghost code; never use pragma Assume, SPARK_Mode (Off), or pragma Annotate
   (GNATprove, ...) unless truly unavoidable - then list each in register_items with the exact reason it cannot be proven (the owner alone decides
   whether it may be tested instead). A clean honest status "partial" beats a fake "proved".
 * SIMPLICITY (charter): the unit README.md OPENS with a "Guarantees" section - at most ~10 lines of plain English a newcomer understands in a
   minute. The public spec stays short and readable; proof scaffolding (lemmas, ghost helpers) goes in child packages named <Unit>.Proofs and is
   never part of the interface. No generics, abstractions or options that no feature or failure-mode row needs. Smaller is better.
 * ROBUSTNESS (failure-modes.md): every parser/validator/decision function is TOTAL - proven to terminate with an explicit typed result on ANY
   input, including empty, truncated, hostile and maximal-size inputs; never an exception, never undefined behaviour, never silent truncation.
 * SPEED (charter): hot paths must be fast. Prove first, then measure a native micro-benchmark and record throughput/latency in PROOF.md. Do NOT
   add Suppress pragmas in sources: proven units are compiled with run-time checks suppressed by the BUILD configuration later.
 * Target constraints (GNAT-LLVM wasm32 later): no nested subprograms, no tasking/protected types, no non-local exception propagation, no
   Ada.Text_IO/containers/standard-library units inside the proof package, no elaboration-time state, no 32-bit byte counts (use 64-bit types
   where sizes can be large). Threads are JS Workers + shared memory, never Ada tasks.
 * Tooling: \`. ${REPO}/spark/tools/env.sh\` puts gnatprove/gnat/gprbuild on PATH. Copy ${REPO}/spark/templates/unit.gpr as <unit>.gpr and rename
   the project. Layout: <unit-dir>/src, <unit-dir>/tests (native Ada differential test program + own tests.gpr + run_tests.sh finishing in
   under 10 s; build output must go to obj*/ or bin*/ directories - they are git-ignored), <unit-dir>/README.md, <unit-dir>/PROOF.md (final
   gnatprove summary, benchmark numbers, register items).
 * The machine has 4 CPUs shared with other workers and a background build: use gnatprove -j1 (prove.sh does), never run provers in parallel.
 * Real replay data (NEVER copy it into the repo - other players' names/chat): ${DATA}/replays/*.sqlite (31 non-empty files + 8 empty-shell files, same
   9-table schema ${REPO}/lua/main.lua writes - FROZEN, read-only). Derived integer-only oracle cases may be committed. Python3 (sqlite3 module) and
   node 22 are available.
 * List every deliberate difference from old behaviour in old_behaviour_divergences ("intentional-fix" = matches the owner's overhaul spec: no silent
   caps, 64-bit sizes, explicit errors instead of truncation/UB; "faithful" otherwise). For brand-new units with no old counterpart return [].
Return your result as the final structured output only.`

const AUTHOR_SCHEMA = {
  type: 'object',
  properties: {
    unit: { type: 'string' },
    status: { type: 'string', enum: ['proved', 'partial'] },
    files: { type: 'array', items: { type: 'string' } },
    checks_total: { type: 'integer' },
    unproved: { type: 'integer' },
    assume_lines: { type: 'integer' },
    tests_pass: { type: 'boolean' },
    register_items: { type: 'array', items: { type: 'object', properties: { item: { type: 'string' }, why_unprovable: { type: 'string' }, proposed_mitigation: { type: 'string' } }, required: ['item', 'why_unprovable'] } },
    old_behaviour_divergences: { type: 'array', items: { type: 'object', properties: { what: { type: 'string' }, classification: { type: 'string', enum: ['intentional-fix', 'faithful'] }, old_ref: { type: 'string' } }, required: ['what', 'classification'] } },
    benchmark: { type: 'string' },
    summary: { type: 'string' },
  },
  required: ['unit', 'status', 'files', 'unproved', 'tests_pass', 'summary'],
}

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    lens: { type: 'string' },
    pass: { type: 'boolean' },
    findings: { type: 'array', items: { type: 'object', properties: { severity: { type: 'string', enum: ['blocker', 'major', 'minor'] }, description: { type: 'string' }, fix_hint: { type: 'string' } }, required: ['severity', 'description'] } },
    evidence: { type: 'string' },
  },
  required: ['lens', 'pass', 'findings'],
}

const COMMIT_SCHEMA = {
  type: 'object',
  properties: { unit: { type: 'string' }, committed: { type: 'boolean' }, commit: { type: 'string' }, note: { type: 'string' } },
  required: ['unit', 'committed'],
}

const UNITS_2A = [
  {
    key: 'sqlite_header',
    dir: 'spark/core/sqlite_header',
    spec: `
UNIT: sqlite_header - validate the 100-byte SQLite database header against the file size, BEFORE SQLite is asked anything (failure-modes.md section A: bad magic, truncated file, header damage, page-count mismatch).
SPEC SOURCE: the SQLite file format (https://www.sqlite.org/fileformat.html - you know it; offsets: 0-15 magic "SQLite format 3\\0"; 16-17 page size (1 means 65536; otherwise a power of two 512..32768); 18 write version, 19 read version (1 legacy, 2 WAL); 20 reserved bytes per page; 21/22/23 payload fractions must be 64/32/32; 24-27 change counter; 28-31 in-header page count (valid only if >0 AND version-valid-for (92-95) == change counter; otherwise the page count is derived from file size); 44-47 schema format 1..4; 56-59 text encoding 1..3; 96-99 SQLite version). The recorder (${REPO}/lua/main.lua) writes page_size=4096.
INPUT: up to the first 100 bytes of the file (a byte array + its length 0..100 - the caller may pass fewer bytes) and the total file size (64-bit). OUTPUT: a result that is either Ok (page size, page count, text encoding, wal flag) or ONE typed Error (Too_Short, Bad_Magic, Bad_Page_Size, Bad_Version, Bad_Payload_Fractions, Bad_Schema_Format, Bad_Text_Encoding, Truncated (pages claimed > pages present), Size_Not_Page_Multiple, Zero_Pages) - define precedence explicitly and document it in the README.
PROVE: totality (any byte array / any length 0..100 / any 64-bit file size gives a result, no run-time error, including file size 0 and 2**63-1); Ok implies every documented field constraint holds and the page count is exactly the rule above; each Error kind is returned exactly when its condition holds and no earlier-precedence condition does (functional contracts), 64-bit arithmetic never overflows.
ORACLE/DIFFERENTIAL: (1) all 39 real files in ${DATA}/replays (31 valid; 8 are structurally valid empty shells - must be Ok); (2) a Python reference you write from the format spec; (3) SQLite itself: for >= 20000 random header mutations (flip bytes in offsets 0..99, truncate the file, change size) feed the mutated file to Python's sqlite3 (open + \`select count(*) from sqlite_master\`): whenever the validator returns an Error of a kind that SQLite must reject (bad magic, bad page size, etc.) SQLite must fail too, and whenever the validator says Ok SQLite must not fail because of the header. Document any case where SQLite is more lenient than the format spec and decide (and justify) which behaviour the validator follows.`,
  },
  {
    key: 'recorder_schema',
    dir: 'spark/core/recorder_schema',
    spec: `
UNIT: recorder_schema - decide whether an opened database has the schema the frozen recorder ${REPO}/lua/main.lua writes (read its CREATE TABLE statements: ticks, events, chats, map_switches, score_switches, faction_switches, kills, spawns, agent_states and their columns), so wrong/older/damaged schemas become an explicit typed error instead of a crash later (failure-modes.md A: "valid SQLite, wrong schema").
INPUT: a bounded description of the schema as returned by PRAGMA table_info for each table: up to 256 tables, each with a name (<= 64 bytes) and up to 64 columns (name <= 64 bytes, declared type text <= 64 bytes). Empty tables list, over-long names and over-large counts must be handled with explicit status (not exceptions).
OUTPUT: Ok, or a bounded list/bitset of problems: Missing_Table(table), Missing_Column(table,column), Wrong_Affinity(table,column). Extra tables/columns are allowed. Identifier comparison is ASCII case-insensitive (SQLite rules). Declared types are classified by the SQLite type-affinity rules (https://www.sqlite.org/datatype3.html section 3.1: contains "INT" -> INTEGER; "CHAR"/"CLOB"/"TEXT" -> TEXT; "BLOB" or empty -> BLOB; "REAL"/"FLOA"/"DOUB" -> REAL; else NUMERIC) and compared with the affinity the recorder declares.
PROVE: totality; the affinity function matches the documented rules for ALL inputs (state them as postconditions); Ok exactly when every required table/column exists with the required affinity; every reported problem is real and every real problem is reported (up to the documented list bound, with an explicit Overflow flag instead of silent truncation).
ORACLE/DIFFERENTIAL: PRAGMA table_info on all real files in ${DATA}/replays (all must be Ok); >= 5000 synthetic schema mutations (drop/rename/retype tables and columns, case changes, extra columns, empty/huge names) checked against a Python reference; use SQLite's own affinity resolution (create a table with the declared type and read back typeof of an inserted value) to cross-check the affinity function on >= 2000 random type strings.`,
  },
  {
    key: 'data_sanity',
    dir: 'spark/core/data_sanity',
    spec: `
UNIT: data_sanity - streaming plausibility validator for recorder data (failure-modes.md A: non-monotone ticks, duplicate/orphan ids, NaN/Inf/huge positions, agent ids out of range, invalid teams; plus register item R7: payload bit-flips are undetectable by construction, so plausibility checks + a visible report are the mitigation).
DESIGN: a small state machine fed one row at a time (Feed_Tick(id,time), Feed_Agent_State(tick_id, agent_id, x, y, z), Feed_Spawn(agent_id, team), Feed_Kill(dead_id, killer_id)), keeping O(1) state (counters + first-violation row number per kind), never a copy of the data. Violation kinds (define precisely in the README): Tick_Id_Not_Increasing, Tick_Time_Goes_Backwards (equal times are NORMAL - whole-second resolution; large gaps are NOT violations), Negative_Id, Agent_Id_Out_Of_Range (valid 0..1024 as in the old MAX_AGENT_SLOTS=1025), Position_Not_Finite (NaN/Inf), Position_Out_Of_Range (|coordinate| above a documented bound, choose from the real data's observed range with margin and justify), Team_Invalid (team not 0 or 1), Agent_State_Orphan_Tick (tick_id not seen yet / not the current or a previous tick). Summary function: Clean, Degraded (counts) or Unusable (documented thresholds).
INPUT TYPES: positions arrive as 64-bit floats from SQLite (Long_Float) - classification must be exact for NaN, +-Inf, subnormals and maxima (SPARK float rules: use Long_Float'Valid / range subtypes carefully; state any limitation honestly in register_items).
PROVE: totality and no run-time errors for any sequence of any length (counters saturate explicitly - never wrap); each counter increments exactly when its condition holds; O(1) state (no growth); Clean iff all counters are zero.
ORACLE/DIFFERENTIAL: a Python reference over the real files (stream ticks, agent_states, spawns, kills with sqlite3): the native Ada program fed the same rows must report identical counters - real data should be Clean (document any real anomaly you find: e.g. is equal tick time frequent? are all agent_ids within 0..1024? observed coordinate range?); then inject poison (NaN, Inf, -Inf, 1e300, negative ids, reordered ticks, team 7) at random rows of derived copies (in /tmp, never in the repo) and require exact detection counts. Include a throughput benchmark (rows/s) - it must keep up with a multi-million-row scan.`,
  },
  {
    key: 'sha256',
    dir: 'spark/leaf/sha256',
    spec: `
UNIT: sha256 - incremental SHA-256 (FIPS 180-4) used for the background whole-file hash (workspace verification, wr_meta, manifest) of 1 GB+ files.
OLD SOURCE: ${REPO}/goyslopless-c/lib/sha256.c (110 lines) and its use in ${REPO}/replay_worker.c (replay_feed_chunk, finish_load) and replay_export.c (manifest sha256).
API: Init, Update(chunk: byte array of any length up to 2**32 per call, repeatable), Final -> 32-byte digest; one-shot convenience. Total message length up to 2**61 bytes (explicit typed error beyond that, never wraparound).
PROVE: absence of run-time errors for every call sequence; buffer-index invariant (< 64) and total-length accounting; padding is correct for every length mod 64 (state it); and functional correctness: express the FIPS 180-4 padding + compression as a clearly-written Ghost specification (the message schedule and 64 rounds on 32-bit words) and prove the implementation computes it - or, if that is beyond the provers, prove as much as possible (state exactly what is proven and what is not, status "partial", register_items) rather than faking it. Chunk-split invariance (any split of a message into Update calls gives the same digest) must be proven if the functional spec is proven.
SPEED: the hash of a 1 GB file runs in the background on a helper thread; measure native MB/s (native build) and make the inner loop simple and fast (no per-byte function calls, 32-bit modular arithmetic). Record numbers in PROOF.md.
ORACLE/DIFFERENTIAL: NIST/FIPS vectors; Python hashlib over >= 100000 random messages (lengths 0..2000 plus lengths around 55/56/63/64/119/120) and random chunkings; the real files in ${DATA}/replays (hash must equal hashlib's; time the 1.1 GB file).`,
  },
  {
    key: 'writeback_builder',
    dir: 'spark/core/writeback_builder',
    spec: `
UNIT: writeback_builder - the strict SQL statement builder behind the editable results table ("Save changes") (FEATURES: SQL tooling write-back; old behaviour in ${REPO}/main.js: queryWriteBackTable (~4358), buildRowidFetchSql (~4826), collectResultsTableEdits (~3333), runSqlStatementsInOrder (~4986) - the old code concatenates strings with unquoted names, sends everything as TEXT, turns NULL into the string 'NULL', has a weak eligibility check and no transaction: all of that is wrong).
NEW BEHAVIOUR (owner's spec): given a target table identifier, a list of changed cells (column identifier + typed value: Null | Integer(64-bit) | Real(finite 64-bit float) | Text(bytes) | Blob(bytes)) and a rowid (64-bit), build ONE UPDATE statement; given a rowid build ONE DELETE statement; both into a caller-supplied bounded output buffer (length 64-bit; explicit Buffer_Too_Small error, never truncation). Identifiers are always double-quoted with embedded " doubled; text values single-quoted with embedded ' doubled; blobs as X'..' hex; integers decimal; reals in a form that round-trips (document the format); Null as NULL (NOT the string 'NULL'). Reject: empty identifier, identifier longer than a documented bound, a text value containing NUL (SQLite C-string limits) - with typed errors. Also provide the strict ELIGIBILITY decision over a token-class list (single table, no JOIN/GROUP/UNION/INTERSECT/EXCEPT/aggregate/alias) as a pure function over an abstract sequence of token classes (the tokenizer is a separate unit; do not depend on it).
PROVE: totality; output always exactly one well-formed statement of the documented shape; every quote character from user data is doubled so user data can never terminate a literal or identifier (state this as a postcondition over the output: the unquoted-structure of the output is independent of the data); output length is exactly computable and never exceeds the buffer; NULL is distinct from every text value.
ORACLE/DIFFERENTIAL: execute the generated statements with Python's sqlite3 against scratch tables with HOSTILE identifiers and values (quotes, semicolons, comments, unicode, empty strings, huge strings, 'NULL', "; DROP TABLE x;--", embedded NUL excluded) and verify the intended single-row effect and that nothing else changed (compare full table dumps before/after), for >= 20000 random cases; verify one statement only (sqlite3 complete_statement + executescript must not run a second statement).`,
  },
]

const UNITS_2B = [
  {
    key: 'camera_projection',
    dir: 'spark/core/camera_projection',
    spec: `
UNIT: camera_projection - the camera/projection math of the renderer (FEATURES: Camera - WASD pan, mouse-drag pan, wheel zoom, auto-fit to map bounds, auto-follow view shift, crosshair).
OLD SOURCE (read fully): ${REPO}/main.c camera section (~128-241: set_screen_dimensions, set_map_bounds, apply_zoom, pan_camera, set_view_shift, key-state panning, aspect/x_bound, pan_speed = 35/zoom, clamps 0.05..10 on set_map_bounds when span>0 and 0.02..40 on apply_zoom) and ${REPO}/main.js worldToScreen (~780). The old code uses 32-bit float (wasm f32); keep Float (IEEE binary32) so results are comparable bit for bit.
NEW REQUIREMENTS: no division by zero or NaN for ANY input: screen width/height < 1 gets an explicit typed result (old defect: height 0 -> aspect inf -> NaN camera); non-finite inputs (NaN/Inf from JS) are rejected with an explicit status and leave the state unchanged.
PROVE: no run-time errors; camera state invariant (all fields finite; zoom within its documented clamp after every operation); set_map_bounds/apply_zoom/pan clamps exactly as the old code; the world<->screen mapping is the exact formula and a round trip is within a proven error bound for in-range values; the view shift never changes camera position/zoom (it is a render-time offset only). Float: prove finiteness and ranges with SPARK float support; state honestly what is not provable (bit-exactness of transcendental functions - none are needed here) in register_items.
ORACLE/DIFFERENTIAL: extract the old C camera functions verbatim into a native test harness (compile with clang -O1 -ffp-contract=off) and compare bit-exactly with the Ada program on >= 200000 random operation sequences (zoom, pan, bounds, screen sizes including degenerate ones - for degenerate/non-finite inputs the old C result is NaN/inf and the Ada result must be the documented typed rejection; list these as intentional-fix divergences).`,
  },
  {
    key: 'snapshot_swap',
    dir: 'spark/core/snapshot_swap',
    spec: `
UNIT: snapshot_swap - the frame-snapshot hand-off protocol between the playback thread (producer) and the draw side (consumer), as a SEQUENTIAL state machine (PLAN.md: "frame-snapshot swap protocol proven: never draw an unpublished snapshot, never overwrite one in use"; the concurrent interleavings are register item R4, model-checked later - here prove the protocol logic itself).
DESIGN: two (or N, a documented small constant) snapshot slots with states Free / Being_Written / Published(sequence number) / In_Use(sequence number). Operations: Producer_Begin (returns a slot that is neither In_Use nor the newest Published-unread... define precisely), Producer_Publish (marks the written slot Published with a strictly increasing sequence number), Producer_Abort, Consumer_Acquire (returns the NEWEST Published slot and marks it In_Use, or 'nothing new'), Consumer_Release. All operations return explicit status for illegal use (e.g. publish without begin) leaving the state unchanged.
PROVE: invariants preserved by every operation: a slot is never both Being_Written and In_Use; the consumer only ever acquires a fully Published slot (never one being written); the producer never gets the slot the consumer holds; sequence numbers published are strictly increasing and acquire returns the largest published one; the producer can always make progress when the consumer holds at most one slot (a free slot exists - prove it); counters cannot overflow (64-bit with explicit saturation or documented bound); totality of the transition function.
ORACLE/DIFFERENTIAL: exhaustive enumeration of ALL operation sequences up to length 10 over the slot count against a deliberately naive Python model (a different, obviously-correct formulation), comparing returned slots/status/state after every step.`,
  },
  {
    key: 'loader_lifecycle',
    dir: 'spark/core/loader_lifecycle',
    spec: `
UNIT: loader_lifecycle - the load/lifecycle job state machine and the per-battle status machine shown in the UI (PLAN.md: "UI is a single proven state machine Idle -> Loading(k/n) -> Ready -> Error, no illegal transitions, progress = real counters"; failure-modes.md G: cancel during load, double load, reset while loading, worker death -> explicit failed state, never a spinner forever). OLD behaviour to study: ${REPO}/main.js loading states (~2692-2860, 5078-5176, 2955-2985) including the half-baked states listed in the ingest report (progress bar reset, first frame blank).
DESIGN: Job state: Idle | Loading(phase, done, total) | Ready | Failed(error_kind) | Cancelled. Phases: Opening, Validating, Finding_Battles, Opening_Battle. error_kind is an enumeration covering the failure-modes.md categories (Not_A_Database, Truncated, Wrong_Schema, Data_Implausible, Storage_Quota, Worker_Died, Out_Of_Memory, Cancelled_By_User, Internal). Events: Start, Progress(done,total), Phase_Done, Complete, Fail(kind), Cancel, Reset, Watchdog_Timeout (worker silent too long -> Failed(Worker_Died)). Battle status machine per battle: Not_Opened | Extracting | Ready | Damaged(reason) with legal transitions (Not_Opened->Extracting->Ready|Damaged; Ready/Damaged->Extracting only via explicit Re-extract). The "frame may be drawn" predicate: true only in Ready with the battle Ready (never half-baked).
PROVE: transition function total (every state x event gives an explicit new state or an explicit Ignored/Illegal status with the state unchanged); progress is monotone non-decreasing within a phase and done <= total always; Ready is reachable only through Complete from Loading with done = total; no event other than Reset/Start leaves Failed/Cancelled; Watchdog always leads to Failed within one step from Loading; the draw predicate implies Ready.
ORACLE/DIFFERENTIAL: exhaustive event sequences up to length 8 against a naive Python model; plus a table-driven transition-table test generated from the spec.`,
  },
  {
    key: 'workspace_publish',
    dir: 'spark/core/workspace_publish',
    spec: `
UNIT: workspace_publish - atomic publish protocol and crash-recovery decision for workspace files (R_k, B_k, battles index) (failure-modes.md D: tab closed mid-extraction, half-written files never opened, stale B_k, corrupted workspace file -> rebuild from source with a visible reason).
DESIGN: writer steps: Write_Temp (partial or complete), Sync_Temp, Write_Marker(size, content-id), Rename_Temp_To_Final. At any instant a crash may occur; recovery inspects what exists: temp present?/size, marker present?/valid?, final present?/size == marker.size?/content-id matches?, derivation inputs unchanged (source id and script id equal the recorded ones) -> returns exactly one action: Use_Final | Delete_Temp_And_Use_Final | Discard_And_Rebuild | Rebuild_Stale_Derived | Report_Corrupt_Rebuild_From_Source. A pure total decision function over a small record of booleans/integers, plus the writer's step state machine.
PROVE: totality; a final file is Used only if its marker exists, sizes agree, the content id matches AND its derivation inputs are unchanged; a half-written temp file is never Used; for EVERY crash point of the writer's step sequence the recovery decision is safe (never Use a partial file) and, when the writer completed all steps, recovery Uses the file; decisions are deterministic and each precondition combination maps to exactly one action (state the truth table in the README).
ORACLE/DIFFERENTIAL: exhaustive truth-table enumeration of all input combinations (small integers for sizes) against a Python model, AND a simulated filesystem in Python that executes the writer with a crash injected at every step including torn writes (partial temp, marker written but rename not done), then runs recovery and checks the safety property; the native Ada decision function must agree with the Python decision on every state.`,
  },
  {
    key: 'changeset_log',
    dir: 'spark/core/changeset_log',
    spec: `
UNIT: changeset_log - the model of the persisted linear history behind checkpoints/undo/redo (PLAN.md Data model: ONE mechanism - change-set logs for all three databases; "an edit is never silently lost"; named checkpoints, undo/redo, revert; edits made downstream re-applied after upstream re-derivation with conflicts shown). Change-set CONTENTS are opaque (the SQLite session extension produces them); this unit proves the history bookkeeping only.
DESIGN: a bounded log of entries (each an opaque 64-bit change-set id) with a cursor (entries before the cursor are applied, after it are redoable), named checkpoints (bounded count, names <= 64 bytes, each remembers the cursor position at creation), operations: Append(id) (discards the redo tail - report how many entries were discarded explicitly), Undo, Redo, Checkpoint(name), Revert_To(name) (moves the cursor to the checkpoint's position; the entries after it stay redoable), Delete_Checkpoint, and Reapply_Plan: given a list of entries that must be replayed on top of a re-derived base, produce the replay order (the same order as logged) and a Conflict(entry) marker supplied by the caller's per-entry result - conflicts are recorded, never dropped. Capacity exhaustion returns an explicit Full status.
PROVE: totality; invariants (0 <= cursor <= length <= capacity; every checkpoint position <= length at all times; names unique); Undo then Redo is the identity and Redo then Undo likewise (when legal); Append after Undo discards exactly the redo tail and reports the exact count; Revert_To(name) lands exactly on the recorded position; no operation ever loses an entry except the redo tail on Append (state this as a postcondition); the replay plan contains every entry applied up to the cursor exactly once, in order, and every Conflict stays in the report.
ORACLE/DIFFERENTIAL: random operation sequences (>= 100000, various capacities incl. 1 and 2) against a Python reference model; exhaustive sequences up to length 7 for tiny capacities.`,
  },
]

const UNITS = GROUP === '2b' ? UNITS_2B : UNITS_2A

const allOk = (vs) => vs.every((v) => v && v.pass)

function authorPrompt(u) {
  return `${PREAMBLE}

YOUR UNIT DIRECTORY: ${REPO}/${u.dir}  (create it)
${u.spec}

DELIVERABLES: SPARK sources under src/, tests/ (run_tests.sh < 10 s), README.md (opening with the Guarantees section), PROOF.md (including benchmark numbers); \`${REPO}/spark/tools/prove.sh ${REPO}/${u.dir}\` exits 0.
Work iteratively: read the sources/spec, write the contracts first, then the body, then loop prove -> fix (ghost lemmas in <Unit>.Proofs, loop invariants, assertions; never Assume). When done return the structured result with real numbers copied from the final gnatprove summary and the real test outcome.`
}

function verifyPrompt(u, lens, author) {
  const common = `${PREAMBLE}

You are an INDEPENDENT, SKEPTICAL VERIFIER for unit "${u.key}" in ${REPO}/${u.dir} (author's own report: ${JSON.stringify({ status: author.status, unproved: author.unproved, assume_lines: author.assume_lines, tests_pass: author.tests_pass, divergences: author.old_behaviour_divergences, benchmark: author.benchmark })}). Do not trust the author's claims; re-run everything yourself. You may create temporary copies under /tmp but MUST NOT change files inside ${REPO}/${u.dir} (report findings instead). Default to pass=false when anything is doubtful. Unit spec for reference:
${u.spec}
`
  if (lens === 'mutation') return common + `
LENS: VACUITY / MUTATION. A proof only means something if the specification pins behaviour. Copy the unit directory to a temp directory and apply at least 8 DISTINCT behaviour-changing mutations to the implementation BODY (not the spec): off-by-one in a bound, flipped comparison, swapped operands, dropped branch, changed constant, wrong loop step, missing case, wrong sentinel. After each mutation run ${REPO}/spark/tools/prove.sh on the copy. EVERY non-equivalent mutant must make gnatprove FAIL (unproved check or compile error). For each survivor decide: equivalent mutant (explain why it cannot change observable behaviour) or SPECIFICATION WEAKNESS (blocker - say exactly which property is not pinned and propose the postcondition to add). Also report any contract that is trivially true or merely restates the body. pass=true only if there are no weakness survivors.`
  if (lens === 'differential') return common + `
LENS: INDEPENDENT DIFFERENTIAL TEST. Re-derive the oracle yourself from the old sources / format specs / SQLite itself (do not reuse the author's oracle blindly; write your own reference), rebuild and run the native Ada test program, and compare on the real data in ${DATA}/replays plus randomised and edge cases (at least as many as the spec demands). Run tests/run_tests.sh and time it (must be < 10 s). Hunt for disagreements, crashes, and domains where the Ada code errors where the oracle returns a value (or vice versa). pass=true only if everything is identical (modulo documented intentional-fix divergences) and the suite is fast.`
  if (lens === 'audit') return common + `
LENS: FIDELITY AND ASSUMPTION AUDIT. (1) Read the old source/spec and the new contract side by side; list any behavioural clause not captured by a postcondition. (2) grep the unit for pragma Assume, SPARK_Mode (Off), pragma Annotate (GNATprove...), Unchecked_Conversion, 'Unrestricted_Access, access types, Ada.*/System.* withs, nested subprograms, tasking, exceptions, non-64-bit size types - each must be absent or listed in register_items with a correct reason. (3) Run ${REPO}/spark/tools/prove.sh yourself and confirm UNPROVED=. (zero), report the real totals, confirm SPARK_Mode is on for the real bodies (nothing excluded). (4) Confirm PROOF.md/README.md are truthful. (5) Review old_behaviour_divergences: flag any not justified by the owner's overhaul spec. pass=true only if nothing blocker/major remains.`
  return common + `
LENS: ROBUSTNESS + SIMPLICITY + SPEED (charter). ROBUSTNESS: hammer every entry point with hostile input - empty, 1 byte, maximal sizes, boundary values, random garbage, values just outside every documented range - in a native fuzz program (>= 200000 cases); it must always return an explicit typed result and never crash/hang/raise; check termination bounds. SIMPLICITY: README must OPEN with a plain-English "Guarantees" section of at most ~10 lines that a newcomer understands; the public spec must be short and readable, proof scaffolding must live in <Unit>.Proofs child packages, nothing may exist that no feature/failure-mode row needs; flag any unnecessary generics/options/abstractions and say what could be deleted. SPEED: run the author's benchmark and an independent one; the native hot path must be fast for its use (state the number and whether it is plausible for a multi-GB workload); report accidental quadratic behaviour. pass=true only if there are no blocker/major findings in any of the three.`
}

function repairPrompt(u, author, failures) {
  return `${PREAMBLE}

You are the REPAIR worker for unit "${u.key}" in ${REPO}/${u.dir}. Independent verifiers found these problems (fix ALL blocker and major ones honestly - strengthen specifications rather than weakening anything, never use Assume):
${JSON.stringify(failures, null, 2)}
Unit spec for reference:
${u.spec}
Re-run ${REPO}/spark/tools/prove.sh ${REPO}/${u.dir} (must exit 0) and tests/run_tests.sh (must pass, < 10 s) after your fixes, update README.md/PROOF.md, and return the updated structured result (same schema as the author).`
}

phase('Author')
const results = await pipeline(
  UNITS,
  (u) => agent(authorPrompt(u), { label: `author:${u.key}`, phase: 'Author', schema: AUTHOR_SCHEMA }),
  async (author, u) => {
    if (!author) return { unit: u.key, verified: false, reason: 'author agent failed' }
    if (author.status !== 'proved' || author.unproved > 0 || !author.tests_pass) {
      return { unit: u.key, dir: u.dir, verified: false, reason: 'author reports partial/unproved/failing tests', author }
    }
    let cur = author
    let verdicts = []
    for (let round = 0; round <= 2; round++) {
      verdicts = await parallel(['mutation', 'differential', 'audit', 'robust_simple_speed'].map((lens) => () =>
        agent(verifyPrompt(u, lens, cur), { label: `verify:${u.key}:${lens}${round ? ':r' + round : ''}`, phase: 'Verify', schema: VERIFY_SCHEMA })))
      if (allOk(verdicts)) return { unit: u.key, dir: u.dir, verified: true, rounds: round, author: cur, verdicts }
      if (round === 2) break
      const failures = verdicts.filter(Boolean).filter((v) => !v.pass).map((v) => ({ lens: v.lens, findings: v.findings }))
      const fixed = await agent(repairPrompt(u, cur, failures), { label: `repair:${u.key}:r${round + 1}`, phase: 'Repair', schema: AUTHOR_SCHEMA })
      if (!fixed || fixed.status !== 'proved' || fixed.unproved > 0 || !fixed.tests_pass) {
        return { unit: u.key, dir: u.dir, verified: false, reason: 'repair failed or regressed', author: fixed || cur, verdicts }
      }
      cur = fixed
    }
    return { unit: u.key, dir: u.dir, verified: false, reason: 'verifiers still failing after 2 repair rounds', author: cur, verdicts }
  },
)

phase('Commit')
const verified = results.filter(Boolean).filter((r) => r.verified)
const notVerified = results.filter(Boolean).filter((r) => !r.verified)
log(`group ${GROUP}: ${verified.length}/${UNITS.length} units fully verified; not verified: ${notVerified.map((r) => r.unit).join(', ') || 'none'}`)
const commits = []
for (const r of verified) {
  const c = await agent(`In ${REPO} (branch claude/gifted-hawking-ukeg1n) commit ONLY the directory ${r.dir} (git add ${r.dir}; make sure no obj/, bin/, lib/, alire/, __pycache__ or other generated/binary artifacts and no real replay data are staged - check \`git status --short\` and \`git diff --cached --stat\`). Other workers commit concurrently: if git reports an index.lock, wait 5 seconds and retry (up to 6 times). The repo's git identity is already Claude <noreply@anthropic.com>; do not change it. Commit message first line: "Prove ${r.unit}: gnatprove 0 unproved, differential-tested" followed by a short body stating checks proved (${r.author.checks_total || '?'}), assumptions (${r.author.assume_lines || 0}), and divergences from the old engine (${(r.author.old_behaviour_divergences || []).length}); end the message with exactly these two trailer lines:
Co-Authored-By: Claude <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015xqUkf1dXtZxGewkf5eGpR
Do not push. Return the short commit hash.`, { label: `commit:${r.unit}`, phase: 'Commit', schema: COMMIT_SCHEMA, effort: 'low' })
  commits.push(c)
}
const push = verified.length ? await agent(`In ${REPO} run \`git push -u origin claude/gifted-hawking-ukeg1n\` once (if rejected as non-fast-forward because another worker pushed, run \`git pull --rebase origin claude/gifted-hawking-ukeg1n\` then push again; retry up to 4 times with 2s/4s/8s/16s backoff ONLY on network errors, not on 403/permission errors) and return the outcome verbatim.`, { label: 'push', phase: 'Commit', effort: 'low' }) : 'nothing to push'

return {
  group: GROUP,
  verified: verified.map((r) => ({ unit: r.unit, rounds: r.rounds, checks: r.author.checks_total, assumes: r.author.assume_lines, benchmark: r.author.benchmark, register_items: r.author.register_items, divergences: r.author.old_behaviour_divergences })),
  notVerified: notVerified.map((r) => ({ unit: r.unit, reason: r.reason, author: r.author && { status: r.author.status, unproved: r.author.unproved, summary: r.author.summary, register_items: r.author.register_items }, findings: r.verdicts && r.verdicts.filter(Boolean).filter((v) => !v.pass).map((v) => ({ lens: v.lens, findings: v.findings })) })),
  commits,
  push,
}
