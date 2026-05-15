#!/usr/bin/env node
import { startAuthServer } from './server.js';

console.log('=== OpenSlack Auth Callback Server ===');
console.log('');
console.log('This server captures GitHub OAuth tokens for headless environments.');
console.log('Use it with:');
console.log('  gh auth login --hostname github.com --web');
console.log('  (manually point redirect to http://localhost:8200/callback)');
console.log('');

startAuthServer().then(() => {
  console.log('[Auth] Server stopped.');
  process.exit(0);
}).catch((err) => {
  console.error(`[Auth] Failed: ${err.message}`);
  process.exit(1);
});
