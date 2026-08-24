// From-scratch SQLite lexer (tokenizer, not a full grammatical/AST parser -
// see the plan this was built from: statement structure/clause nesting/
// expression precedence aren't needed for what this drives - syntax
// highlighting and autocomplete's "what identifier is the caret in right
// now" boundary detection, both of which only need correct token
// classification, not a parse tree). Hand-written character-by-character
// scan, not a pile of best-effort regexes - the point is getting SQLite's
// actual lexical rules right (doubled-quote escaping in all three
// identifier-quoting styles, no-backslash-escaping in string literals,
// non-nesting block comments, hex/scientific numeric literals, blob
// literals, keyword case-insensitivity), which a shortcut highlighter
// reliably gets wrong on the edge cases.
//
// tokenizeSQL(text) -> [{type, text, start, end}, ...], covering every
// character of `text` exactly once (whitespace included as its own token
// type) - callers that need to reconstruct/measure the original text
// (the highlighting backdrop) can rely on token spans being contiguous and
// gap-free.

// SQLite's real keyword set (parse.y's keyword table) - matched
// case-insensitively, exactly as SQLite itself does.
const SQL_KEYWORDS = new Set([
  "ABORT", "ACTION", "ADD", "AFTER", "ALL", "ALTER", "ALWAYS", "ANALYZE", "AND", "AS", "ASC",
  "ATTACH", "AUTOINCREMENT", "BEFORE", "BEGIN", "BETWEEN", "BY", "CASCADE", "CASE", "CAST",
  "CHECK", "COLLATE", "COLUMN", "COMMIT", "CONFLICT", "CONSTRAINT", "CREATE", "CROSS",
  "CURRENT", "CURRENT_DATE", "CURRENT_TIME", "CURRENT_TIMESTAMP", "DATABASE", "DEFAULT",
  "DEFERRABLE", "DEFERRED", "DELETE", "DESC", "DETACH", "DISTINCT", "DO", "DROP", "EACH",
  "ELSE", "END", "ESCAPE", "EXCEPT", "EXCLUDE", "EXCLUSIVE", "EXISTS", "EXPLAIN", "FAIL",
  "FILTER", "FIRST", "FOLLOWING", "FOR", "FOREIGN", "FROM", "FULL", "GENERATED", "GLOB",
  "GROUP", "GROUPS", "HAVING", "IF", "IGNORE", "IMMEDIATE", "IN", "INDEX", "INDEXED",
  "INITIALLY", "INNER", "INSERT", "INSTEAD", "INTERSECT", "INTO", "IS", "ISNULL", "JOIN",
  "KEY", "LAST", "LEFT", "LIKE", "LIMIT", "MATCH", "MATERIALIZED", "NATURAL", "NO", "NOT",
  "NOTHING", "NOTNULL", "NULL", "NULLS", "OF", "OFFSET", "ON", "OR", "ORDER", "OTHERS",
  "OUTER", "OVER", "PARTITION", "PLAN", "PRAGMA", "PRECEDING", "PRIMARY", "QUERY", "RAISE",
  "RANGE", "RECURSIVE", "REFERENCES", "REGEXP", "REINDEX", "RELEASE", "RENAME", "REPLACE",
  "RESTRICT", "RETURNING", "RIGHT", "ROLLBACK", "ROW", "ROWS", "SAVEPOINT", "SELECT", "SET",
  "TABLE", "TEMP", "TEMPORARY", "THEN", "TIES", "TO", "TRANSACTION", "TRIGGER", "UNBOUNDED",
  "UNION", "UNIQUE", "UPDATE", "USING", "VACUUM", "VALUES", "VIEW", "VIRTUAL", "WHEN",
  "WHERE", "WINDOW", "WITH", "WITHOUT",
]);

