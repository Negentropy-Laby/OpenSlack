import { createContext, Script } from 'node:vm'
import type { AnthropicCompatSandbox } from './anthropic-compat.js'

/**
 * Find and remove the `export const meta = { ... }` declaration from source.
 *
 * Strategy: locate via regex, then walk forward to find the balanced closing brace.
 * Returns the source with the meta export removed.
 */
export function stripMetaExport(source: string): string {
  // Match the start of the export: `export const meta = {` or `export const meta: Type = {`
  const startPattern = /\bexport\s+const\s+meta\s*(?::\s*[^=]+)?\s*=\s*\{/
  const startMatch = startPattern.exec(source)
  if (!startMatch) return source

  const braceStart = source.indexOf('{', startMatch.index)
  if (braceStart === -1) return source

  let depth = 0
  let i = braceStart
  for (; i < source.length; i++) {
    const ch = source[i]
    if (ch === '{') {
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0) {
        // Found the balanced closing brace
        const end = i + 1
        // Also consume a trailing semicolon if present
        let sliceEnd = end
        if (end < source.length && source[end] === ';') {
          sliceEnd = end + 1
        }
        // Also consume a trailing newline
        if (sliceEnd < source.length && source[sliceEnd] === '\n') {
          sliceEnd++
        }
        return source.slice(0, startMatch.index) + source.slice(sliceEnd)
      }
    }
  }

  // Unbalanced braces — return source unchanged
  return source
}

/**
 * Create a secure sandbox context object for ambient DSL execution.
 *
 * ALLOWED globals: safe, deterministic JavaScript built-ins.
 * BLOCKED: Date.now(), argless new Date(), Math.random, require, process,
 *          global, globalThis, Buffer, __filename, __dirname.
 *
 * The `dslGlobals` parameter supplies the workflow-specific ambient globals
 * (agent, phase, log, budget, parallel, pipeline, workflow, args).
 */
export function createSecureSandbox(
  dslGlobals: Record<string, unknown>,
): Record<string, unknown> {
  const sandbox: Record<string, unknown> = {}

  // --- Allowed safe globals ---
  sandbox.Object = Object
  sandbox.Array = Array
  sandbox.Function = Function
  sandbox.Number = Number
  sandbox.String = String
  sandbox.Boolean = Boolean
  sandbox.Symbol = Symbol
  sandbox.Map = Map
  sandbox.Set = Set
  sandbox.WeakMap = WeakMap
  sandbox.WeakSet = WeakSet
  sandbox.Promise = Promise
  sandbox.RegExp = RegExp
  sandbox.Error = Error
  sandbox.TypeError = TypeError
  sandbox.RangeError = RangeError
  sandbox.JSON = JSON
  sandbox.parseInt = parseInt
  sandbox.parseFloat = parseFloat
  sandbox.isNaN = isNaN
  sandbox.isFinite = isFinite
  sandbox.decodeURI = decodeURI
  sandbox.encodeURI = encodeURI
  sandbox.decodeURIComponent = decodeURIComponent
  sandbox.encodeURIComponent = encodeURIComponent
  sandbox.undefined = undefined
  sandbox.NaN = NaN
  sandbox.Infinity = Infinity

  // Math WITHOUT Math.random
  const safeMath: Record<string, unknown> = {}
  for (const key of Object.getOwnPropertyNames(Math)) {
    if (key === 'random') continue
    safeMath[key] = (Math as unknown as Record<string, unknown>)[key]
  }
  sandbox.Math = safeMath

  // Date that blocks Date.now() and argless new Date()
  const OriginalDate = Date
  function SafeDate(this: unknown, ...args: unknown[]): unknown {
    // argless new Date() must throw
    if (args.length === 0) {
      throw new Error('Date() without arguments is forbidden in sandbox')
    }
    // Forward to real Date constructor
    return new (OriginalDate as unknown as new (...a: unknown[]) => Date)(...args)
  }
  SafeDate.prototype = OriginalDate.prototype
  SafeDate.now = () => {
    throw new Error('Date.now() is forbidden in sandbox')
  }
  SafeDate.parse = OriginalDate.parse
  SafeDate.UTC = OriginalDate.UTC
  sandbox.Date = SafeDate

  // console mapped to dslGlobals.log
  const logFn = (typeof dslGlobals.log === 'function')
    ? (dslGlobals.log as (msg: string) => void)
    : ((_msg: string) => {})
  sandbox.console = {
    log: logFn,
    warn: logFn,
    error: logFn,
  }

  // --- DSL globals (injected by caller) ---
  for (const [key, value] of Object.entries(dslGlobals)) {
    sandbox[key] = value
  }

  // --- Explicitly blocked (set to undefined for defense in depth) ---
  sandbox.require = undefined
  sandbox.process = undefined
  sandbox.global = undefined
  sandbox.globalThis = undefined
  sandbox.Buffer = undefined
  sandbox.__filename = undefined
  sandbox.__dirname = undefined
  sandbox.eval = undefined
  sandbox.Function = undefined // Revoke dynamic function creation in sandbox

  return sandbox
}

/**
 * Options for executeAmbientScript.
 */
export interface AmbientExecutionOptions {
  /** Execution timeout in milliseconds. Default: 120000 */
  timeout?: number
}

/**
 * Execute a Claude ambient DSL workflow script in a sandboxed VM context.
 *
 * 1. Strips the `export const meta = { ... }` from sourceBody.
 * 2. Creates a secure sandbox with createSecureSandbox(dslGlobals).
 * 3. Wraps body in an async IIFE and runs it in a Node.js VM context.
 * 4. Returns the result of the async execution.
 *
 * The sandbox provides safe JS built-ins plus the workflow-specific DSL globals
 * (agent, phase, log, budget, parallel, pipeline, workflow, args, etc.).
 */
export async function executeAmbientScript(
  sourceBody: string,
  dslGlobals: Record<string, unknown>,
  options?: AmbientExecutionOptions,
): Promise<unknown> {
  const timeout = options?.timeout ?? 120_000

  // 1. Strip meta export
  const cleanSource = stripMetaExport(sourceBody)

  // 2. Create secure sandbox
  const sandbox = createSecureSandbox(dslGlobals)

  // 3. Create VM context
  const context = createContext(sandbox)

  // 4. Wrap in async IIFE
  const wrappedSource = `(async () => {\n${cleanSource}\n})()`

  // 5. Compile and run
  const script = new Script(wrappedSource, {
    filename: 'ambient-workflow.js',
  })

  const resultPromise = script.runInContext(context, {
    timeout,
  })

  // 6. Await the result
  return resultPromise
}
