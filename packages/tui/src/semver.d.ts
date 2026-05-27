declare module 'semver' {
  interface Options {
    loose?: boolean
    includePrerelease?: boolean
  }

  class SemVer {
    raw: string
    loose: boolean
    options: Options
    major: number
    minor: number
    patch: number
    version: string
  }

  function coerce(version: string | SemVer | null | undefined, options?: Options): SemVer | null
  function compare(a: string | SemVer, b: string | SemVer, options?: Options): 1 | 0 | -1
  function gt(a: string | SemVer, b: string | SemVer, options?: Options): boolean
  function gte(a: string | SemVer, b: string | SemVer, options?: Options): boolean
  function lt(a: string | SemVer, b: string | SemVer, options?: Options): boolean
  function lte(a: string | SemVer, b: string | SemVer, options?: Options): boolean
  function satisfies(version: string | SemVer, range: string | Range, options?: Options): boolean
}
