import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'

/**
 * Trust level for a workflow, controlling which permissions are available.
 */
export type WorkflowTrustLevel = 'untrusted' | 'trusted' | 'core'

/**
 * A single trust record persisted for a workflow.
 */
export interface TrustRecord {
  /** The trust level assigned to this workflow. */
  level: WorkflowTrustLevel
  /** ISO timestamp when the trust level was set. */
  setAt: string
  /** Identity that set the trust level (e.g., 'operator', 'cli:user@example'). */
  setBy: string
}

/**
 * On-disk format for the trust store YAML file.
 */
export interface TrustStoreData {
  trusts: Record<string, TrustRecord>
}

/**
 * Options for creating a TrustStore instance.
 */
export interface TrustStoreOptions {
  /** Base directory containing .openslack/ (defaults to cwd). */
  rootDir?: string
  /** Identity to use when setting trust levels. */
  identity?: string
}

const DEFAULT_IDENTITY = 'cli'

/**
 * Serialize TrustStoreData to a simple YAML string.
 * The format is straightforward enough that we don't need a YAML library.
 */
function serializeToYaml(data: TrustStoreData): string {
  const lines: string[] = ['trusts:']
  for (const [name, record] of Object.entries(data.trusts)) {
    lines.push(`  ${name}:`)
    lines.push(`    level: "${record.level}"`)
    lines.push(`    setAt: "${record.setAt}"`)
    lines.push(`    setBy: "${record.setBy}"`)
  }
  if (Object.keys(data.trusts).length === 0) {
    lines.push('  {}')
  }
  lines.push('')
  return lines.join('\n')
}

/**
 * Parse a simple YAML structure for trust store data.
 * Handles the specific format produced by serializeToYaml.
 */
function parseSimpleYaml(raw: string): TrustStoreData {
  const data: TrustStoreData = { trusts: {} }
  const lines = raw.split('\n')
  let currentName: string | null = null
  let currentRecord: Partial<TrustRecord> | null = null

  for (const rawLine of lines) {
    const line = rawLine.trimEnd()
    // Match workflow name line: "  workflow-name:"
    const nameMatch = line.match(/^  (\S+):$/)
    if (nameMatch && nameMatch[1] !== '{}') {
      // Save previous record
      if (currentName && currentRecord?.level && currentRecord?.setAt && currentRecord?.setBy) {
        data.trusts[currentName] = currentRecord as TrustRecord
      }
      currentName = nameMatch[1]
      currentRecord = {}
      continue
    }
    // Match field lines: "    level: "value""
    if (currentName && currentRecord) {
      const fieldMatch = line.match(/^    (\w+):\s*"(.*)"$/ )
      if (fieldMatch) {
        const [, field, value] = fieldMatch
        if (field === 'level') {
          currentRecord.level = value as WorkflowTrustLevel
        } else if (field === 'setAt') {
          currentRecord.setAt = value
        } else if (field === 'setBy') {
          currentRecord.setBy = value
        }
      }
    }
  }
  // Save last record
  if (currentName && currentRecord?.level && currentRecord?.setAt && currentRecord?.setBy) {
    data.trusts[currentName] = currentRecord as TrustRecord
  }
  return data
}

/**
 * TrustStore persists workflow trust levels to .openslack/workflow-trust.yaml.
 *
 * Trust levels control which permissions a workflow receives at runtime:
 * - untrusted: minimal read-only permissions
 * - trusted: standard permissions for user-authored workflows
 * - core: full permissions (reserved for builtin workflows)
 *
 * The store creates the .openslack/ directory if it does not exist and
 * handles missing files gracefully by returning 'untrusted' as the default.
 */
export class TrustStore {
  private readonly filePath: string
  private readonly identity: string
  private data: TrustStoreData | null = null

  constructor(options: TrustStoreOptions = {}) {
    const rootDir = options.rootDir ?? process.cwd()
    const openslackDir = join(rootDir, '.openslack')
    this.filePath = join(openslackDir, 'workflow-trust.yaml')
    this.identity = options.identity ?? DEFAULT_IDENTITY
  }

  /**
   * Load the trust store from disk. Called automatically by get/set if needed.
   * Handles missing files gracefully by returning an empty store.
   */
  load(): TrustStoreData {
    if (this.data) return this.data

    if (!existsSync(this.filePath)) {
      this.data = { trusts: {} }
      return this.data
    }

    try {
      const raw = readFileSync(this.filePath, 'utf-8')
      const parsed = parseSimpleYaml(raw)
      this.data = parsed
      return this.data
    } catch {
      // Corrupted or unreadable file: treat as empty
      this.data = { trusts: {} }
      return this.data
    }
  }

  /**
   * Get the trust level for a workflow. Returns 'untrusted' if no record exists.
   */
  get(workflowName: string): WorkflowTrustLevel {
    const data = this.load()
    const record = data.trusts[workflowName]
    if (!record) return 'untrusted'
    return record.level
  }

  /**
   * Set the trust level for a workflow and persist to disk.
   * Creates the .openslack/ directory if it does not exist.
   */
  set(workflowName: string, level: WorkflowTrustLevel): void {
    const data = this.load()
    data.trusts[workflowName] = {
      level,
      setAt: new Date().toISOString(),
      setBy: this.identity,
    }
    this.data = data
    this.save()
  }

  /**
   * Remove the trust record for a workflow.
   */
  remove(workflowName: string): boolean {
    const data = this.load()
    if (!(workflowName in data.trusts)) return false
    delete data.trusts[workflowName]
    this.data = data
    this.save()
    return true
  }

  /**
   * List all trust records.
   */
  list(): Record<string, TrustRecord> {
    const data = this.load()
    return { ...data.trusts }
  }

  /**
   * Persist the current state to disk.
   */
  save(): void {
    const data = this.data ?? this.load()

    // Ensure .openslack/ directory exists
    const dir = dirname(this.filePath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }

    const yaml = serializeToYaml(data)
    writeFileSync(this.filePath, yaml, 'utf-8')
  }
}
