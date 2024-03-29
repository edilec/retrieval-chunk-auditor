import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import * as tool from '../src/index.mjs'

const SOURCE = '# Intro\nAlpha beta.\n## Next\nGamma delta.\n'
const HASH = createHash('sha256').update(SOURCE).digest('hex')
const CUT = SOURCE.indexOf('## Next')

function document() {
  return {
    schemaVersion: '1',
    sources: [{ id: 'guide', text: SOURCE }],
    chunks: [
      { id: 'a', sourceId: 'guide', sourceHash: HASH, startChar: 0, endChar: CUT,
        startToken: 0, endToken: 4, tokenCount: 4, text: SOURCE.slice(0, CUT) },
      { id: 'b', sourceId: 'guide', sourceHash: HASH, startChar: CUT, endChar: SOURCE.length,
        startToken: 4, endToken: 8, tokenCount: 4, text: SOURCE.slice(CUT) },
    ],
  }
}

function ids(report) { return report.findings.map((finding) => finding.ruleId) }

test('a complete, correctly partitioned export passes without findings', () => {
  assert.equal(typeof tool.auditChunks, 'function')
  const report = tool.auditChunks(document())
  assert.equal(report.tool, 'retrieval-chunk-auditor')
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.checked, 2)
  assert.deepEqual(ids(report), [])
})

test('duplicate source spans and orphan chunks are located, never silently dropped', () => {
  const input = document()
  input.chunks.push({ ...input.chunks[0], id: 'duplicate' })
  input.chunks.push({ ...input.chunks[0], id: 'orphan', sourceId: 'absent' })
  const report = tool.auditChunks(input)
  assert.equal(report.status, 'incomplete')
  assert.ok(ids(report).includes('duplicate-source-span'))
  assert.ok(ids(report).includes('orphan-chunk'))
  assert.equal(report.findings.find((finding) => finding.ruleId === 'orphan-chunk').subject, 'orphan')
})

test('a chunk boundary inside a heading is reported but a boundary before it is clean', () => {
  const good = tool.auditChunks(document())
  assert.ok(!ids(good).includes('boundary-splits-heading'))
  const input = document()
  const split = CUT + 4
  input.chunks[0].endChar = split
  input.chunks[0].text = SOURCE.slice(0, split)
  input.chunks[1].startChar = split
  input.chunks[1].text = SOURCE.slice(split)
  const bad = tool.auditChunks(input)
  assert.ok(ids(bad).includes('boundary-splits-heading'))
  assert.equal(bad.status, 'fail')
})

test('a hash line inside a fenced code block is not a heading', () => {
  for (const fence of ['```js\n# not a heading\n```\n', '~~~js\n# not a heading\n~~~\n']) {
    const hash = createHash('sha256').update(fence).digest('hex')
    const split = fence.indexOf('heading') + 3
    const input = { schemaVersion: '1', sources: [{ id: 'code', text: fence }], chunks: [
      { id: 'code-1', sourceId: 'code', sourceHash: hash, startChar: 0, endChar: split,
        startToken: 0, endToken: 1, tokenCount: 1, text: fence.slice(0, split) },
    ] }
    const report = tool.auditChunks(input)
    assert.equal(report.status, 'pass')
    assert.deepEqual(ids(report), [])
  }
})

test('up to three leading spaces still form an ATX heading; four spaces do not', () => {
  for (const spaces of [1, 2, 3, 4]) {
    const source = `${' '.repeat(spaces)}# Real heading\n`
    const hash = createHash('sha256').update(source).digest('hex')
    const split = source.indexOf('heading') + 3
    const input = { schemaVersion: '1', sources: [{ id: 'guide', text: source }], chunks: [
      { id: 'guide-1', sourceId: 'guide', sourceHash: hash, startChar: 0, endChar: split,
        startToken: 0, endToken: 1, tokenCount: 1, text: source.slice(0, split) },
    ] }
    const report = tool.auditChunks(input)
    assert.equal(report.status, spaces === 4 ? 'pass' : 'fail')
    assert.deepEqual(ids(report), spaces === 4 ? [] : ['boundary-splits-heading'])
  }
})

