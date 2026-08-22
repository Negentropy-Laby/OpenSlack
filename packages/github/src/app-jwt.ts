import { createSign } from 'node:crypto';

export const POSITIVE_GITHUB_ID_PATTERN = /^[1-9][0-9]*$/u;

function base64urlEncode(input: Buffer): string {
  return input.toString('base64url').replace(/=+$/u, '');
}

export function createGitHubAppJwt(
  appId: string,
  privateKey: string,
  now: () => number = Date.now,
): string {
  if (!POSITIVE_GITHUB_ID_PATTERN.test(appId)) {
    throw new Error('GitHub App identity is invalid.');
  }
  const seconds = Math.floor(now() / 1000);
  const header = base64urlEncode(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const payload = base64urlEncode(
    Buffer.from(JSON.stringify({ iat: seconds - 60, exp: seconds + 600, iss: appId })),
  );
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${base64urlEncode(signer.sign(privateKey))}`;
}
