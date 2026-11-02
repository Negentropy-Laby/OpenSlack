// A real public MCP endpoint: initialize succeeds, but catalog pages consume a
// cumulative budget. The endpoint owns no files, credentials or model calls.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(new URL('../../../../apps/mcp/package.json', import.meta.url));
const { Server } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/server/index.js')).href);
const { StdioServerTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/server/stdio.js')).href);
const { ListToolsRequestSchema } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/types.js')).href);
const server = new Server({ name: 'bounded-catalog-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
const names = ['openslack_get_activity', ...Array.from({ length: 11 }, (_, index) => `openslack_fixture_${String.fromCharCode(97 + index)}`)];
const paged = process.argv.includes('agent-bound');
if (paged) names.push('openslack_preview_workflow', 'openslack_confirm_plan', 'openslack_cancel_plan', 'openslack_preview_scenario');
server.setRequestHandler(ListToolsRequestSchema, async request => {
  await new Promise(resolve => setTimeout(resolve, paged ? 3_500 : 6_500));
  const second = request.params?.cursor === 'second';
  return { tools: names.slice(second ? 8 : 0, paged && !second ? 8 : undefined)
    .map(name => ({ name, inputSchema: { type: 'object' } })),
    ...(paged && !second ? { nextCursor: 'second' } : {}) };
});
await server.connect(new StdioServerTransport());
process.stdin.once('end', () => { void server.close().then(() => { process.exit(0); }); });
