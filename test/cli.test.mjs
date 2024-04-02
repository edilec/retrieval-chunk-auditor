import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import test from 'node:test'

const CLI = resolve(import.meta.dirname, '..', 'bin', 'retrieval-chunk-auditor.mjs')
const TEXT = '# One\nAlpha.\n'
const HASH = createHash('sha256').update(TEXT).digest('hex')
const INPUT = {
  schemaVersion: '1', sources: [{ id: 'one', text: TEXT }],
  chunks: [{ id: 'one-1', sourceId: 'one', sourceHash: HASH, startChar: 0,
    endChar: TEXT.length, startToken: 0, endToken: 3, tokenCount: 3, text: TEXT }],
}

async function fixture(t, value = INPUT) {
  const root = await mkdtemp(join(tmpdir(), 'rca-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const file = join(root, 'chunks.json')
  const content = typeof value === 'string' ? value : `${JSON.stringify(value)}\n`
  await writeFile(file, content)
  return { file, bytes: Buffer.byteLength(content) }
}

function run(args) {
  return new Promise((done) => execFile(process.execPath, [CLI, ...args], { maxBuffer: 1024 * 1024 },
    (error, stdout, stderr) => done({ code: error === null ? 0 : error.code ?? 1, stdout, stderr })))
}

test('CLI reports a good local export as JSON and leaves stderr empty with --json', async (t) => {
  const { file } = await fixture(t)
  const result = await run(['--input', file, '--json'])
  assert.equal(result.code, 0)
  assert.equal(result.stderr, '')
  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.checked, 1)
  assert.deepEqual(report.findings, [])
})

test('configuration errors have empty stdout; missing input has an incomplete report', async (t) => {
  const { file } = await fixture(t)
  const invalid = await run(['--input', file, '--max-token', '4', '--json'])
  assert.equal(invalid.code, 2)
  assert.equal(invalid.stdout, '')
  assert.match(invalid.stderr, /Unknown option/)

  const missing = await run(['--input', join(resolve(file, '..'), 'missing.json'), '--json'])
  assert.equal(missing.code, 2)
  const report = JSON.parse(missing.stdout)
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['input-unreadable'])
  assert.equal(report.findings[0].location.file, 'missing.json')
})

test('invalid JSON cannot echo a synthetic secret from a parser error', async (t) => {
  const { file } = await fixture(t, '{"token": AKIAIOSFODNN7EXAMPLE}')
  const result = await run(['--input', file, '--json'])
  assert.equal(result.code, 2)
  assert.equal(JSON.parse(result.stdout).findings[0].ruleId, 'input-invalid')
  assert.ok(!result.stdout.includes('AKIAIOSFODNN7EXAMPLE'))
  assert.ok(!result.stderr.includes('AKIAIOSFODNN7EXAMPLE'))
})

test('maxBytes accepts exactly N and refuses N+1 without reading', async (t) => {
  const { file, bytes } = await fixture(t)
  const at = await run(['--input', file, '--max-bytes', String(bytes), '--json'])
  assert.equal(at.code, 0)
  const over = await run(['--input', file, '--max-bytes', String(bytes - 1), '--json'])
  assert.equal(over.code, 2)
  assert.deepEqual(JSON.parse(over.stdout).findings.map((finding) => finding.ruleId), ['input-too-large'])
})

test('the reported file is a basename even when the input path is absolute', async (t) => {
  const { file } = await fixture(t, '{')
  const result = await run(['--input', file, '--json'])
  assert.equal(result.code, 2)
  assert.equal(JSON.parse(result.stdout).findings[0].location.file, basename(file))
})

test('duplicate JSON keys cannot erase earlier provenance evidence', async (t) => {
  const ordinary = JSON.stringify(INPUT)
  const duplicate = ordinary.replace('"sourceHash":"', '"sourceHash":null,"sourceHash":"')
  assert.notEqual(duplicate, ordinary)
  const { file } = await fixture(t, duplicate)
  const result = await run(['--input', file, '--json'])
  assert.equal(result.code, 2)
  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['input-invalid'])
})

test('escaped JSON key spellings are compared after decoding', async (t) => {
  const ordinary = JSON.stringify(INPUT)
  const duplicate = ordinary.replace('"sourceHash":"', '"source\\u0048ash":null,"sourceHash":"')
  assert.notEqual(duplicate, ordinary)
  const { file } = await fixture(t, duplicate)
  const result = await run(['--input', file, '--json'])
  assert.equal(result.code, 2)
  assert.deepEqual(JSON.parse(result.stdout).findings.map((finding) => finding.ruleId), ['input-invalid'])
})

test('duplicate root keys are refused even when the final schema version is valid', async (t) => {
  const ordinary = JSON.stringify(INPUT)
  const duplicate = ordinary.replace('"schemaVersion":"1"', '"schemaVersion":"0","schemaVersion":"1"')
  assert.notEqual(duplicate, ordinary)
  const { file } = await fixture(t, duplicate)
  const result = await run(['--input', file, '--json'])
  assert.equal(result.code, 2)
  assert.deepEqual(JSON.parse(result.stdout).findings.map((finding) => finding.ruleId), ['input-invalid'])
})

test('the same key in separate objects and key-like text inside a string stay valid', async (t) => {
  const text = '{"sourceHash":null,"sourceHash":"x"}\n'
  const hash = createHash('sha256').update(text).digest('hex')
  const input = { schemaVersion: '1', sources: [{ id: 'one', text }], chunks: [
    { id: 'one-1', sourceId: 'one', sourceHash: hash, startChar: 0, endChar: text.length,
      startToken: 0, endToken: 3, tokenCount: 3, text },
  ] }
  const { file } = await fixture(t, input)
  const result = await run(['--input', file, '--json'])
  assert.equal(result.code, 0)
  assert.equal(JSON.parse(result.stdout).status, 'pass')
})
