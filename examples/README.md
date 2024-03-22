# Runnable examples

`clean.json` is a complete one-chunk export (exit 0). `duplicate.json`
repeats the same source span (exit 1). `stale.json` names an old source hash,
so its provenance is unknown (exit 2). All content is synthetic and local.

Run `npm run example`, `npm run example:failing`, or
`npm run example:incomplete` from the repository root.
