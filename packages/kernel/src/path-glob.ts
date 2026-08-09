type PathGlobToken =
  | { readonly kind: 'literal'; readonly value: string }
  | { readonly kind: 'star' }
  | { readonly kind: 'globstar' }
  | { readonly kind: 'globstar-directories' };

export type PathGlobMatcher = (path: string) => boolean;

function tokenizePathGlob(pattern: string): readonly PathGlobToken[] {
  const tokens: PathGlobToken[] = [];
  for (let index = 0; index < pattern.length; ) {
    if (pattern[index] !== '*') {
      tokens.push({ kind: 'literal', value: pattern[index]! });
      index += 1;
      continue;
    }

    let end = index;
    while (pattern[end] === '*') end += 1;
    if (end - index === 1) {
      tokens.push({ kind: 'star' });
      index = end;
      continue;
    }

    if (pattern[end] === '/') {
      tokens.push({ kind: 'globstar-directories' });
      index = end + 1;
      continue;
    }

    tokens.push({ kind: 'globstar' });
    index = end;
  }
  return tokens;
}

function matchesCompiledPathGlob(tokens: readonly PathGlobToken[], path: string): boolean {
  type MatchState = {
    readonly tokenIndex: number;
    readonly pathIndex: number;
    readonly scanningDirectory: boolean;
  };
  const pending: MatchState[] = [{ tokenIndex: 0, pathIndex: 0, scanningDirectory: false }];
  const visited = new Set<string>();

  while (pending.length > 0) {
    const state = pending.pop()!;
    const key = `${state.tokenIndex}:${state.pathIndex}:${state.scanningDirectory ? 1 : 0}`;
    if (visited.has(key)) continue;
    visited.add(key);

    if (state.scanningDirectory) {
      if (state.pathIndex >= path.length) continue;
      if (path[state.pathIndex] === '/') {
        pending.push({
          tokenIndex: state.tokenIndex,
          pathIndex: state.pathIndex + 1,
          scanningDirectory: false,
        });
      } else {
        pending.push({ ...state, pathIndex: state.pathIndex + 1 });
      }
      continue;
    }

    const token = tokens[state.tokenIndex];
    if (!token) {
      if (state.pathIndex === path.length) return true;
      continue;
    }

    if (token.kind === 'literal') {
      if (path[state.pathIndex] === token.value) {
        pending.push({
          tokenIndex: state.tokenIndex + 1,
          pathIndex: state.pathIndex + 1,
          scanningDirectory: false,
        });
      }
      continue;
    }

    pending.push({
      tokenIndex: state.tokenIndex + 1,
      pathIndex: state.pathIndex,
      scanningDirectory: false,
    });
    if (token.kind === 'globstar-directories') {
      pending.push({ ...state, scanningDirectory: true });
    } else if (
      state.pathIndex < path.length &&
      (token.kind === 'globstar' || path[state.pathIndex] !== '/')
    ) {
      pending.push({ ...state, pathIndex: state.pathIndex + 1 });
    }
  }

  return false;
}

/** Compile once per operation; this intentionally keeps no process-global cache. */
export function compilePathGlob(pattern: string): PathGlobMatcher {
  const tokens = tokenizePathGlob(pattern);
  return (path: string): boolean => matchesCompiledPathGlob(tokens, path);
}

export function matchesPathGlob(pattern: string, path: string): boolean {
  return compilePathGlob(pattern)(path);
}
