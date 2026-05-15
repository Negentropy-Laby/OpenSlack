#!/usr/bin/env node
import { startAuthServer } from './server.js';

console.log('=== OpenSlack Auth Callback Server ===');
console.log('');
console.log('This server captures GitHub OAuth tokens for human login.');
console.log('It is NOT used for agent runtime authentication.');
console.log('');
console.log('For agent runtime, use GitHub App installation tokens.');
console.log('See docs/developer/github-automation.md');
console.log('');

startAuthServer().then(() => {
  console.log('[Auth] Server stopped.');
  process.exit(0);
}).catch((err) => {
  console.error(`[Auth] Failed: ${err.message}`);
  process.exit(1);
});
