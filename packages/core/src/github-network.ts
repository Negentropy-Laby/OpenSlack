/** Only administrator-pinned inputs; never consult process proxy variables. */
export function validateGitHubNetwork(httpsProxy: string, noProxy: string): void {
  if (
    typeof httpsProxy !== 'string' ||
    typeof noProxy !== 'string' ||
    httpsProxy.length > 2048 ||
    noProxy.length > 2048 ||
    /[^\x20-\x7e]/.test(noProxy)
  )
    throw new TypeError('GITHUB_NETWORK_INVALID');
  if (!httpsProxy) return;
  try {
    const url = new URL(httpsProxy);
    if (
      !/^https?:\/\/[^\s/?#]+\/?$/.test(httpsProxy) ||
      !url.hostname ||
      httpsProxy.includes('\\') ||
      url.pathname !== '/' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.port === '0'
    )
      throw new Error();
  } catch {
    throw new TypeError('GITHUB_NETWORK_INVALID');
  }
}

/** Matches the Go source reader's fixed GitHub-host bypass rules. */
export function githubProxyBypassed(noProxy: string): boolean {
  return noProxy.split(',').some((item) => {
    const domain = item.trim().toLowerCase().replace(/:443$/, '').replace(/^\./, '');
    return domain === '*' || domain === 'api.github.com' || domain === 'github.com';
  });
}
