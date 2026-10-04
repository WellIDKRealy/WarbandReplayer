// Proof-factory workflow script for Claude Code's Workflow tool (run with ultracode). Pass args: {repo, data} (batch2 also group: '2a'|'2b').
// If Workflow/subagents are unavailable or too costly, follow the same loop by hand: author -> prove.sh -> mutation/differential/audit/robustness checks -> repair -> commit.
export const meta = {
  name: 'spark-proof-factory-batch1',
  description: 'Author, prove, adversarially verify and commit six SPARK units (boundary segmentation, tick index, tar layout, civil time, eviction policy, SQL tokenizer)',
  whenToUse: 'Proof-first port of independent pure-logic units of WarbandReplayer to Ada/SPARK',
  phases: [
    { title: 'Author', detail: 'write SPARK spec+body, prove to 0 unproved, native differential tests' },
    { title: 'Verify', detail: 'mutation (vacuity), independent differential, fidelity/assumption audit' },
    { title: 'Repair', detail: 'fix verifier findings, re-verify (max 2 rounds)' },
    { title: 'Commit', detail: 'serial commit per verified unit, then push' },
  ],
}

const REPO = (args && args.repo) || '/path/to/WarbandReplayer'  // pass args.repo
const DATA = (args && args.data) || '/path/to/data'  // pass args.data (extracted real replays live in DATA/replays; never commit them)

const PREAMBLE = `
You are one worker in a proof-first port of the WarbandReplayer project (a Mount & Blade Warband replay viewer, bare-metal
WebAssembly) from C/JS to Ada/SPARK. The OLD implementation (C in ${REPO}/*.c, JS in ${REPO}/*.js, SQL in ${REPO}/sql/) is the
behavioural ORACLE: do NOT modify any existing file. Work only inside your unit directory (given below). Do NOT run any git
command that writes (no add/commit/push/checkout/reset) - the orchestrator commits. Owner's rules, all binding:
 * PROOFS BEFORE TESTS. The unit must be SPARK (SPARK_Mode On) and \`${REPO}/spark/tools/prove.sh <unit-dir>\` must exit 0
   (gnatprove 14.1, level 4: 0 unproved checks). Prove absence of run-time errors AND functional postconditions that PIN the
   intended behaviour (Gold level) - not trivially-true contracts. Never weaken a contract to make a proof pass; never hide
   behaviour in Ghost code; never use pragma Assume, SPARK_Mode (Off), or pragma Annotate (GNATprove, ...) justifications unless
   truly unavoidable - and then list each one in register_items with the exact reason it cannot be proven (the owner alone
   decides whether it may be tested instead). If something cannot be fully proven, say so honestly (status "partial"); a clean
   honest "partial" is far better than a fake "proved".
 * Target constraints (GNAT-LLVM wasm32 later): no nested subprograms, no tasking/protected types, no non-local exception
   propagation, no Ada.Text_IO/containers/standard-library units inside the proof package, no elaboration-time state, no
   32-bit byte counts (use 64-bit / Long_Long_Integer / Interfaces.Unsigned_64 where sizes can be large). Keep it zero-footprint.
 * Tooling: \`. ${REPO}/spark/tools/env.sh\` puts gnatprove/gnat/gprbuild on PATH. Copy ${REPO}/spark/templates/unit.gpr as
   <unit>.gpr and rename the project. Layout: <unit-dir>/src (SPARK sources), <unit-dir>/tests (native Ada differential test
   program + own tests.gpr + run_tests.sh that finishes in under 10 seconds), <unit-dir>/README.md (contract <-> old behaviour
   mapping, with old file:line references) and <unit-dir>/PROOF.md (final gnatprove summary + register items).
 * The machine has 4 CPUs shared with a background compiler build: use gnatprove -j1 (prove.sh already does), never run provers
   in parallel, keep test runs short.
 * Real replay data (NEVER copy it into the repo - it contains other players' names/chat): ${DATA}/replays/*.sqlite (31
   non-empty files, same 9-table schema as ${REPO}/lua/main.lua writes - that file is FROZEN, read-only). Derived integer-only
   oracle cases may be committed. Python3 (sqlite3 module) and node 22 are available for oracles.
 * The old tree may contain bugs. Port faithful behaviour by default; every place where you deliberately differ (e.g. removing
   a hard cap, fixing an overflow) must be listed in old_behaviour_divergences with a classification: "intentional-fix" (matches
   the owner's overhaul spec: no silent caps, 64-bit sizes, explicit errors instead of truncation/UB) or "faithful".
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

const UNITS = [
  {
    key: 'boundary_segmentation',
    dir: 'spark/core/boundary_segmentation',
    spec: `
