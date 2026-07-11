#!/usr/bin/env node
import { startAuthServer } from './server.js';

console.log('=== OpenSlack Auth Callback Server ===');
console.log('');
console.log('This loopback server creates an organization-owned GitHub App from a manifest.');
console.log('Secrets are stored through CredentialStore; plaintext token files are forbidden.');
console.log('');

startAuthServer({
  host: process.env.OPENSLACK_AUTH_HOST,
  port: process.env.OPENSLACK_AUTH_PORT
    ? Number.parseInt(process.env.OPENSLACK_AUTH_PORT, 10)
    : undefined,
  organization: process.env.OPENSLACK_GITHUB_ORG,
  appName: process.env.OPENSLACK_GITHUB_APP_NAME,
  homepageUrl: process.env.OPENSLACK_GITHUB_APP_HOMEPAGE_URL,
  webhookUrl: process.env.OPENSLACK_GITHUB_APP_WEBHOOK_URL,
  privateKeyRef: process.env.OPENSLACK_GITHUB_APP_PRIVATE_KEY_REF,
  webhookSecretRef: process.env.OPENSLACK_GITHUB_APP_WEBHOOK_SECRET_REF,
  clientSecretRef: process.env.OPENSLACK_GITHUB_APP_CLIENT_SECRET_REF,
})
  .then((result) => {
    console.log(
      result.status === 'completed' ? '[Auth] App manifest completed.' : '[Auth] Setup timed out.',
    );
    process.exit(0);
  })
  .catch((err) => {
    const message =
      err instanceof Error && err.message.startsWith('GitHub App Manifest')
        ? err.message
        : 'GitHub App Manifest setup failed safely.';
    console.error(`[Auth] Failed: ${message}`);
    process.exit(1);
  });
