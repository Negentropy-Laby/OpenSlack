/** Pure repository syntax; imports no authentication or execution capability. */
export function parseGitHubRepoSpec(
  input: string | undefined,
): { owner: string; repo: string } | null {
  if (!input) return null;
  const value = input.trim();
  if (!value) return null;

  const ssh = value.match(
    /^git@(github\.com|ssh\.github\.com):([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/u,
  );
  if (ssh) {
    return validRepositoryParts(ssh[2], ssh[3]);
  }

  const shorthand = value.match(/^([^/\s]+)\/([^/\s]+?)(?:\.git)?$/u);
  if (shorthand) {
    return validRepositoryParts(shorthand[1], shorthand[2]);
  }

  const hostedShorthand = value.match(/^github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/u);
  if (hostedShorthand) {
    return validRepositoryParts(hostedShorthand[1], hostedShorthand[2]);
  }

  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (hostname !== 'github.com' && hostname !== 'ssh.github.com') return null;
    if (url.protocol !== 'https:' && url.protocol !== 'ssh:') return null;
    if (hostname === 'ssh.github.com' && url.protocol !== 'ssh:') return null;
    if (hostname === 'ssh.github.com' && url.port && url.port !== '443') return null;
    const segments = url.pathname.replace(/^\/+|\/+$/gu, '').split('/');
    if (segments.length !== 2) return null;
    return validRepositoryParts(segments[0], segments[1].replace(/\.git$/u, ''));
  } catch {
    return null;
  }
}

function validRepositoryParts(owner: string, repo: string): { owner: string; repo: string } | null {
  if (
    !/^(?!.*--)[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(owner) ||
    repo === '.' ||
    repo === '..' ||
    !/^[A-Za-z0-9._-]{1,100}$/u.test(repo)
  ) {
    return null;
  }
  return { owner, repo };
}
