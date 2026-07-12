import { createSign } from 'node:crypto';
import { request as httpsRequest } from 'node:https';

const TOKEN_RESPONSE_MAX_BYTES = 64 * 1024;
const TOKEN_REQUEST_TIMEOUT_MS = 10_000;

type GitHubAppTokenFailureCode =
  | 'APP_TOKEN_HTTP_ERROR'
  | 'APP_TOKEN_INVALID_JSON'
  | 'APP_TOKEN_INVALID_RESPONSE'
  | 'APP_TOKEN_NETWORK_ERROR'
  | 'APP_TOKEN_RESPONSE_TOO_LARGE'
  | 'APP_TOKEN_TIMEOUT'
  | 'APP_TOKEN_UNKNOWN_ERROR';

class GitHubAppTokenEndpointError extends Error {
  constructor(readonly code: GitHubAppTokenFailureCode) {
    super(code);
    this.name = 'GitHubAppTokenEndpointError';
  }
}

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

async function postJson(
  url: string,
  body: Record<string, unknown>,
  headers: Record<string, string>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const data = JSON.stringify(body);
    let settled = false;
    const requestState: { timeout?: ReturnType<typeof setTimeout> } = {};

    const rejectSafe = (code: GitHubAppTokenFailureCode): void => {
      if (settled) return;
      settled = true;
      if (requestState.timeout) clearTimeout(requestState.timeout);
      reject(new GitHubAppTokenEndpointError(code));
    };

    const resolveSafe = (value: Record<string, unknown>): void => {
      if (settled) return;
      settled = true;
      if (requestState.timeout) clearTimeout(requestState.timeout);
      resolve(value);
    };

    const req = httpsRequest(
      {
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'openslack-github-provider',
        },
      },
      (res) => {
        let responseData = '';
        let responseBytes = 0;
        let responseTooLarge = false;

        res.on('data', (chunk: Buffer | string) => {
          if (settled || responseTooLarge) return;
          const text = chunk.toString();
          responseBytes += Buffer.byteLength(text);
          if (responseBytes > TOKEN_RESPONSE_MAX_BYTES) {
            responseTooLarge = true;
            responseData = '';
            return;
          }
          responseData += text;
        });
        res.on('end', () => {
          if (responseTooLarge) {
            rejectSafe('APP_TOKEN_RESPONSE_TOO_LARGE');
            return;
          }
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            rejectSafe('APP_TOKEN_HTTP_ERROR');
            return;
          }

          let parsed: unknown;
          try {
            parsed = JSON.parse(responseData);
          } catch {
            rejectSafe('APP_TOKEN_INVALID_JSON');
            return;
          }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            rejectSafe('APP_TOKEN_INVALID_RESPONSE');
            return;
          }
          resolveSafe(parsed as Record<string, unknown>);
        });
      },
    );
    requestState.timeout = setTimeout(() => {
      rejectSafe('APP_TOKEN_TIMEOUT');
      req.destroy();
    }, TOKEN_REQUEST_TIMEOUT_MS);
    requestState.timeout.unref();
    req.on('error', () => rejectSafe('APP_TOKEN_NETWORK_ERROR'));
    req.write(data);
    req.end();
  });
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
    const response = await postJson(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      {},
      {
        Authorization: `Bearer ${jwt}`,
      },
    );

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
      error instanceof GitHubAppTokenEndpointError ? error.code : 'APP_TOKEN_UNKNOWN_ERROR',
    );
    return null;
  }
}

export function clearTokenCache(): void {
  cachedToken = null;
}
