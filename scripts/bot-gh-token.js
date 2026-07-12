#!/usr/bin/env node
// Acquire a GitHub App installation token for an in-process child launcher.
// Direct token output is intentionally disabled so credentials never transit
// shell variables, argv, Git configuration, or logs.

const { createSign } = require('node:crypto');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;

function readLocalConfig() {
  const configPath = path.resolve(__dirname, '..', '.openslack.local', 'github-app.json');
  if (!fs.existsSync(configPath)) return {};
  const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

function b64url(input) {
  return Buffer.from(input).toString('base64url').replace(/=+$/, '');
}

function jwt(appId, privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 600, iss: appId }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(privateKey).toString('base64url').replace(/=+$/, '');
  return `${header}.${payload}.${signature}`;
}

function getInstallationToken(appId, installationId, privateKey) {
  return new Promise((resolve, reject) => {
    const bearer = jwt(appId, privateKey);
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const req = https.request(
      {
        hostname: 'api.github.com',
        path: `/app/installations/${installationId}/access_tokens`,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${bearer}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'openslack-bot-gh',
        },
      },
      (res) => {
        const chunks = [];
        let byteLength = 0;
        res.on('data', (chunk) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          byteLength += buffer.byteLength;
          if (byteLength > MAX_RESPONSE_BYTES) {
            finish(() => reject(new Error('GitHub App token response exceeded the size limit.')));
            req.destroy();
            return;
          }
          chunks.push(buffer);
        });
        res.on('end', () => {
          finish(() => {
            if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
              reject(
                new Error(`GitHub App token request failed with HTTP ${res.statusCode ?? 0}.`),
              );
              return;
            }
            try {
              const data = JSON.parse(Buffer.concat(chunks, byteLength).toString('utf8'));
              if (typeof data.token !== 'string' || data.token.trim().length === 0) {
                reject(new Error('GitHub App token response was invalid.'));
                return;
              }
              const expiresAt =
                typeof data.expires_at === 'string' && !Number.isNaN(Date.parse(data.expires_at))
                  ? data.expires_at
                  : new Date(Date.now() + 50 * 60 * 1000).toISOString();
              const permissions =
                data.permissions &&
                typeof data.permissions === 'object' &&
                !Array.isArray(data.permissions)
                  ? Object.fromEntries(
                      Object.entries(data.permissions).filter(
                        (entry) => typeof entry[1] === 'string',
                      ),
                    )
                  : {};
              resolve({
                value: data.token,
                expiresAt,
                installationId: String(installationId),
                permissions,
              });
            } catch {
              reject(new Error('GitHub App token response was invalid.'));
            }
          });
        });
      },
    );
    req.on('error', () => {
      finish(() => reject(new Error('GitHub App token request failed safely.')));
    });
    const timeout = setTimeout(() => {
      finish(() => reject(new Error('GitHub App token request timed out.')));
      req.destroy();
    }, REQUEST_TIMEOUT_MS);
    timeout.unref();
    req.end();
  });
}

async function acquireConfiguredInstallationCredentials() {
  const localConfig = readLocalConfig();
  const appId = process.env.OPENSLACK_GITHUB_APP_ID || localConfig.appId;
  const installationId =
    process.env.OPENSLACK_GITHUB_APP_INSTALLATION_ID || localConfig.installationId;
  if (!appId || !installationId) {
    throw new Error('GitHub App identifiers are not configured.');
  }

  let privateKey = process.env.OPENSLACK_GITHUB_APP_PRIVATE_KEY;
  if (!privateKey) {
    const pemPath = path.resolve(__dirname, '..', '.openslack.local', 'github-app.pem');
    privateKey = fs.readFileSync(pemPath, 'utf8');
  }
  if (!privateKey || !privateKey.includes('PRIVATE KEY')) {
    throw new Error('GitHub App private key is not configured.');
  }

  return getInstallationToken(String(appId), String(installationId), privateKey);
}

async function acquireConfiguredInstallationToken() {
  return (await acquireConfiguredInstallationCredentials()).value;
}

async function main() {
  process.stderr.write(
    'Direct token output is disabled. Use bot-gh.sh, bot-gh.ps1, or openslack delivery publish.\n',
  );
  return 2;
}

module.exports = {
  acquireConfiguredInstallationCredentials,
  acquireConfiguredInstallationToken,
};

if (require.main === module) {
  void main().then((status) => process.exit(status));
}
