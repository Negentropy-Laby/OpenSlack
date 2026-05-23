export interface CodeownersEntry {
  pattern: string;
  owners: string[];
}

function matchesGlob(path: string, glob: string): boolean {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '<<GLOBSTAR_SLASH>>')
    .replace(/\*\*/g, '<<GLOBSTAR>>')
    .replace(/\*/g, '[^/]*')
    .replace(/<<GLOBSTAR_SLASH>>/g, '(.*/)?')
    .replace(/<<GLOBSTAR>>/g, '.*');
  const regex = new RegExp(`^${escaped}$`);
  return regex.test(path);
}

export function parseCODEOWNERS(content: string): CodeownersEntry[] {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const parts = line.split(/\s+/);
      return { pattern: parts[0], owners: parts.slice(1) };
    });
}

export function resolveCodeowners(
  changedFiles: string[],
  entries: CodeownersEntry[],
): string[] {
  const owners = new Set<string>();
  for (const file of changedFiles) {
    for (const entry of entries) {
      if (matchesGlob(file, entry.pattern)) {
        for (const owner of entry.owners) {
          owners.add(owner);
        }
      }
    }
  }
  return Array.from(owners);
}
