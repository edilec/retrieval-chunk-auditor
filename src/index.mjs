import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'

export const TOOL_ID = 'retrieval-chunk-auditor'
export const DEFAULT_LIMITS = Object.freeze({
  maxBytes: 4194304,
  maxRecords: 5000,
  maxDepth: 32,
  maxTokens: 800,
  maxOverlapTokens: 64,
  maxFindings: 1000,
  timeoutMs: 30000,
})

export const RULES = Object.freeze({
  'input-unreadable': { severity: 'error', incomplete: true },
  'input-invalid': { severity: 'error', incomplete: true },
  'input-too-large': { severity: 'error', incomplete: true },
  'depth-limit': { severity: 'error', incomplete: true },
  'record-limit': { severity: 'error', incomplete: true },
  'findings-truncated': { severity: 'error', incomplete: true },
  'analysis-timeout': { severity: 'error', incomplete: true },
  'no-chunks': { severity: 'error', incomplete: true },
  'source-invalid': { severity: 'error', incomplete: true },
  'source-duplicate': { severity: 'error', incomplete: true },
  'source-index-incomplete': { severity: 'error', incomplete: true },
  'chunk-invalid': { severity: 'error', incomplete: true },
  'chunk-id-duplicate': { severity: 'error', incomplete: true },
  'chunk-provenance-missing': { severity: 'error', incomplete: true },
  'token-count-missing': { severity: 'error', incomplete: true },
  'token-span-invalid': { severity: 'error', incomplete: true },
  'orphan-chunk': { severity: 'error', incomplete: true },
  'stale-source-hash': { severity: 'error', incomplete: true },
  'chunk-text-mismatch': { severity: 'error', incomplete: true },
  'duplicate-source-span': { severity: 'error', incomplete: false },
  'repeated-content': { severity: 'info', incomplete: false },
  'chunk-too-large': { severity: 'error', incomplete: false },
  'excessive-overlap': { severity: 'error', incomplete: false },
  'boundary-splits-heading': { severity: 'error', incomplete: false },
})

export class ConfigError extends Error {
  constructor(message) { super(message); this.name = 'ConfigError' }
}

class DeadlineError extends Error {}

const byCodeUnit = (a, b) => a === b ? 0 : a < b ? -1 : 1
const identifier = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
const natural = (value) => Number.isSafeInteger(value) && value >= 0
const positive = (value) => Number.isSafeInteger(value) && value > 0
const hashOf = (text) => createHash('sha256').update(text, 'utf8').digest('hex')
const safe = (value) => String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, 160)

export function validateLimits(overrides = {}) {
  if (overrides === null || Array.isArray(overrides) || typeof overrides !== 'object') {
    throw new ConfigError('limits must be an object')
  }
  const limits = { ...DEFAULT_LIMITS }
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, key)) throw new ConfigError(`Unknown limit "${key}"`)
    if (!(key === 'maxOverlapTokens' ? natural(value) : positive(value))) {
      throw new ConfigError(`${key} must be ${key === 'maxOverlapTokens' ? 'a non-negative' : 'a positive'} integer`)
    }
    if (key === 'timeoutMs' && value > 3600000) throw new ConfigError('timeoutMs must be at most 3600000')
    limits[key] = value
  }
  return Object.freeze(limits)
}

export function makeReport(findings, checked, file = 'input.json') {
  const sorted = [...findings].sort((a, b) => byCodeUnit(a.subject ?? '', b.subject ?? '')
    || byCodeUnit(a.location.pointer ?? '', b.location.pointer ?? '') || byCodeUnit(a.ruleId, b.ruleId))
  const errors = sorted.filter((finding) => finding.severity === 'error').length
  const warnings = sorted.filter((finding) => finding.severity === 'warning').length
  const info = sorted.filter((finding) => finding.severity === 'info').length
  const incomplete = sorted.some((finding) => RULES[finding.ruleId]?.incomplete)
  return {
    schemaVersion: '1', tool: TOOL_ID,
    status: incomplete ? 'incomplete' : errors > 0 ? 'fail' : 'pass',
    summary: { checked, errors, warnings, info }, findings: sorted,
  }
}

export function oneFinding(ruleId, message, file = 'input.json') {
  return makeReport([finding(ruleId, message, file)], 0, file)
}

