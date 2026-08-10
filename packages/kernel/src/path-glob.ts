type PathGlobToken =
  | { readonly kind: 'literal'; readonly value: string }
  | { readonly kind: 'star' }
  | { readonly kind: 'globstar' }
  | { readonly kind: 'globstar-directories' };

export type PathGlobMatcher = (path: string) => boolean;

const MAX_GLOB_ANALYSIS_LENGTH = 4096;
const MAX_GLOB_ANALYSIS_STATES = 65_536;

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

type GlobState = number;

function normalState(tokenIndex: number): GlobState {
  return tokenIndex * 2;
}

function scanningState(tokenIndex: number): GlobState {
  return tokenIndex * 2 + 1;
}

function stateTokenIndex(state: GlobState): number {
  return Math.floor(state / 2);
}

function isScanningState(state: GlobState): boolean {
  return state % 2 === 1;
}

function epsilonClosure(
  tokens: readonly PathGlobToken[],
  initial: Iterable<GlobState>,
): GlobState[] {
  const pending = [...initial];
  const closure = new Set<GlobState>();
  while (pending.length > 0) {
    const state = pending.pop()!;
    if (closure.has(state)) continue;
    closure.add(state);
    if (isScanningState(state)) continue;
    const tokenIndex = stateTokenIndex(state);
    const token = tokens[tokenIndex];
    if (!token || token.kind === 'literal') continue;
    pending.push(normalState(tokenIndex + 1));
    if (token.kind === 'globstar-directories') pending.push(scanningState(tokenIndex));
  }
  return [...closure].sort((left, right) => left - right);
}

function moveGlobStates(
  tokens: readonly PathGlobToken[],
  states: readonly GlobState[],
  character: string,
): GlobState[] {
  const moved = new Set<GlobState>();
  for (const state of states) {
    const tokenIndex = stateTokenIndex(state);
    if (isScanningState(state)) {
      moved.add(character === '/' ? normalState(tokenIndex) : scanningState(tokenIndex));
      continue;
    }
    const token = tokens[tokenIndex];
    if (!token) continue;
    if (token.kind === 'literal') {
      if (token.value === character) moved.add(normalState(tokenIndex + 1));
    } else if (token.kind === 'star') {
      if (character !== '/') moved.add(normalState(tokenIndex));
    } else if (token.kind === 'globstar') {
      moved.add(normalState(tokenIndex));
    }
  }
  return epsilonClosure(tokens, moved);
}

function stateKey(states: readonly GlobState[]): string {
  return states.join(',');
}

function pairKey(left: readonly GlobState[], right: readonly GlobState[]): string {
  return `${stateKey(left)}|${stateKey(right)}`;
}

function accepts(tokens: readonly PathGlobToken[], states: readonly GlobState[]): boolean {
  return states.includes(normalState(tokens.length));
}

function representativeCharacters(
  left: readonly PathGlobToken[],
  right: readonly PathGlobToken[],
): string[] {
  const characters = new Set<string>(['/']);
  for (const token of [...left, ...right]) {
    if (token.kind === 'literal') characters.add(token.value);
  }
  for (let code = 0; code <= 0xffff; code += 1) {
    const candidate = String.fromCharCode(code);
    if (candidate !== '/' && !characters.has(candidate)) {
      characters.add(candidate);
      break;
    }
  }
  return [...characters];
}

function analyzeGlobPair(
  leftPattern: string,
  rightPattern: string,
  mode: 'intersects' | 'left-subset-of-right',
): boolean {
  if (
    leftPattern.length > MAX_GLOB_ANALYSIS_LENGTH ||
    rightPattern.length > MAX_GLOB_ANALYSIS_LENGTH
  ) {
    return mode === 'intersects';
  }
  const left = tokenizePathGlob(leftPattern);
  const right = tokenizePathGlob(rightPattern);
  const characters = representativeCharacters(left, right);
  const startLeft = epsilonClosure(left, [normalState(0)]);
  const startRight = epsilonClosure(right, [normalState(0)]);
  const pending: Array<[GlobState[], GlobState[]]> = [[startLeft, startRight]];
  const visited = new Set<string>();

  while (pending.length > 0) {
    const [leftStates, rightStates] = pending.pop()!;
    const key = pairKey(leftStates, rightStates);
    if (visited.has(key)) continue;
    visited.add(key);
    if (visited.size > MAX_GLOB_ANALYSIS_STATES) return mode === 'intersects';

    const leftAccepts = accepts(left, leftStates);
    const rightAccepts = accepts(right, rightStates);
    if (mode === 'intersects' && leftAccepts && rightAccepts) return true;
    if (mode === 'left-subset-of-right' && leftAccepts && !rightAccepts) return false;

    for (const character of characters) {
      const nextLeft = moveGlobStates(left, leftStates, character);
      if (nextLeft.length === 0) continue;
      const nextRight = moveGlobStates(right, rightStates, character);
      if (mode === 'intersects' && nextRight.length === 0) continue;
      pending.push([nextLeft, nextRight]);
    }
  }
  return mode === 'left-subset-of-right';
}

/** Return whether the two documented path-glob languages share any path. */
export function pathGlobsIntersect(leftPattern: string, rightPattern: string): boolean {
  return analyzeGlobPair(leftPattern, rightPattern, 'intersects');
}

/** Return whether every path matched by candidatePattern is allowed by coveringPattern. */
export function pathGlobCovers(coveringPattern: string, candidatePattern: string): boolean {
  return analyzeGlobPair(candidatePattern, coveringPattern, 'left-subset-of-right');
}