test('maxTokens is silent at N and reports N+1', () => {
  const input = document()
  assert.equal(tool.auditChunks(input, { limits: { maxTokens: 4 } }).status, 'pass')
  input.chunks[0].endToken = 5
  input.chunks[0].tokenCount = 5
  input.chunks[1].startToken = 5
  input.chunks[1].endToken = 9
  const over = tool.auditChunks(input, { limits: { maxTokens: 4 } })
  assert.ok(ids(over).includes('chunk-too-large'))
  assert.equal(over.status, 'fail')
})

test('maxOverlapTokens is silent at N and reports N+1', () => {
  const input = document()
  input.chunks[1].startToken = 2
  input.chunks[1].endToken = 6
  const at = tool.auditChunks(input, { limits: { maxOverlapTokens: 2 } })
  assert.equal(at.status, 'pass')
  assert.ok(!ids(at).includes('excessive-overlap'))
  const over = tool.auditChunks(input, { limits: { maxOverlapTokens: 1 } })
  assert.equal(over.status, 'fail')
  assert.ok(ids(over).includes('excessive-overlap'))
})

test('one absent token count alone is incomplete, not a zero-token pass', () => {
  const input = document()
  delete input.chunks[0].tokenCount
  const report = tool.auditChunks(input)
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(ids(report), ['token-count-missing'])
  assert.equal(report.findings[0].severity, 'error')
})

test('an orphan alone is incomplete and located by chunk id', () => {
  const input = document()
  input.chunks[0].sourceId = 'absent'
  const report = tool.auditChunks(input)
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(ids(report), ['orphan-chunk'])
  assert.equal(report.findings[0].subject, 'a')
})

test('a stale source hash and an unknowable count make the run incomplete, not a zero-sized pass', () => {
  const input = document()
  input.chunks[0].sourceHash = '0'.repeat(64)
  delete input.chunks[1].tokenCount
  const report = tool.auditChunks(input)
  assert.equal(report.status, 'incomplete')
  assert.ok(ids(report).includes('stale-source-hash'))
  assert.ok(ids(report).includes('token-count-missing'))
  assert.ok(!ids(report).includes('chunk-too-large'))
})

test('a malformed source hash object cannot crash the reporter while rendering', () => {
  const input = document()
  input.chunks[0].sourceHash = { toString: {} }
  const report = tool.auditChunks(input)
  assert.equal(report.status, 'incomplete')
  assert.ok(ids(report).includes('chunk-provenance-missing'))
})

test('an inconsistent token span cannot create an overlap finding from unreliable offsets', () => {
  const input = document()
  input.chunks[0].endToken = 100
  const report = tool.auditChunks(input, { limits: { maxOverlapTokens: 1 } })
  assert.equal(report.status, 'incomplete')
  assert.ok(ids(report).includes('token-span-invalid'))
  assert.ok(!ids(report).includes('excessive-overlap'))
  assert.equal(report.summary.checked, 1)
})

test('same text at different spans is located as a candidate, not asserted to be an export duplicate', () => {
  const text = 'Repeat.\nRepeat.\n'
  const hash = createHash('sha256').update(text).digest('hex')
  const input = { schemaVersion: '1', sources: [{ id: 'repeated', text }], chunks: [
    { id: 'first', sourceId: 'repeated', sourceHash: hash, startChar: 0, endChar: 8,
      startToken: 0, endToken: 2, tokenCount: 2, text: 'Repeat.\n' },
    { id: 'second', sourceId: 'repeated', sourceHash: hash, startChar: 8, endChar: 16,
      startToken: 2, endToken: 4, tokenCount: 2, text: 'Repeat.\n' },
  ] }
  const report = tool.auditChunks(input)
  assert.equal(report.status, 'pass')
  assert.deepEqual(ids(report), ['repeated-content'])
  assert.equal(report.findings[0].severity, 'info')
})

test('a holed source index cannot positively classify any chunk as orphan or current', () => {
  const input = document()
  input.sources.push({ id: 'broken', text: null })
  input.chunks[0].sourceHash = '0'.repeat(64)
  input.chunks[1].sourceId = 'missing'
  const report = tool.auditChunks(input)
  assert.equal(report.status, 'incomplete')
  assert.ok(ids(report).includes('source-index-incomplete'))
  assert.ok(!ids(report).includes('orphan-chunk'))
  assert.ok(!ids(report).includes('stale-source-hash'))
})

