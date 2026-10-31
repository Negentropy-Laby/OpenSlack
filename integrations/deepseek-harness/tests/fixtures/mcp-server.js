// Fixture endpoint uses the public MCP SDK, not a handwritten wire implementation.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(new URL('../../../../apps/mcp/package.json', import.meta.url));
const { Server } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/server/index.js')).href);
const { StdioServerTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/server/stdio.js')).href);
const { ListToolsRequestSchema, CallToolRequestSchema } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/types.js')).href);
const server = new Server({ name: 'keyless-openslack-endpoint', version: '1.0.0' }, { capabilities: { tools: {} } });
const { getReviewedHarnessToolCatalog } = await import('../../../../packages/qoder-adapter/dist/harness-tool-catalog.js');
const tools = getReviewedHarnessToolCatalog(process.argv.includes('agent-bound') ? 'task' : 'read-only');
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...tools,
  { name: 'openslack_unreviewed_future_tool', inputSchema: { type: 'object' } }] }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  if (request.params.arguments?.disconnect === true) setImmediate(() => { void server.close().then(() => { process.exit(0); }); });
  return { content: [{ type: 'text', text: 'fixture response' }], structuredContent: { status: 'completed' } };
});
await server.connect(new StdioServerTransport());
process.stdin.once('end', () => { void server.close().then(() => { process.exitCode = 0; }); });
