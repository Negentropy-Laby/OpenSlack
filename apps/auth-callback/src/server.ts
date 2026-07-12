import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  boundedJsonPost,
  BoundedJsonPostError,
  type BoundedJsonPostFailureCode,
} from '@openslack/github/bounded-json-post';

const PORT = parseInt(process.env.AUTH_PORT || '8200', 10);
const CALLBACK_PATH = '/callback';
const BIND_HOST = process.env.AUTH_HOST || '127.0.0.1'; // GitHub recommends 127.0.0.1 for native apps

// Generate a random OAuth state to prevent CSRF
const EXPECTED_STATE = process.env.GH_OAUTH_STATE || createOAuthState();

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

export function createOAuthState(): string {
  return randomBytes(32).toString('base64url');
}

export function oauthStatesMatch(receivedState: string | null, expectedState: string): boolean {
  if (!receivedState || !expectedState) return false;

  const receivedDigest = createHash('sha256').update(receivedState).digest();
  const expectedDigest = createHash('sha256').update(expectedState).digest();
  return timingSafeEqual(receivedDigest, expectedDigest);
}

function oauthTokenFailureCode(
  code: BoundedJsonPostFailureCode,
): Exclude<OAuthTokenExchangeResult, { ok: true }>['code'] {
  const codes: Record<
    BoundedJsonPostFailureCode,
    Exclude<OAuthTokenExchangeResult, { ok: true }>['code']
  > = {
    HTTP_ERROR: 'OAUTH_TOKEN_HTTP_ERROR',
    INVALID_JSON: 'OAUTH_TOKEN_INVALID_JSON',
    INVALID_RESPONSE: 'OAUTH_TOKEN_INVALID_RESPONSE',
    NETWORK_ERROR: 'OAUTH_TOKEN_NETWORK_ERROR',
    RESPONSE_TOO_LARGE: 'OAUTH_TOKEN_RESPONSE_TOO_LARGE',
    TIMEOUT: 'OAUTH_TOKEN_TIMEOUT',
  };
  return codes[code];
}

export function parseOAuthCallback(url: URL, expectedState: string): OAuthCallbackResult {
  const state = url.searchParams.get('state');
  if (!oauthStatesMatch(state, expectedState)) {
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

export async function exchangeCodeForToken(code: string): Promise<OAuthTokenExchangeResult> {
  const body = new URLSearchParams({
    client_id: process.env.GH_CLIENT_ID || '',
    client_secret: process.env.GH_CLIENT_SECRET || '',
    code,
  }).toString();

  try {
    const response = await boundedJsonPost({
      url: 'https://github.com/login/oauth/access_token',
      body,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
    });

    // boundedJsonPost validates only a top-level object; validate the OAuth token contract here.
    if (typeof response.access_token !== 'string' || response.access_token.trim().length === 0) {
      return { ok: false, code: 'OAUTH_TOKEN_INVALID_RESPONSE' };
    }

    return { ok: true, token: response.access_token.trim() };
  } catch (error) {
    return {
      ok: false,
      code:
        error instanceof BoundedJsonPostError
          ? oauthTokenFailureCode(error.code)
          : 'OAUTH_TOKEN_NETWORK_ERROR',
    };
  }
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