test('finding order is code-unit order of chunk ids, not input or locale order', () => {
  const input = document()
  input.chunks = [
    { ...input.chunks[0], id: 'a', sourceId: 'missing' },
    { ...input.chunks[1], id: 'Z', sourceId: 'missing' },
  ]
  const report = tool.auditChunks(input)
  assert.deepEqual(report.findings.map((finding) => finding.subject), ['Z', 'a'])
})

test('maxRecords is silent at N and incomplete at N+1', () => {
  const input = document()
  assert.equal(tool.auditChunks(input, { limits: { maxRecords: 3 } }).status, 'pass')
  const over = tool.auditChunks(input, { limits: { maxRecords: 2 } })
  assert.equal(over.status, 'incomplete')
  assert.deepEqual(ids(over), ['record-limit'])
})

test('maxFindings is silent at N and adds an incomplete sentinel at N+1', () => {
  const input = document()
  input.chunks[0].tokenCount = 5
  input.chunks[0].endToken = 5
  input.chunks[1].startToken = 5
  input.chunks[1].endToken = 10
  input.chunks[1].tokenCount = 5
  const at = tool.auditChunks(input, { limits: { maxTokens: 4, maxFindings: 2 } })
  assert.equal(at.status, 'fail')
  assert.deepEqual(ids(at), ['chunk-too-large', 'chunk-too-large'])
  const over = tool.auditChunks(input, { limits: { maxTokens: 4, maxFindings: 1 } })
  assert.equal(over.status, 'incomplete')
  assert.ok(ids(over).includes('findings-truncated'))
  assert.equal(over.findings.length, 2)
})

test('maxDepth is silent at N and incomplete at N+1', () => {
  const input = document()
  // Root object, chunks array, chunk object: three nested containers. Scalar
  // fields are not another level of JSON nesting.
  assert.equal(tool.auditChunks(input, { limits: { maxDepth: 3 } }).status, 'pass')
  const over = tool.auditChunks(input, { limits: { maxDepth: 2 } })
  assert.equal(over.status, 'incomplete')
  assert.deepEqual(ids(over), ['depth-limit'])
})

test('reusing an in-memory object is not a JSON cycle or an input defect', () => {
  const input = document()
  const repeated = { note: 'shared but serializable' }
  input.metadata = { first: repeated, second: repeated }
  assert.equal(tool.auditChunks(input).status, 'pass')
  input.metadata.loop = input.metadata
  assert.deepEqual(ids(tool.auditChunks(input)), ['input-invalid'])
})

test('invalid configuration is rejected; a missing source document is incomplete', () => {
  assert.throws(() => tool.auditChunks(document(), { limits: { maxToken: 4 } }), /Unknown limit/)
  assert.throws(() => tool.auditChunks(document(), { limits: { maxTokens: 0 } }), /maxTokens/)
  assert.equal(tool.validateLimits({ timeoutMs: 3600000 }).timeoutMs, 3600000)
  assert.throws(() => tool.validateLimits({ timeoutMs: 3600001 }), /timeoutMs/)
  const report = tool.auditChunks({ schemaVersion: '1', sources: [], chunks: [] })
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(ids(report), ['no-chunks'])
})

test('the injected clock accepts exactly N and reports a deadline at N+1', () => {
  let calls = 0
  const at = tool.auditChunks(document(), { limits: { timeoutMs: 5 }, now: () => calls++ === 0 ? 100 : 105 })
  assert.equal(at.status, 'pass')
  calls = 0
  const over = tool.auditChunks(document(), { limits: { timeoutMs: 5 }, now: () => calls++ === 0 ? 100 : 106 })
  assert.equal(over.status, 'incomplete')
  assert.deepEqual(ids(over), ['analysis-timeout'])
  assert.equal(over.summary.checked, 0)
})

test('rule severity cannot be changed at runtime to turn a known failure into a pass', () => {
  assert.throws(() => { tool.RULES['chunk-too-large'].severity = 'info' }, TypeError)
  const input = document()
  input.chunks[0].tokenCount = 5
  input.chunks[0].endToken = 5
  input.chunks[1].startToken = 5
  input.chunks[1].endToken = 9
  assert.equal(tool.auditChunks(input, { limits: { maxTokens: 4 } }).status, 'fail')
})
