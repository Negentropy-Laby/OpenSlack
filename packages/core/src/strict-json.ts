function invalid(): never {
  throw new TypeError('STRICT_JSON_INVALID');
}

// Reject duplicate keys before JSON.parse can apply last-key-wins semantics.
// This parser checks structure; JSON.parse still validates complete JSON syntax.
export function decodeStrictJSON(
  bytes: Uint8Array | string,
  maxBytes: number,
  maxDepth = 64,
): unknown {
  const raw = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    raw.byteLength > maxBytes ||
    !Number.isSafeInteger(maxDepth) ||
    maxDepth < 1 ||
    (typeof bytes === 'string' && Buffer.from(bytes).toString('utf8') !== bytes)
  )
    invalid();
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
  } catch {
    return invalid();
  }
  let offset = 0;
  const space = () => {
    while (/\s/.test(text[offset] ?? '') && offset < text.length) offset++;
  };
  const string = (): string => {
    if (text[offset] !== '"') invalid();
    const start = offset++;
    while (offset < text.length) {
      const c = text[offset++];
      if (c === '\\') {
        offset++;
        continue;
      }
      if (c === '"') {
        const value: unknown = JSON.parse(text.slice(start, offset));
        if (typeof value !== 'string' || Buffer.from(value).toString('utf8') !== value) invalid();
        return value;
      }
    }
    return invalid();
  };
  const value = (depth: number): void => {
    if (depth > maxDepth) invalid();
    space();
    const c = text[offset];
    if (c === '"') {
      string();
      return;
    }
    if (c === '{') {
      offset++;
      space();
      const keys = new Set<string>();
      if (text[offset] === '}') {
        offset++;
        return;
      }
      while (offset < text.length) {
        space();
        const key = string();
        if (keys.has(key)) invalid();
        keys.add(key);
        space();
        if (text[offset++] !== ':') invalid();
        value(depth + 1);
        space();
        const delimiter = text[offset++];
        if (delimiter === '}') return;
        if (delimiter !== ',') invalid();
      }
      invalid();
    }
    if (c === '[') {
      offset++;
      space();
      if (text[offset] === ']') {
        offset++;
        return;
      }
      while (offset < text.length) {
        value(depth + 1);
        space();
        const delimiter = text[offset++];
        if (delimiter === ']') return;
        if (delimiter !== ',') invalid();
      }
      invalid();
    }
    const start = offset;
    while (offset < text.length && !/[\s,}\]]/.test(text[offset]!)) offset++;
    if (offset === start) invalid();
  };
  try {
    value(0);
    space();
    if (offset !== text.length) invalid();
    return JSON.parse(text);
  } catch {
    return invalid();
  }
}
