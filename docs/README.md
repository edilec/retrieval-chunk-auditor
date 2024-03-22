# Design notes

The input is an exported snapshot, not a live index. `sourceHash` is the hash
the chunk export claimed at extraction time; the actual hash is recomputed
from the supplied `sources[].text`. A mismatch makes that chunk's downstream
source-span and boundary claims unavailable rather than treating the old text
as if it were current.

The source index is all-or-nothing for membership and hash comparison. An
invalid or duplicate source entry can hide the very id a chunk names, so the
auditor does not infer an orphan from an index with a hole. Token-count checks
are independent of source membership because the count is explicitly exported.

ATX heading boundaries are checked from the source text at UTF-16 character
positions. This is a narrow structural signal, not a Markdown parser: setext
headings and semantic paragraph quality are not inferred. Repeated text at
different spans is informational because legitimate documents repeat text.