UNIT: boundary_segmentation - the pure algorithm that turns "boundary tick indexes" into battle spans (FEATURES: "SQL-defined battle boundary detection").
OLD SOURCES (read fully): ${REPO}/sql/default_boundary_detection.sql (the two folds + tail segment; constants SKIP_FIRST=5, MERGE_WINDOW=15, MIN_MATCH_GAP=10, MIN_TAIL_GAP=5), ${REPO}/replay_worker.c scan_matches_via_sql (~lines 1419-1487), ${REPO}/testdata/ground_truth.py scan_matches (Python reimplementation).
INPUT: N = number of ticks, and a strictly increasing array of distinct boundary tick INDEXES (positions in the ordered tick list). OUTPUT: ordered list of spans (start_idx, end_idx).
NEW REQUIREMENT (owner's overhaul spec): NO 16-battle cap and no silent truncation - the output capacity is a parameter; if the output array is too small return an explicit Overflow status instead of truncating; the algorithm itself has no cap.
PROVE at least: no run-time errors for all N up to 2**40 and boundary counts up to 2**31; spans are strictly ordered and non-overlapping; every accepted span except the tail has length >= MIN_MATCH_GAP (end-start >= 10 per the SQL's start_idx rule - read it carefully and state the exact property); the merge pass keeps only boundaries with idx>=5 that are more than 15 past the previously KEPT one; the tail rule; and that the output EQUALS the reference semantics - express the semantics as a Ghost specification (recursive or loop-fold) and prove the implementation refines it.
ORACLE/DIFFERENTIAL: ${DATA}/golden/boundary_cases.txt (31 real cases: lines "CASE name", "N <ticks>", "B <boundary idx...>", "E <start end start end ...>" = expected spans from the old uncapped SQL). Copy that file into <unit>/tests/ (integers only, safe to commit). Also generate >= 2000 random synthetic cases by building an in-memory SQLite DB with a ticks table and events (map_switch/score_switch/faction_switch at chosen ticks), run the REAL ${REPO}/sql/default_boundary_detection.sql through Python's sqlite3, and require the native Ada test program to produce identical spans.`,
  },
  {
    key: 'tick_index',
    dir: 'spark/core/tick_index',
    spec: `
UNIT: tick_index - tick lookup by time, interpolation alpha and lerp/angle blending used by playback (FEATURES: "Playback", "interpolation").
OLD SOURCES (read fully): ${REPO}/replay_worker.c find_tick_index_for_time (~1188-1198), build_frame_at_time (~1235-1292), TickEntry (~122-129; time is a 64-bit double because Unix times ~1.7e9 would collapse in float; ticks.time is whole seconds), ${REPO}/main.js matchIndexForTime (~2504), blendAngleDeg (~795, shortest-angle blend). A proven starting point exists at ${REPO}/spark/spikes/tick_lookup (binary search with a full postcondition) - reuse and generalise it (64-bit indexes, up to 2**31 ticks).
PROVE: no run-time errors; Last_At_Or_Before returns the greatest index with time<=t (or the documented sentinel) for sorted times - including duplicates (the real data has many equal consecutive times, whole-second resolution); alpha computation matches build_frame_at_time exactly: alpha in [0,1], no division by zero when timeB==timeA, alpha=0 exactly at/before timeA, alpha=1 exactly at/after timeB; lerp stays between its endpoints and returns the exact endpoint at alpha=0 and alpha=1; blend_angle_deg returns the shortest-path interpolation with a proven bound. Floating point: use Long_Float/Float with explicit finite range subtypes (SPARK float rules) - prove finiteness and the range properties; state honestly any bit-exactness you cannot prove (register_items).
ORACLE/DIFFERENTIAL: extract the real tick time arrays (SELECT time FROM ticks ORDER BY id) from every file in ${DATA}/replays/*.sqlite with Python and compare the native Ada program against a Python reference of the old C logic for >= 100000 query times per file class (random + edge cases: before first, after last, exactly on ticks, between equal ticks).`,
  },
  {
    key: 'tar_layout',
    dir: 'spark/leaf/tar_layout',
    spec: `
UNIT: tar_layout - ustar header construction and size accounting for the battle export bundle (FEATURES: "Export active battle ... tar.xz", "Load Battle Export").
OLD SOURCES (read fully): ${REPO}/replay_export.c tar_add_entry/octal_field/checksum and tar buffer growth (~1150-1200 and the export function ~1265-1404), ${REPO}/main.js parseTar (~12) and parseOctalField (~7).
PROVE: no run-time errors with 64-bit sizes; octal_field writes exactly the field width with NUL/space terminator semantics of the old code and round-trips (decode(encode(v))=v for all v that fit 11 octal digits; explicit error otherwise, never truncation); the header checksum equals the sum of the 512 header bytes with the checksum field treated as 8 spaces; header is exactly 512 bytes; padding to 512 is correct; total archive size = sum over entries of (512 + ceil(size/512)*512) + 1024 (two zero blocks) - prove this formula for any entry list; parse(build(entries)) = entries for entry names up to the ustar limit.
ORACLE/DIFFERENTIAL: the native test program builds archives; verify them with Python's tarfile (names, sizes, content) and with \`tar -tvf\`; also feed Python-generated tar files (tarfile, GNU and ustar formats limited to what the old parser accepts) to the Ada parser and compare against main.js parseTar run under node on the same bytes.`,
  },
  {
    key: 'civil_time',
    dir: 'spark/leaf/civil_time',
    spec: `
UNIT: civil_time - days<->civil-date conversion used by the custom libc localtime (SQLite needs it for date functions).
OLD SOURCES (read fully): ${REPO}/goyslopless-c/lib/time.c and ${REPO}/goyslopless-c/include/time.h (time_t is a 32-bit long there: a known 2038 defect - the overhaul uses 64-bit time).
PROVE: no run-time errors for the entire documented domain (state it: e.g. days within +-2**40 or the full int64 seconds range if provable); civil_from_days always yields year/month/day with month in 1..12 and day in 1..days_in_month(year,month) (leap-year rule exact); days_from_civil(civil_from_days(d)) = d and civil_from_days(days_from_civil(y,m,d)) = (y,m,d) for valid dates (round trip both ways); weekday and yday correct (define weekday via (days+4) mod 7 for 1970-01-01 = Thursday and prove the successor relation); monotonicity: d1<d2 implies the date tuple is lexicographically greater.
ORACLE/DIFFERENTIAL: Python datetime/calendar for all days 0001-01-01..9999-12-31 (every day, fast loop in the native test program fed by a generated reference file or recomputed in the program with an independent simple algorithm that is itself obviously correct) plus negative/huge values beyond Python's range checked via the round-trip properties only.`,
  },
  {
    key: 'eviction_policy',
    dir: 'spark/core/eviction_policy',
    spec: `
UNIT: eviction_policy - which prepared/primed battle to evict or prefetch next under a memory budget (FEATURES: "Per-battle index priming and prefetch ahead of the cursor with memory budget; never evicts the live battle").
OLD SOURCES (read fully): ${REPO}/replay_worker.c pick_farthest_primed_battle, replay_try_prime_battle, replay_evict_battle and the ready mask (~396-540; note the 16-bit mask and (int) heap_bytes wrap defects), ${REPO}/replay_export.c bc_pick_victim and bc cache bookkeeping (~499-660), ${REPO}/main.js pickPrefetchTarget (~2516), pickPrimeTarget (~2586), pickSummaryPrewarmTarget (~2620), computePrimingBudgetBytes (~2338).
NEW REQUIREMENTS (owner's overhaul spec): no battle-count cap and no bitmask - model the ready set as an array of Booleans over N battles (N up to 2**31); all byte quantities 64-bit unsigned; a global budget invariant allocated <= budget.
PROVE: no run-time errors; pick_victim returns a ready battle that is NOT the live/from battle, whose time-distance to the target is maximal among ready battles (ties resolved exactly like the old code - determine and state the rule), or 'none'; the anti-thrash rule (decline when victim distance <= target distance) exactly as the old try_prime; after prime/evict operations the ready-set invariants hold and the budget accounting never underflows or exceeds budget; the JS pick*Target functions' selection rules, as pure functions, pinned by postconditions.
ORACLE/DIFFERENTIAL: write a faithful Python port of the old C+JS logic (from the sources, not from your Ada) and compare against the native Ada program on >= 50000 random scenarios (random N, ready sets, positions, budgets) plus hand-picked edge cases (empty ready set, only the live battle ready, equal distances).`,
  },
  {
    key: 'sql_tokenizer',
    dir: 'spark/leaf/sql_tokenizer',
    spec: `
UNIT: sql_tokenizer - the SQL tokenizer behind syntax highlighting, autocomplete and the write-back identifier handling (FEATURES: SQL Terminal highlight/autocomplete; the future strict write-back statement builder depends on it).
OLD SOURCE (read fully): ${REPO}/sql-tokenizer.js (242 lines) and its users in ${REPO}/main.js (attachSqlHighlighting ~4492, qualifyBareTableNames ~4324, queryWriteBackTable ~4358, autocompleteCandidates ~4578).
Offsets: JS strings are UTF-16 but the Ada/wasm side sees UTF-8 bytes - define tokens over BYTES (UTF-8), document the exact mapping, and make the token list identical (type + byte span) to the JS tokens after mapping offsets.
PROVE: no run-time errors for inputs up to 2**32 bytes; the tokenizer is total and terminates (loop variant) on every input including unterminated strings/comments/quoted identifiers and invalid UTF-8; the tokens PARTITION the input exactly (contiguous, no gaps, no overlap, concatenation of spans = input, token count <= input length); each token's type classification is pinned by postconditions (keyword/identifier/number/string/comment/punctuation/whitespace per the JS rules) - prove the classification functions against explicit character-class predicates; identifier unquoting/quoting helpers (if the JS has them) round-trip.
ORACLE/DIFFERENTIAL: run the real sql-tokenizer.js under node over a corpus (every ${REPO}/sql/*.sql, every SQL string literal you can extract from main.js and testdata/ui_behavior_tests.js, plus >= 20000 randomly generated/mutated strings including multi-byte UTF-8, unterminated constructs and lone surrogates) and require byte-identical token sequences from the native Ada program.`,
  },
]

