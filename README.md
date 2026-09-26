# Retrieval Chunk Auditor

Audit a local retrieval export before it is indexed. A chunk that has lost its
source, repeats another span, carries an old source hash, runs too large,
overlaps too much, or cuts a Markdown heading can make retrieval less
trustworthy. This tool reports those conditions from exported documents only;
it never builds an embedding, calls a model, or contacts a service.

## Quick start

Node 22 or later; no runtime or development dependencies.

```sh
node bin/retrieval-chunk-auditor.mjs --input examples/clean.json --json
node bin/retrieval-chunk-auditor.mjs --input examples/duplicate.json --json
npm run check
```

The second command emits a `fail` report and exits 1. `examples/stale.json`
shows an `incomplete` provenance report and exit 2. The CLI writes only a JSON
report to stdout. Without `--json`, a short operational summary goes to stderr.
It never writes or modifies an input or index.

## Export shape

The input is one UTF-8 JSON document. Its `sources` array holds the source text
**as exported**, not a path or URL to fetch. The tool computes SHA-256 over its
UTF-8 bytes. Each chunk names that source and carries the hash recorded when
it was cut. Thus a different source text is observable as a stale hash. JSON
objects with duplicate decoded key names are refused as incomplete: accepting
the last value would erase evidence from the export.

```json
{
  "schemaVersion": "1",
  "sources": [{ "id": "one", "text": "Hello.\n" }],
  "chunks": [{
    "id": "one-1", "sourceId": "one",
    "sourceHash": "a2c064616af4c66c576821616646bdfad5556a263b4b007847605118971f4389",
    "startChar": 0, "endChar": 7,
    "startToken": 0, "endToken": 2, "tokenCount": 2,
    "text": "Hello.\n"
  }]
}
```

IDs use ASCII letters/digits followed by letters, digits, `.`, `_`, `:` or
`-`. Hashes are lowercase hexadecimal SHA-256. Character offsets are
zero-based, half-open **JavaScript UTF-16 offsets** into the supplied source
text; token offsets are zero-based and half-open in the exporter's tokenizer.
The tool checks a supplied `tokenCount` against that span, but does not
re-tokenize the text. An absent count is unknown, not zero. An absent or invalid
source entry makes the source index incomplete: the tool then refuses positive
orphan and current-hash claims against the surviving index.

## Report and ordering

The report has `schemaVersion`, `tool`, `status`, `summary` and `findings`.
Findings carry a stable `ruleId`, frozen severity, bounded message, relative
input basename, array-index pointer, and a chunk `subject` where available.
They sort by `(subject, pointer, ruleId)` using UTF-16 code-unit order, not
locale collation. No source or chunk text is echoed. Identifiers with control
or bidi characters are invalid rather than rendered ambiguously. Repeated
content at different spans is an `info` candidate; it can be intentional, so
it does not fail an otherwise clean audit.

| Rule | Severity | Meaning |
| --- | --- | --- |
| `input-unreadable`, `input-invalid`, `input-too-large` | error | Input file unavailable, unusable or above the byte bound. |
| `depth-limit`, `record-limit`, `findings-truncated`, `analysis-timeout` | error | A declared bound prevented complete analysis. |
| `no-chunks` | error | No chunk evidence was supplied. |
| `source-invalid`, `source-duplicate`, `source-index-incomplete` | error | Source membership or hash comparison is unknown. |
| `chunk-invalid`, `chunk-id-duplicate`, `chunk-provenance-missing` | error | A chunk cannot be uniquely identified or traced. |
| `token-count-missing`, `token-span-invalid` | error | Token size or placement is unknown. |
| `orphan-chunk`, `stale-source-hash`, `chunk-text-mismatch` | error | Declared source provenance is absent or does not match. |
| `duplicate-source-span` | error | Two chunks repeat the same source span. |
| `chunk-too-large`, `excessive-overlap` | error | A known token count or overlap exceeds policy. |
| `boundary-splits-heading` | error | A chunk ends inside an ATX Markdown heading line. |
| `repeated-content` | info | Identical text appears at a different source span; review it. |

Every rule through `chunk-text-mismatch` in the table marks the run
`incomplete`: evidence was unavailable or not trustworthy. The four known
policy defects after it fail a complete run. `repeated-content` only informs.
`status: pass` requires at least one checked chunk and no error or incomplete
finding. An unknown rule id is a programming error, never an implicit warning.

| Exit | Meaning | stdout |
| ---: | --- | --- |
| 0 | Completed with no failing rule | JSON report |
| 1 | Completed; known policy violation | JSON report |
| 2 | Invalid configuration | empty |
| 2 | Unreadable, malformed, unknown or bounded evidence | `incomplete` JSON report |

## Limits

| Flag | Default | Bound |
| --- | ---: | --- |
| `--max-bytes` | 4194304 | input UTF-8 bytes, checked before and after read |
| `--max-records` | 5000 | sources plus chunks |
| `--max-depth` | 32 | JSON nesting depth after parse |
| `--max-tokens` | 800 | declared tokens in one chunk |
| `--max-overlap-tokens` | 64 | adjacent declared token overlap; zero allowed |
| `--max-findings` | 1000 | ordinary findings before a truncation sentinel |
| `--timeout-ms` | 30000 | cooperative analysis time; maximum 3600000 |

Each bound is inclusive: exactly N is allowed and N+1 is reported. A limit
that prevents evidence is `incomplete` and exit 2. The clock is injected into
the library for deterministic tests; the CLI uses a monotonic clock. The
deadline is cooperative, not preemptive: a single JSON parse, filesystem call,
native string search or sort can overrun it before the next checkpoint. The
report contains no timestamp or elapsed duration.

## Non-goals

- No tokenizer, embedding or semantic-similarity judgment. Exported token
  counts and offsets are checked for internal consistency only.
- No remote fetching or source discovery. The exported source text is the
  entire provenance basis.
- No assertion that repeated words at different spans are erroneous.
- No mutation, deduplication or repair of the retrieval index.

## Development

`npm run check` runs syntax checks, `node:test`, all runnable examples and a
local packaging dry run. Everything works offline with Node's standard library.

MIT. See [LICENSE](./LICENSE).
