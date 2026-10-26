// Fixture endpoint uses the public MCP SDK, not a handwritten wire implementation.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(new URL('../../../../apps/mcp/package.json', import.meta.url));
const { Server } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/server/index.js')).href);
const { StdioServerTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/server/stdio.js')).href);
const { ListToolsRequestSchema, CallToolRequestSchema } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/types.js')).href);
const server = new Server({ name: 'keyless-openslack-endpoint', version: '1.0.0' }, { capabilities: { tools: {} } });
const names = ['openslack_get_activity', ...Array.from({ length: 11 }, (_, index) => `openslack_fixture_${String.fromCharCode(97 + index)}`),
  ...(process.argv.includes('agent-bound') ? ['openslack_preview_workflow', 'openslack_confirm_plan', 'openslack_cancel_plan', 'openslack_preview_scenario'] : [])];
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: names.map(name => ({ name, inputSchema: { type: 'object' } })) }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  if (request.params.arguments?.disconnect === true) setImmediate(() => { void server.close().then(() => { process.exit(0); }); });
  return { content: [{ type: 'text', text: 'fixture response' }], structuredContent: { status: 'completed' } };
});
await server.connect(new StdioServerTransport());
process.stdin.once('end', () => { void server.close().then(() => { process.exitCode = 0; }); });
