import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { CredentialStore } from '@openslack/credentials';
import { createDefaultCredentialStore } from '@openslack/credentials';
import {
  completeGitHubAppManifest,
  createGitHubAppManifestSession,
  defaultGitHubAppManifestRefs,
  preflightGitHubAppManifest,
  type GitHubAppManifestInput,
} from '@openslack/github';
import { resolveWorkspaceContext } from '@openslack/workspace';

const CALLBACK_PATH = '/callback';
const DEFAULT_PORT = 8200;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export interface AuthServerOptions {
  host?: string;
  port?: number;
  timeoutMs?: number;
  workspaceRoot?: string;
  organization?: string;
  appName?: string;
  homepageUrl?: string;
  webhookUrl?: string;
  privateKeyRef?: string;
  webhookSecretRef?: string;
  clientSecretRef?: string;
  credentialStore?: CredentialStore;
  exchangeCode?: (code: string) => Promise<unknown>;
}

export interface AuthServerResult {
  status: 'completed' | 'timed_out';
  appId?: string;
  appSlug?: string;
  configPath?: string;
}

export function startAuthServer(options: AuthServerOptions = {}): Promise<AuthServerResult> {
  const host = options.host ?? '127.0.0.1';
  assertLoopbackHost(host);
  const port = options.port ?? DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('GitHub App Manifest callback port is invalid.');
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const callbackUrl = `http://${host === '::1' ? '[::1]' : host}:${port}${CALLBACK_PATH}`;
  const context = resolveWorkspaceContext({
    workspaceRoot: options.workspaceRoot ?? process.cwd(),
  });
  const defaultRefs = defaultGitHubAppManifestRefs(context.workspaceRoot);
  const input: GitHubAppManifestInput = {
    localStateRoot: context.localStateRoot,
    callbackUrl,
    appName: options.appName ?? 'OpenSlack Agent Operator',
    organization: options.organization,
    homepageUrl: options.homepageUrl,
    webhookUrl: options.webhookUrl,
    privateKeyRef: options.privateKeyRef ?? defaultRefs.privateKeyRef,
    webhookSecretRef: options.webhookSecretRef ?? defaultRefs.webhookSecretRef,
    clientSecretRef: options.clientSecretRef ?? defaultRefs.clientSecretRef,
  };
  const credentialStore = options.credentialStore ?? createDefaultCredentialStore(process.env);
  preflightGitHubAppManifest(input, credentialStore);
  const session = createGitHubAppManifestSession(input, { ttlMs: timeoutMs });

  return new Promise((resolve, reject) => {
    let phase: 'waiting' | 'processing' | 'terminal' = 'waiting';
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (!isExpectedHost(req.headers.host, host, port)) {
        sendHtml(res, 421, renderMessage('Invalid loopback Host header.'));
        return;
      }
      const url = new URL(req.url ?? '/', callbackUrl);
      if (req.method === 'GET' && url.pathname === '/') {
        sendHtml(
          res,
          200,
          renderRegistrationPage(session.actionUrl, session.state, session.manifest),
        );
        return;
      }
      if (req.method !== 'GET' || url.pathname !== CALLBACK_PATH) {
        sendHtml(res, 404, renderMessage('Not found.'));
        return;
      }

      // Tokens in URLs leak through browser history, referrers, and intermediary logs.
      // Reject the parameter even when a valid Manifest callback code is also present.
      if (url.searchParams.has('access_token')) {
        sendHtml(res, 400, renderMessage('Token query parameters are not accepted.'));
        return;
      }

      const state = url.searchParams.get('state') ?? '';
      const code = url.searchParams.get('code') ?? '';
      if (!/^[A-Za-z0-9_-]{16,256}$/.test(code)) {
        sendHtml(res, 400, renderMessage('GitHub App Manifest callback code is invalid.'));
        return;
      }
      try {
        session.consume(state);
      } catch (error) {
        sendHtml(res, 400, renderMessage(safeErrorMessage(error)));
        return;
      }
      phase = 'processing';
      clearTimeout(timeout);

      try {
        const result = await completeGitHubAppManifest(input, code, {
          credentialStore,
          exchangeCode: options.exchangeCode,
        });
        phase = 'terminal';
        sendHtml(
          res,
          200,
          renderMessage(
            'GitHub App credentials were stored by reference. You can close this window.',
          ),
        );
        server.close(() =>
          resolve({
            status: 'completed',
            appId: result.appId,
            appSlug: result.appSlug,
            configPath: result.configPath,
          }),
        );
      } catch (error) {
        phase = 'terminal';
        const safe = new Error(safeErrorMessage(error));
        sendHtml(res, 502, renderMessage(safe.message));
        server.close(() => reject(safe));
      }
    });

    server.listen(port, host, () => {
      console.log(
        `[Auth] GitHub App Manifest setup: http://${host === '::1' ? '[::1]' : host}:${port}/`,
      );
      console.log(
        `[Auth] Callback is loopback-only and expires at ${new Date(session.expiresAt).toISOString()}.`,
      );
      console.log('[Auth] No OAuth or installation token will be accepted or written to disk.');
    });

    server.on('error', (_error: Error) => {
      phase = 'terminal';
      clearTimeout(timeout);
      reject(new Error('GitHub App Manifest callback server could not start.'));
    });

    const timeout = setTimeout(() => {
      if (phase !== 'waiting') return;
      phase = 'terminal';
      server.close(() => resolve({ status: 'timed_out' }));
    }, timeoutMs);
    timeout.unref();
  });
}

export function assertLoopbackHost(host: string): void {
  if (host !== '127.0.0.1' && host !== '::1') {
    throw new Error('GitHub App Manifest callback must bind to 127.0.0.1 or ::1.');
  }
}

export function isExpectedHost(header: string | undefined, host: string, port: number): boolean {
  const expected = host === '::1' ? `[::1]:${port}` : `${host}:${port}`;
  return header === expected;
}

function renderRegistrationPage(actionUrl: string, state: string, manifest: object): string {
  return page(`
    <h2>OpenSlack GitHub App setup</h2>
    <p>Review the requested repository permissions on GitHub before creating the App.</p>
    <form action="${escapeHtml(`${actionUrl}?state=${encodeURIComponent(state)}`)}" method="post">
      <input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">
      <button type="submit">Create GitHub App</button>
    </form>
  `);
}

function renderMessage(message: string): string {
  return page(`<h2>OpenSlack GitHub App setup</h2><p>${escapeHtml(message)}</p>`);
}

function page(body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>OpenSlack GitHub App setup</title></head><body style="font-family:system-ui;padding:2rem;max-width:48rem;margin:auto">${body}</body></html>`;
}

function sendHtml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy':
      "default-src 'none'; style-src 'unsafe-inline'; form-action https://github.com; base-uri 'none'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.startsWith('GitHub App Manifest')) {
    return error.message;
  }
  return 'GitHub App Manifest setup failed safely. Run openslack doctor for remediation.';
}
