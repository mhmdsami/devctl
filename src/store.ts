import fs from 'fs'
import os from 'os'
import path from 'path'
import { quiet } from './util'

export const DEVCTL_DIR = process.env.DEVCTL_DIR ?? path.join(os.homedir(), '.devctl')
export const STATE_FILE = path.join(DEVCTL_DIR, 'state.jsonl')
export const LEGACY_STATE_FILE = path.join(DEVCTL_DIR, 'state.json')

const warnings: string[] = []
let reported = false

export function storeWarn(message: string): void {
  warnings.push(message)
}

export function storeWarnings(): string[] {
  return [...warnings]
}

let warned = false

export function reportStoreWarnings(): void {
  if (warned || quiet()) return
  warned = true
  for (const message of warnings) console.error(`devctl: warning: ${message}`)
}

let quarantined = false

function quarantine(): void {
  if (quarantined) return
  quarantined = true
  try {
    fs.copyFileSync(STATE_FILE, `${STATE_FILE}.corrupt-${Date.now()}`)
  } catch {}
}

export function readRecords(): unknown[] {
  if (!fs.existsSync(STATE_FILE)) return []
  const raw = fs.readFileSync(STATE_FILE, 'utf8')
  const lines = raw.split('\n')
  const records: unknown[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      records.push(JSON.parse(line) as unknown)
    } catch {
      const torn = lines.slice(i + 1).every((rest) => !rest.trim())
      if (torn) {
        storeWarn(`dropped a partial final record in ${STATE_FILE} (interrupted write)`)
      } else {
        quarantine()
        storeWarn(`recovered ${STATE_FILE} up to line ${i}, quarantined the rest`)
      }
      rewriteRecords(records)
      break
    }
  }
  return records
}

export function appendRecords(records: unknown[]): void {
  if (records.length === 0) return
  fs.mkdirSync(DEVCTL_DIR, { recursive: true })
  const body = records.map((record) => JSON.stringify(record)).join('\n') + '\n'
  const fd = fs.openSync(STATE_FILE, 'a')
  try {
    fs.writeSync(fd, body)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

export function rewriteRecords(records: unknown[]): void {
  fs.mkdirSync(DEVCTL_DIR, { recursive: true })
  const body = records.length === 0 ? '' : records.map((record) => JSON.stringify(record)).join('\n') + '\n'
  const tmp = `${STATE_FILE}.${process.pid}.tmp`
  fs.writeFileSync(tmp, body)
  fs.renameSync(tmp, STATE_FILE)
}

export function migrateLegacyState(): void {
  if (fs.existsSync(STATE_FILE) || !fs.existsSync(LEGACY_STATE_FILE)) return
  try {
    const raw = fs.readFileSync(LEGACY_STATE_FILE, 'utf8')
    rewriteRecords([{ op: 'snapshot', val: JSON.parse(raw) as unknown }])
    fs.renameSync(LEGACY_STATE_FILE, `${LEGACY_STATE_FILE}.bak`)
    storeWarn(`imported ${LEGACY_STATE_FILE} into ${STATE_FILE} (previous file kept as .bak)`)
  } catch {
    const target = `${LEGACY_STATE_FILE}.corrupt-${Date.now()}`
    try {
      fs.renameSync(LEGACY_STATE_FILE, target)
    } catch {}
    storeWarn(`could not read ${LEGACY_STATE_FILE}; moved it to ${target} and started empty`)
  }
}
