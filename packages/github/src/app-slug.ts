const GITHUB_APP_SLUG_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?$/;

export function isGitHubAppSlug(value: unknown): value is string {
  return typeof value === 'string' && GITHUB_APP_SLUG_PATTERN.test(value);
}
