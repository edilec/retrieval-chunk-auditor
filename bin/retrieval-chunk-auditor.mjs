#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { auditChunks, exitCodeFor, oneFinding, renderReport, validateLimits } from '../src/index.mjs'

const HELP = `retrieval-chunk-auditor
Audit one local JSON export of sources and retrieval chunks. No embeddings, models,
network calls or file writes are used.

Usage: retrieval-chunk-auditor --input FILE [--json] [limits]
  --input FILE             Local JSON export (required)
  --json                   Suppress the human summary on stderr
  --max-bytes N            Input bytes (default 4194304)
  --max-records N          Sources plus chunks (default 5000)
  --max-depth N            JSON nesting depth (default 32)
  --max-tokens N           Tokens per chunk (default 800)
  --max-overlap-tokens N   Adjacent token overlap (default 64; zero allowed)
  --max-findings N         Findings retained (default 1000)
  --timeout-ms N           Cooperative analysis deadline (default 30000; max 3600000)
  -h, --help               Show this help

Exit: 0 complete and clean; 1 complete with findings; 2 invalid usage (empty
stdout) or missing/invalid/limited evidence (incomplete JSON report).
`

const FLAGS = new Map([
  ['--max-bytes', 'maxBytes'], ['--max-records', 'maxRecords'],
  ['--max-depth', 'maxDepth'], ['--max-tokens', 'maxTokens'],
  ['--max-overlap-tokens', 'maxOverlapTokens'], ['--max-findings', 'maxFindings'],
  ['--timeout-ms', 'timeoutMs'],
])

function argumentsFor(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true }
  const options = { input: null, json: false, limits: {} }
  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at]
    if (arg === '--json') { options.json = true; continue }
    if (arg !== '--input' && !FLAGS.has(arg)) throw new Error(`Unknown option "${arg}"`)
    const value = argv[++at]
    if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value`)
    if (arg === '--input') { options.input = value; continue }
    if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value))) {
      throw new Error(`${arg} requires an integer`)
    }
    options.limits[FLAGS.get(arg)] = Number(value)
  }
  if (options.input === null) throw new Error('--input is required')
  validateLimits(options.limits)
  return options
}

async function main(argv) {
  let options
  try { options = argumentsFor(argv) }
  catch (error) { process.stderr.write(`${error.message}\n`); return 2 }
  if (options.help) { process.stderr.write(HELP); return 0 }
  const file = basename(options.input)
  let report
  try {
    const info = await stat(options.input)
    if (!info.isFile()) throw new Error('not a regular file')
    const limits = validateLimits(options.limits)
    if (info.size > limits.maxBytes) {
      report = oneFinding('input-too-large', `Input exceeds the limit of ${limits.maxBytes} bytes.`, file)
    } else {
      const bytes = await readFile(options.input)
      if (bytes.length > limits.maxBytes) report = oneFinding('input-too-large', `Input exceeds the limit of ${limits.maxBytes} bytes.`, file)
      else {
        let document
        try { document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
        catch { report = oneFinding('input-invalid', 'Input could not be decoded as UTF-8 JSON.', file) }
        if (report === undefined) report = auditChunks(document, { limits: options.limits, file })
      }
    }
  } catch {
    report = oneFinding('input-unreadable', 'Input could not be read as a regular file.', file)
  }
  process.stdout.write(renderReport(report))
  if (!options.json) process.stderr.write(`${report.tool}: status ${report.status}; ${report.summary.checked} chunk(s) checked.\n`)
  return exitCodeFor(report)
}

process.exitCode = await main(process.argv.slice(2))