const allOk = (vs) => vs.every((v) => v && v.pass)

function authorPrompt(u) {
  return `${PREAMBLE}

YOUR UNIT DIRECTORY: ${REPO}/${u.dir}  (create it)
${u.spec}

DELIVERABLES: SPARK sources under src/, tests/ (run_tests.sh < 10 s), README.md, PROOF.md; \`${REPO}/spark/tools/prove.sh ${REPO}/${u.dir}\` exits 0.
Work iteratively: read the old code, write the contracts first, then the body, then loop prove -> fix (ghost lemmas, loop invariants, assertions; never Assume). When done return the structured result with real numbers copied from the final gnatprove summary and the real test outcome.`
}

function verifyPrompt(u, lens, author) {
  const common = `${PREAMBLE}

You are an INDEPENDENT, SKEPTICAL VERIFIER for unit "${u.key}" in ${REPO}/${u.dir} (author's own report: ${JSON.stringify({ status: author.status, unproved: author.unproved, assume_lines: author.assume_lines, tests_pass: author.tests_pass, divergences: author.old_behaviour_divergences })}). Do not trust the author's claims; re-run everything yourself. You may create temporary copies under /tmp but MUST NOT change files inside ${REPO}/${u.dir} (report findings instead). Default to pass=false when anything is doubtful. Unit spec for reference:
${u.spec}
`
  if (lens === 'mutation') return common + `
LENS: VACUITY / MUTATION. A proof only means something if the specification pins behaviour. Copy the unit directory to a temp directory and apply at least 8 DISTINCT behaviour-changing mutations to the implementation BODY (not the spec): off-by-one in a bound, flipped comparison, swapped operands, dropped branch, changed constant, wrong loop step, missing case, wrong sentinel. After each mutation run ${REPO}/spark/tools/prove.sh on the copy. EVERY non-equivalent mutant must make gnatprove FAIL (unproved check or compile error). For each survivor decide: equivalent mutant (explain why it cannot change observable behaviour) or SPECIFICATION WEAKNESS (blocker - describe exactly which property is not pinned and propose the postcondition to add). Also report any contract that is trivially true or restates the body without pinning behaviour. pass=true only if there are no weakness survivors.`
  if (lens === 'differential') return common + `
LENS: INDEPENDENT DIFFERENTIAL TEST. Re-derive the oracle yourself from the OLD sources (do not reuse the author's oracle script blindly; read the old code and write your own reference), rebuild and run the native Ada test program, and compare on the real data in ${DATA}/replays plus randomised and edge cases (at least as many as the spec demands). Run tests/run_tests.sh and time it (must be < 10 s). Hunt for disagreements, crashes, and domains where the Ada code raises or returns an error status where the old code returned a value. pass=true only if everything is byte/semantically identical (modulo documented intentional-fix divergences) and the suite is fast.`
  return common + `
LENS: FIDELITY AND ASSUMPTION AUDIT. (1) Read the old source and the new spec side by side and check EVERY behavioural clause; list any behaviour that exists in the old code but is not captured by a postcondition. (2) grep the unit for pragma Assume, SPARK_Mode (Off), pragma Annotate (GNATprove...), Unchecked_Conversion, 'Unrestricted_Access, access types, Ada.* and System.* withs, nested subprograms, tasking, exceptions raised/handled, non-64-bit size types - each must be absent or listed in register_items with a correct reason. (3) Run ${REPO}/spark/tools/prove.sh yourself and confirm UNPROVED=. (zero) and report the real totals; confirm the proof actually analysed the real bodies (SPARK_Mode on in src, no excluded subprograms). (4) Confirm PROOF.md/README.md are truthful. (5) Review old_behaviour_divergences: flag any divergence not justified by the owner's overhaul spec (no silent caps, 64-bit sizes, explicit errors instead of UB). pass=true only if nothing blocker/major remains.`
}

