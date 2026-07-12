import { createSign } from 'node:crypto';
import {
  boundedJsonPost,
  BoundedJsonPostError,
  type BoundedJsonPostFailureCode,
} from './bounded-json-post.js';

type GitHubAppTokenFailureCode =
  | 'APP_TOKEN_HTTP_ERROR'
  | 'APP_TOKEN_INVALID_JSON'
  | 'APP_TOKEN_INVALID_RESPONSE'
  | 'APP_TOKEN_NETWORK_ERROR'
  | 'APP_TOKEN_RESPONSE_TOO_LARGE'
  | 'APP_TOKEN_TIMEOUT'
  | 'APP_TOKEN_UNKNOWN_ERROR';

interface TokenCache {
  token: string;
  expiresAt: Date;
}

let cachedToken: TokenCache | null = null;

function base64urlEncode(buf: Buffer): string {
  return buf.toString('base64url').replace(/=+$/, '');
}

function createJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64urlEncode(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const payload = base64urlEncode(
    Buffer.from(
      JSON.stringify({
        iat: now - 60, // 60s clock skew tolerance
        exp: now + 600, // 10 minute expiry (GitHub max)
        iss: appId,
      }),
    ),
  );

  const sign = createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const signature = base64urlEncode(sign.sign(privateKey));

  return `${header}.${payload}.${signature}`;
}

function appTokenFailureCode(code: BoundedJsonPostFailureCode): GitHubAppTokenFailureCode {
  const codes: Record<BoundedJsonPostFailureCode, GitHubAppTokenFailureCode> = {
    HTTP_ERROR: 'APP_TOKEN_HTTP_ERROR',
    INVALID_JSON: 'APP_TOKEN_INVALID_JSON',
    INVALID_RESPONSE: 'APP_TOKEN_INVALID_RESPONSE',
    NETWORK_ERROR: 'APP_TOKEN_NETWORK_ERROR',
    RESPONSE_TOO_LARGE: 'APP_TOKEN_RESPONSE_TOO_LARGE',
    TIMEOUT: 'APP_TOKEN_TIMEOUT',
  };
  return codes[code];
}

function reportTokenFailure(code: GitHubAppTokenFailureCode): void {
  console.error(`[GitHub App] Installation token unavailable (${code}).`);
}

export async function getAppInstallationToken(): Promise<{
  token: string;
  expiresAt: string;
  tokenType: string;
} | null> {
  const appId = process.env.OPENSLACK_GITHUB_APP_ID;
  const installationId = process.env.OPENSLACK_GITHUB_APP_INSTALLATION_ID;
  const privateKey = process.env.OPENSLACK_GITHUB_APP_PRIVATE_KEY;

  if (!appId || !installationId || !privateKey) {
    return null;
  }

  // Return cached token if still valid (with 5-minute safety margin)
  if (cachedToken && cachedToken.expiresAt > new Date(Date.now() + 300000)) {
    return {
      token: cachedToken.token,
      expiresAt: cachedToken.expiresAt.toISOString(),
      tokenType: 'installation',
    };
  }

  try {
    const jwt = createJwt(appId, privateKey);
    const response = await boundedJsonPost({
      url: `https://api.github.com/app/installations/${installationId}/access_tokens`,
      body: '{}',
      headers: {
        Authorization: `Bearer ${jwt}`,
        'Content-Type': 'application/json',
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'openslack-github-provider',
      },
    });

    // boundedJsonPost validates only a top-level object; validate the token contract here.
    if (
      typeof response.token !== 'string' ||
      response.token.trim().length === 0 ||
      typeof response.expires_at !== 'string' ||
      Number.isNaN(Date.parse(response.expires_at))
    ) {
      reportTokenFailure('APP_TOKEN_INVALID_RESPONSE');
      return null;
    }

    cachedToken = {
      token: response.token as string,
      expiresAt: new Date(response.expires_at as string),
    };

    return {
      token: cachedToken.token,
      expiresAt: cachedToken.expiresAt.toISOString(),
      tokenType: 'installation',
    };
  } catch (error) {
    reportTokenFailure(
      error instanceof BoundedJsonPostError
        ? appTokenFailureCode(error.code)
        : 'APP_TOKEN_UNKNOWN_ERROR',
    );
    return null;
  }
}

export function clearTokenCache(): void {
  cachedToken = null;
}