function finding(ruleId, message, file, pointer = '', subject = '') {
  const rule = RULES[ruleId]
  if (rule === undefined) throw new TypeError(`Unknown ruleId "${ruleId}"`)
  return {
    ruleId, severity: rule.severity, message: safe(message),
    location: { file: safe(file) || 'input.json', ...(pointer ? { pointer } : {}) },
    ...(subject ? { subject: safe(subject) } : {}),
  }
}

function depthProblem(value, maxDepth, checkpoint) {
  const pending = [{ value, depth: 1, leave: false }]
  const active = new Set()
  while (pending.length) {
    checkpoint()
    const item = pending.pop()
    if (item.value === null || typeof item.value !== 'object') continue
    if (item.leave) { active.delete(item.value); continue }
    if (item.depth > maxDepth) return 'depth-limit'
    if (active.has(item.value)) return 'input-invalid'
    active.add(item.value)
    pending.push({ ...item, leave: true })
    let children
    try { children = Object.values(item.value) }
    catch { return 'input-invalid' }
    for (const child of children) pending.push({ value: child, depth: item.depth + 1, leave: false })
  }
  return null
}

function headingRanges(text) {
  const ranges = []
  let start = 0
  while (start < text.length) {
    const newline = text.indexOf('\n', start)
    const end = newline === -1 ? text.length : newline
    if (/^#{1,6}[ \t]+/.test(text.slice(start, end))) ranges.push({ start, end })
    if (newline === -1) break
    start = newline + 1
  }
  return ranges
}

export function auditChunks(document, { limits: overrides, now = () => performance.now(), file = 'input.json' } = {}) {
  const limits = validateLimits(overrides)
  if (typeof file !== 'string') throw new ConfigError('file must be a string')
  if (typeof now !== 'function') throw new ConfigError('now must be a clock function')
  const started = now()
  if (!Number.isFinite(started)) throw new ConfigError('now must return a finite number')
  const checkpoint = () => {
    const current = now()
    if (!Number.isFinite(current)) throw new ConfigError('now must return a finite number')
    if (current - started > limits.timeoutMs) throw new DeadlineError()
  }
  const findings = []
  let truncated = false
  let checked = 0
  const add = (ruleId, message, pointer = '', subject = '') => {
    if (findings.length >= limits.maxFindings) { truncated = true; return }
    findings.push(finding(ruleId, message, file, pointer, subject))
  }
  const finish = () => {
    if (truncated) findings.push(finding('findings-truncated', `More than ${limits.maxFindings} findings were present; later findings were not reported.`, file))
    return makeReport(findings, checked, file)
  }
  try {
    checkpoint()
    const depth = depthProblem(document, limits.maxDepth, checkpoint)
    if (depth !== null) { add(depth, depth === 'depth-limit' ? `Input exceeds depth limit ${limits.maxDepth}.` : 'Input contains a repeated object reference.'); return finish() }
    if (document === null || typeof document !== 'object' || Array.isArray(document)
      || document.schemaVersion !== '1' || !Array.isArray(document.sources) || !Array.isArray(document.chunks)) {
      add('input-invalid', 'Input must be a version 1 object with sources and chunks arrays.')
      return finish()
    }
    if (document.sources.length + document.chunks.length > limits.maxRecords) {
      add('record-limit', `Input exceeds the limit of ${limits.maxRecords} source and chunk records.`)
      return finish()
    }
    if (document.chunks.length === 0) { add('no-chunks', 'No chunks were supplied; no retrieval export was audited.'); return finish() }

    const sources = new Map()
    let indexComplete = true
    for (const [at, source] of document.sources.entries()) {
      checkpoint()
      if (source === null || typeof source !== 'object' || Array.isArray(source)
        || !identifier(source.id) || typeof source.text !== 'string' || source.text.length === 0) {
        indexComplete = false
        add('source-invalid', 'Source id or text is unusable, so the source index is incomplete.', `/sources/${at}`)
        continue
      }
      if (sources.has(source.id)) {
        indexComplete = false
        add('source-duplicate', 'A source id is declared more than once, so its text is ambiguous.', `/sources/${at}`, source.id)
        continue
      }
      sources.set(source.id, { text: source.text, hash: hashOf(source.text), headings: headingRanges(source.text) })
    }

    const ids = new Set()
    const spans = new Map()
    const content = new Map()
    const ordered = new Map()
    for (const [at, chunk] of document.chunks.entries()) {
      checkpoint()
      const pointer = `/chunks/${at}`
      if (chunk === null || typeof chunk !== 'object' || Array.isArray(chunk) || !identifier(chunk.id)) {
        add('chunk-invalid', 'Chunk id is unusable; this chunk was not evaluated.', pointer)
        continue
      }
      const subject = chunk.id
      if (ids.has(subject)) add('chunk-id-duplicate', 'Chunk id occurs more than once.', pointer, subject)
      ids.add(subject)
      const hasProvenance = identifier(chunk.sourceId) && typeof chunk.sourceHash === 'string'
        && /^[0-9a-f]{64}$/.test(chunk.sourceHash)
        && natural(chunk.startChar) && natural(chunk.endChar) && chunk.endChar > chunk.startChar
        && typeof chunk.text === 'string' && chunk.text.length > 0
      if (!hasProvenance) add('chunk-provenance-missing', 'Source id, hash, character span or text is missing or unusable.', pointer, subject)
      const hasTokens = natural(chunk.startToken) && natural(chunk.endToken) && chunk.endToken > chunk.startToken
      if (!hasTokens) add('token-span-invalid', 'Token span is missing or unusable.', pointer, subject)
      if (!natural(chunk.tokenCount)) add('token-count-missing', 'Exported token count is unknown; it was not treated as zero.', pointer, subject)
      else if (chunk.tokenCount > limits.maxTokens) add('chunk-too-large', `Chunk has ${chunk.tokenCount} tokens, above the limit of ${limits.maxTokens}.`, pointer, subject)
      const tokenSpanConsistent = hasTokens && natural(chunk.tokenCount)
        && chunk.endToken - chunk.startToken === chunk.tokenCount
      if (hasTokens && natural(chunk.tokenCount) && !tokenSpanConsistent) {
        add('token-span-invalid', 'Exported token count disagrees with its token span.', pointer, subject)
      }
      if (!hasProvenance || !tokenSpanConsistent) continue
      checked += 1
      if (!indexComplete) {
        add('source-index-incomplete', 'The source index dropped an entry, so source membership and hash comparison are unknown.', pointer, subject)
        continue
      }
      const source = sources.get(chunk.sourceId)
      if (source === undefined) { add('orphan-chunk', 'Chunk names a source absent from the complete source index.', pointer, subject); continue }
      if (chunk.sourceHash !== source.hash) { add('stale-source-hash', 'Chunk source hash differs from the supplied source text.', pointer, subject); continue }
      if (chunk.endChar > source.text.length || source.text.slice(chunk.startChar, chunk.endChar) !== chunk.text) {
        add('chunk-text-mismatch', 'Chunk text does not match the declared span of its source.', pointer, subject)
        continue
      }
      const span = `${chunk.sourceId}\u0000${chunk.startChar}\u0000${chunk.endChar}`
      if (spans.has(span)) add('duplicate-source-span', 'Two chunks repeat the same source span.', pointer, subject)
      else {
        spans.set(span, subject)
        if (content.has(chunk.text)) add('repeated-content', 'Chunk text repeats at a different source span; review whether the repetition is intentional.', pointer, subject)
        else content.set(chunk.text, subject)
      }
      if (!ordered.has(chunk.sourceId)) ordered.set(chunk.sourceId, [])
      ordered.get(chunk.sourceId).push({ ...chunk, pointer })
      if (source.headings.some((heading) => heading.start < chunk.endChar && chunk.endChar < heading.end)) {
        add('boundary-splits-heading', 'Chunk ends inside a Markdown heading.', pointer, subject)
      }
    }
    for (const chunks of ordered.values()) {
      chunks.sort((a, b) => a.startToken - b.startToken || byCodeUnit(a.id, b.id))
      for (let at = 1; at < chunks.length; at += 1) {
        checkpoint()
        const overlap = chunks[at - 1].endToken - chunks[at].startToken
        if (overlap > limits.maxOverlapTokens) {
          add('excessive-overlap', `Adjacent chunks overlap by ${overlap} tokens, above the limit of ${limits.maxOverlapTokens}.`, chunks[at].pointer, chunks[at].id)
        }
      }
    }
    checkpoint()
    return finish()
  } catch (error) {
    if (!(error instanceof DeadlineError)) throw error
    return oneFinding('analysis-timeout', `Analysis exceeded the cooperative limit of ${limits.timeoutMs} milliseconds.`, file)
  }
}

export function exitCodeFor(report) { return report.status === 'incomplete' ? 2 : report.status === 'fail' ? 1 : 0 }
export function renderReport(report) { return `${JSON.stringify(report, null, 2)}\n` }
