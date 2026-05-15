import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { request } from 'node:https';

const PORT = parseInt(process.env.AUTH_PORT || '8200', 10);
const CALLBACK_PATH = '/callback';
const TOKEN_FILE = '.openslack.local/github-token';

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
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!DOCTYPE html><html><body style="font-family:monospace;padding:2em;text-align:center"><h2>OpenSlack Auth</h2><p>${body}</p></body></html>`);
}

function exchangeCodeForToken(code: string): Promise<string | null> {
  return new Promise((resolve) => {
    const body = `client_id=${encodeURIComponent(process.env.GH_CLIENT_ID || '')}&client_secret=${encodeURIComponent(process.env.GH_CLIENT_SECRET || '')}&code=${encodeURIComponent(code)}`;
    const req = request({
      hostname: 'github.com',
      path: '/login/oauth/access_token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
    }, (incoming) => {
      let data = '';
      incoming.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      incoming.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.access_token || null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
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
        const code = url.searchParams.get('code');
        const token = url.searchParams.get('access_token');

        if (code) {
          console.log('[Auth] Got OAuth code, exchanging for token...');
          const accessToken = await exchangeCodeForToken(code);
          if (accessToken) {
            captured = true;
            const tokenDir = join(root, '.openslack.local');
            mkdirSync(tokenDir, { recursive: true });
            writeFileSync(join(tokenDir, 'github-token'), accessToken.trim(), 'utf-8');
            console.log(`[Auth] Token saved to ${join(tokenDir, 'github-token')}`);
            console.log(`[Auth] Run: gh auth login --with-token < ${join(tokenDir, 'github-token')}`);
            sendResponse(res, 200, 'Token captured. You can close this window.');
            server.close(() => resolve());
            return;
          }
        }

        if (token) {
          captured = true;
          const tokenDir = join(root, '.openslack.local');
          mkdirSync(tokenDir, { recursive: true });
          writeFileSync(join(tokenDir, 'github-token'), token.trim(), 'utf-8');
          console.log(`[Auth] Token saved to ${join(tokenDir, 'github-token')}`);
          sendResponse(res, 200, 'Token captured (implicit grant). You can close this window.');
          server.close(() => resolve());
          return;
        }
      }

      sendResponse(res, 400, 'No authorization code received.');
    });

    server.listen(PORT, () => {
      console.log(`[Auth] Listening on http://localhost:${PORT}${CALLBACK_PATH}`);
      console.log('[Auth] Waiting for GitHub OAuth redirect...');
      console.log(`[Auth] Redirect URI: http://localhost:${PORT}/callback`);
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
