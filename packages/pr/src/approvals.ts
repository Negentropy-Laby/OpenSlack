const KNOWN_BOTS = new Set([
  'github-actions',
  'openslack-bot',
  'dependabot',
  'renovate',
]);

export function isBotUser(user: string): boolean {
  return user.endsWith('[bot]')
    || user.toLowerCase().startsWith('app/')
    || KNOWN_BOTS.has(user.toLowerCase());
}

export function filterValidApprovals(
  reviews: Array<{ user: string; state: string }>,
  author: string,
): string[] {
  return reviews
    .filter((r) => r.state === 'APPROVED')
    .filter((r) => r.user !== author)
    .filter((r) => !isBotUser(r.user))
    .map((r) => r.user);
}