function repairPrompt(u, author, failures) {
  return `${PREAMBLE}

You are the REPAIR worker for unit "${u.key}" in ${REPO}/${u.dir}. Independent verifiers found these problems (fix ALL blocker and major ones, honestly - strengthen specifications rather than weakening anything, never use Assume):
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
      verdicts = await parallel(['mutation', 'differential', 'audit'].map((lens) => () =>
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
log(`${verified.length}/${UNITS.length} units fully verified; not verified: ${notVerified.map((r) => r.unit).join(', ') || 'none'}`)
const commits = []
for (const r of verified) {
  const c = await agent(`In ${REPO} (branch claude/gifted-hawking-ukeg1n) commit ONLY the directory ${r.dir} (git add ${r.dir}; make sure no obj/, lib/, alire/ or other generated/binary artifacts and no real replay data are staged - check \`git status --short\` and \`git diff --cached --stat\`). The repo's git identity is already Claude <noreply@anthropic.com>; do not change it. Commit message first line: "Prove ${r.unit}: gnatprove 0 unproved, differential-tested" followed by a short body stating checks proved (${r.author.checks_total || '?'}), assumptions (${r.author.assume_lines || 0}), and divergences from the old engine (${(r.author.old_behaviour_divergences || []).length}); end the message with exactly these two trailer lines:
Co-Authored-By: Claude <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015xqUkf1dXtZxGewkf5eGpR
Do not push. Return the short commit hash.`, { label: `commit:${r.unit}`, phase: 'Commit', schema: COMMIT_SCHEMA, effort: 'low' })
  commits.push(c)
}
const push = verified.length ? await agent(`In ${REPO} run \`git push -u origin claude/gifted-hawking-ukeg1n\` once (retry up to 4 times with 2s/4s/8s/16s backoff ONLY on network errors, not on 403/permission errors) and return the outcome verbatim.`, { label: 'push', phase: 'Commit', effort: 'low' }) : 'nothing to push'

return {
  verified: verified.map((r) => ({ unit: r.unit, rounds: r.rounds, checks: r.author.checks_total, assumes: r.author.assume_lines, register_items: r.author.register_items, divergences: r.author.old_behaviour_divergences })),
  notVerified: notVerified.map((r) => ({ unit: r.unit, reason: r.reason, author: r.author && { status: r.author.status, unproved: r.author.unproved, summary: r.author.summary, register_items: r.author.register_items }, findings: r.verdicts && r.verdicts.filter(Boolean).filter((v) => !v.pass).map((v) => ({ lens: v.lens, findings: v.findings })) })),
  commits,
  push,
}
