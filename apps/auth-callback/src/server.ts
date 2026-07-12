import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { request } from 'node:https';

const PORT = parseInt(process.env.AUTH_PORT || '8200', 10);
const CALLBACK_PATH = '/callback';
const BIND_HOST = process.env.AUTH_HOST || '127.0.0.1'; // GitHub recommends 127.0.0.1 for native apps
const TOKEN_RESPONSE_MAX_BYTES = 64 * 1024;
const TOKEN_REQUEST_TIMEOUT_MS = 10_000;

// Generate a random OAuth state to prevent CSRF
const EXPECTED_STATE =
  process.env.GH_OAUTH_STATE ||
  `openslack-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'openslack.yaml'))) return dir;
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

function sendResponse(res: ServerResponse, code: number, body: string): void {
  res.writeHead(code, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(
    `<!DOCTYPE html><html><body style="font-family:monospace;padding:2em;text-align:center"><h2>OpenSlack Auth</h2><p>${body}</p></body></html>`,
  );
}

export type OAuthCallbackResult =
  | { accepted: true; code: string }
  | { accepted: false; message: string };

export type OAuthTokenExchangeResult =
  | { ok: true; token: string }
  | {
      ok: false;
      code:
        | 'OAUTH_TOKEN_HTTP_ERROR'
        | 'OAUTH_TOKEN_INVALID_JSON'
        | 'OAUTH_TOKEN_INVALID_RESPONSE'
        | 'OAUTH_TOKEN_NETWORK_ERROR'
        | 'OAUTH_TOKEN_RESPONSE_TOO_LARGE'
        | 'OAUTH_TOKEN_TIMEOUT';
    };

export function parseOAuthCallback(url: URL, expectedState: string): OAuthCallbackResult {
  const state = url.searchParams.get('state');
  if (!state || state !== expectedState) {
    return { accepted: false, message: 'Invalid OAuth state parameter.' };
  }

  // Tokens in URLs leak through browser history, referrers, and intermediary logs.
  if (url.searchParams.has('access_token')) {
    return { accepted: false, message: 'OAuth token query parameters are not accepted.' };
  }

  const code = url.searchParams.get('code');
  if (!code) {
    return { accepted: false, message: 'No authorization code received.' };
  }

  return { accepted: true, code };
}

export function exchangeCodeForToken(code: string): Promise<OAuthTokenExchangeResult> {
  return new Promise((resolve) => {
    const body = `client_id=${encodeURIComponent(process.env.GH_CLIENT_ID || '')}&client_secret=${encodeURIComponent(process.env.GH_CLIENT_SECRET || '')}&code=${encodeURIComponent(code)}`;
    let settled = false;

    const finish = (result: OAuthTokenExchangeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };

    const req = request(
      {
        hostname: 'github.com',
        path: '/login/oauth/access_token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
      },
      (incoming) => {
        let data = '';
        let responseBytes = 0;
        let responseTooLarge = false;

        incoming.on('data', (chunk: Buffer | string) => {
          if (settled || responseTooLarge) return;
          const text = chunk.toString();
          responseBytes += Buffer.byteLength(text);
          if (responseBytes > TOKEN_RESPONSE_MAX_BYTES) {
            responseTooLarge = true;
            data = '';
            return;
          }
          data += text;
        });
        incoming.on('end', () => {
          if (responseTooLarge) {
            finish({ ok: false, code: 'OAUTH_TOKEN_RESPONSE_TOO_LARGE' });
            return;
          }
          if (!incoming.statusCode || incoming.statusCode < 200 || incoming.statusCode >= 300) {
            finish({ ok: false, code: 'OAUTH_TOKEN_HTTP_ERROR' });
            return;
          }

          let parsed: unknown;
          try {
            parsed = JSON.parse(data);
          } catch {
            finish({ ok: false, code: 'OAUTH_TOKEN_INVALID_JSON' });
            return;
          }

          if (
            !parsed ||
            typeof parsed !== 'object' ||
            Array.isArray(parsed) ||
            typeof (parsed as { access_token?: unknown }).access_token !== 'string' ||
            (parsed as { access_token: string }).access_token.trim().length === 0
          ) {
            finish({ ok: false, code: 'OAUTH_TOKEN_INVALID_RESPONSE' });
            return;
          }

          finish({ ok: true, token: (parsed as { access_token: string }).access_token.trim() });
        });
      },
    );
    const timeout = setTimeout(() => {
      finish({ ok: false, code: 'OAUTH_TOKEN_TIMEOUT' });
      req.destroy();
    }, TOKEN_REQUEST_TIMEOUT_MS);
    timeout.unref();
    req.on('error', () => finish({ ok: false, code: 'OAUTH_TOKEN_NETWORK_ERROR' }));
    req.write(body);
    req.end();
  });
}

export function startAuthServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    const root = findRepoRoot();
    let captured = false;

    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url || '/', `http://localhost:${PORT}`);

      if (url.pathname === CALLBACK_PATH && !captured) {
        const callback = parseOAuthCallback(url, EXPECTED_STATE);
        if (!callback.accepted) {
          sendResponse(res, 400, callback.message);
          return;
        }

        console.log('[Auth] Got OAuth code, exchanging for token...');
        const exchange = await exchangeCodeForToken(callback.code);
        if (exchange.ok) {
          captured = true;
          const tokenDir = join(root, '.openslack.local');
          mkdirSync(tokenDir, { recursive: true });
          writeFileSync(join(tokenDir, 'github-token'), exchange.token, 'utf-8');
          console.log(`[Auth] Token saved to ${join(tokenDir, 'github-token')}`);
          console.log(`[Auth] Run: gh auth login --with-token < ${join(tokenDir, 'github-token')}`);
          sendResponse(res, 200, 'Token captured. You can close this window.');
          server.close(() => resolve());
          return;
        }

        console.error(`[Auth] OAuth code exchange failed (${exchange.code}).`);
        sendResponse(res, 502, 'OAuth authorization code exchange failed safely.');
        return;
      }

      sendResponse(res, 400, 'No authorization code received.');
    });

    server.listen(PORT, BIND_HOST, () => {
      console.log(`[Auth] Listening on http://${BIND_HOST}:${PORT}${CALLBACK_PATH}`);
      console.log(`[Auth] OAuth state: ${EXPECTED_STATE}`);
      console.log('[Auth] Waiting for GitHub OAuth redirect...');
      console.log(`[Auth] Redirect URI: http://${BIND_HOST}:${PORT}/callback`);
      console.log('');
      console.log('Use this URL to authorize your own OAuth App:');
      console.log(
        `  https://github.com/login/oauth/authorize?client_id=YOUR_CLIENT_ID&redirect_uri=http://${BIND_HOST}:${PORT}/callback&scope=repo,read:project,project&state=${EXPECTED_STATE}`,
      );
      console.log('');
      console.log('NOT for capturing GitHub CLI (gh) tokens.');
    });

    server.on('error', (err: Error) => {
      if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        console.error(`[Auth] Port ${PORT} already in use.`);
      }
      reject(err);
    });

    // Auto-shutdown after 2 minutes if no callback received
    setTimeout(() => {
      if (!captured) {
        console.log('[Auth] Timeout — no callback received after 2 minutes.');
        server.close(() => resolve());
      }
    }, 120000);
  });
}
