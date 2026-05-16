import { createSign, randomUUID } from 'node:crypto';
import { request as httpsRequest } from 'node:https';

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

async function postJson(url: string, body: Record<string, unknown>, headers: Record<string, string>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const data = JSON.stringify(body);
    const req = httpsRequest(
      {
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'openslack-github-provider',
        },
      },
      (res) => {
        let responseData = '';
        res.on('data', (chunk: Buffer) => { responseData += chunk.toString(); });
        res.on('end', () => {
          try {
            resolve(JSON.parse(responseData));
          } catch {
            reject(new Error(`Failed to parse response: ${responseData.slice(0, 200)}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

export async function getAppInstallationToken(): Promise<{ token: string; expiresAt: string; tokenType: string } | null> {
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

    if (!response.token) {
      console.error('[GitHub App] Token endpoint returned no token:', JSON.stringify(response));
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
  } catch (err) {
    console.error(`[GitHub App] Failed to get installation token: ${(err as Error).message}`);
    return null;
  }
}

export function clearTokenCache(): void {
  cachedToken = null;
}