function isDigit(c) { return c >= "0" && c <= "9"; }
function isHexDigit(c) { return isDigit(c) || (c >= "a" && c <= "f") || (c >= "A" && c <= "F"); }
function isIdentStart(c) { return c === "_" || (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c.charCodeAt(0) > 127; }
function isIdentPart(c) { return isIdentStart(c) || isDigit(c); }
function isWhitespace(c) { return c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v"; }

function tokenizeSQL(text) {
  const tokens = [];
  const n = text.length;
  let i = 0;

  function push(type, start) { tokens.push({ type, text: text.slice(start, i), start, end: i }); }

  while (i < n) {
    const start = i;
    const c = text[i];

    // ---- whitespace ----
    if (isWhitespace(c)) {
      while (i < n && isWhitespace(text[i])) i++;
      push("whitespace", start);
      continue;
    }

    // ---- comments: "-- to end of line" and "/* non-nesting block */" ----
    if (c === "-" && text[i + 1] === "-") {
      i += 2;
      while (i < n && text[i] !== "\n") i++;
      push("comment", start);
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      const close = text.indexOf("*/", i);
      i = close === -1 ? n : close + 2;
      push("comment", start);
      continue;
    }

    // ---- string literal: 'single quoted', '' is the only escape (no backslash) ----
    if (c === "'") {
      i++;
      for (;;) {
        if (i >= n) break; // unterminated - stop at EOF, still a usable span for highlighting
        if (text[i] === "'") {
          if (text[i + 1] === "'") { i += 2; continue; } // doubled quote = literal quote, keep scanning
          i++; break;
        }
        i++;
      }
      push("string", start);
      continue;
    }

    // ---- blob literal: x'...'/X'...' (hex digit pairs) - must check before
    // falling into the generic identifier path below, since it starts with
    // what looks like a one-letter identifier. ----
    if ((c === "x" || c === "X") && text[i + 1] === "'") {
      i += 2;
      while (i < n && text[i] !== "'") i++;
      if (i < n) i++; // closing quote
      push("blob", start);
      continue;
    }

    // ---- quoted identifiers: three real SQLite forms, three different
    // escape rules ----
    if (c === '"') { // doubled "" = literal "
      i++;
      for (;;) {
        if (i >= n) break;
        if (text[i] === '"') {
          if (text[i + 1] === '"') { i += 2; continue; }
          i++; break;
        }
        i++;
      }
      push("quoted_identifier", start);
      continue;
    }
    if (c === "`") { // doubled `` = literal `
      i++;
      for (;;) {
        if (i >= n) break;
        if (text[i] === "`") {
          if (text[i + 1] === "`") { i += 2; continue; }
          i++; break;
        }
        i++;
      }
      push("quoted_identifier", start);
      continue;
    }
    if (c === "[") { // no escape mechanism - matches to the first ']'
      i++;
      while (i < n && text[i] !== "]") i++;
      if (i < n) i++;
      push("quoted_identifier", start);
      continue;
    }

    // ---- bind parameters: ?, ?NNN, :name, @name, $name ----
    if (c === "?") {
      i++;
      while (i < n && isDigit(text[i])) i++;
      push("bind_param", start);
      continue;
    }
    if (c === ":" || c === "@" || c === "$") {
      const markerLen = 1;
      let j = i + markerLen;
      if (j < n && isIdentStart(text[j])) {
        j++;
        while (j < n && isIdentPart(text[j])) j++;
        i = j;
        push("bind_param", start);
        continue;
      }
      // bare ':'/'@'/'$' with no following identifier - not a real bind
      // param, falls through to plain punctuation below.
    }

    // ---- numeric literals: hex (0x1F), or decimal with optional
    // fraction/exponent (1, 1.5, 1., .5, 1e10, 1.5e-3) ----
    if (isDigit(c) || (c === "." && isDigit(text[i + 1]))) {
      if (c === "0" && (text[i + 1] === "x" || text[i + 1] === "X")) {
        i += 2;
        while (i < n && isHexDigit(text[i])) i++;
        push("number", start);
        continue;
      }
      while (i < n && isDigit(text[i])) i++;
      if (text[i] === ".") { i++; while (i < n && isDigit(text[i])) i++; }
      if (text[i] === "e" || text[i] === "E") {
        let j = i + 1;
        if (text[j] === "+" || text[j] === "-") j++;
        if (isDigit(text[j])) {
          i = j;
          while (i < n && isDigit(text[i])) i++;
        }
      }
      push("number", start);
      continue;
    }

    // ---- identifiers / keywords ----
    if (isIdentStart(c)) {
      i++;
      while (i < n && isIdentPart(text[i])) i++;
      const word = text.slice(start, i);
      push(SQL_KEYWORDS.has(word.toUpperCase()) ? "keyword" : "identifier", start);
      continue;
    }

    // ---- operators (longest match first) / punctuation ----
    const two = text.slice(i, i + 2);
    if (two === "<<" || two === ">>" || two === "<=" || two === ">=" || two === "<>" ||
        two === "==" || two === "!=" || two === "||") {
      i += 2;
      push("operator", start);
      continue;
    }
    if ("=<>+-*/%&|~".indexOf(c) !== -1) {
      i++;
      push("operator", start);
      continue;
    }
    if ("(),;.".indexOf(c) !== -1) {
      i++;
      push("punctuation", start);
      continue;
    }

    // Anything else (stray control/unrecognized character) - one-character
    // "unknown" token rather than looping forever or throwing, so a
    // pathological/partial input still tokenizes fully.
    i++;
    push("unknown", start);
  }

  return tokens;
}

// Returns the token the caret at `pos` (0-based text offset) is "inside" -
// used by autocomplete to find the identifier being typed, and by the
// query auto-qualification rewrite to only touch real bare-identifier
// tokens (never inside a string/comment/quoted-identifier). A caret
// exactly between two tokens is considered part of the token immediately
// before it (matches how typing normally extends the token you just
// finished), except at position 0.
function tokenAtPosition(tokens, pos) {
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (pos > t.start && pos <= t.end) return t;
  }
  return null;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { tokenizeSQL, tokenAtPosition, SQL_KEYWORDS };
}
