/** Decode the pinned Linux/amd64 Go inline build-info format without executing the binary. */
export function readCleanupBrokerBuildInfo(raw: Buffer): {
  version: string;
  path: string;
  settings: Map<string, string>;
} {
  const require = (ok: boolean) => {
    if (!ok) throw new Error('INVALID_CLEANUP_BROKER_BUILD_INFO');
  };
  require(raw.length >= 64 && raw.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])));
  require(raw[4] === 2 && raw[5] === 1 && raw[6] === 1 && raw.readUInt16LE(18) === 62);
  const offset = Number(raw.readBigUInt64LE(40)),
    size = raw.readUInt16LE(58),
    count = raw.readUInt16LE(60),
    namesIndex = raw.readUInt16LE(62);
  require(
    Number.isSafeInteger(offset) &&
      offset >= 64 &&
      size === 64 &&
      count > 0 &&
      count <= 4096 &&
      namesIndex < count &&
      offset + count * size <= raw.length,
  );
  const section = (index: number) => {
    const start = offset + index * size;
    const fileOffset = Number(raw.readBigUInt64LE(start + 24)),
      fileSize = Number(raw.readBigUInt64LE(start + 32));
    require(
      Number.isSafeInteger(fileOffset) &&
        Number.isSafeInteger(fileSize) &&
        fileOffset >= 0 &&
        fileSize >= 0 &&
        fileOffset + fileSize <= raw.length,
    );
    return raw.subarray(fileOffset, fileOffset + fileSize);
  };
  const names = section(namesIndex);
  let data: Buffer | undefined;
  for (let index = 0; index < count; index++) {
    const nameOffset = raw.readUInt32LE(offset + index * size),
      end = names.indexOf(0, nameOffset);
    require(nameOffset < names.length && end >= nameOffset);
    if (names.subarray(nameOffset, end).toString('utf8') === '.go.buildinfo') {
      require(data === undefined);
      data = section(index);
    }
  }
  require(data !== undefined && data.length >= 32);
  const blob = data!;
  require(
    blob.subarray(0, 14).equals(Buffer.from('\xff Go buildinf:', 'latin1')) &&
      blob[14] === 8 &&
      blob[15] === 2,
  );
  let cursor = 32;
  const string = () => {
    let length = 0,
      shift = 0;
    for (;;) {
      require(cursor < blob.length && shift <= 28);
      const byte = blob[cursor++]!;
      length += (byte & 127) * 2 ** shift;
      if (byte < 128) break;
      shift += 7;
    }
    require(length <= 1024 * 1024 && cursor + length <= blob.length);
    const value = blob.subarray(cursor, cursor + length);
    cursor += length;
    return value;
  };
  const version = string().toString('utf8'),
    module = string();
  // Module data has fixed 16-byte framing. Decode bytes, not UTF-8 framing,
  // because Go's framing contains bytes which are not valid UTF-8.
  require(module.length >= 33 && module[module.length - 17] === 10);
  const lines = module.subarray(16, -16).toString('utf8').split('\n'),
    settings = new Map<string, string>();
  let path = '';
  for (const line of lines) {
    if (line.startsWith('path\t')) {
      require(path === '');
      path = line.slice(5);
    }
    if (line.startsWith('build\t')) {
      const equal = line.indexOf('=', 6);
      require(equal > 6);
      const key = line.slice(6, equal);
      require(!settings.has(key));
      settings.set(key, line.slice(equal + 1));
    }
  }
  require(path.length > 0);
  return { version, path, settings };
}
