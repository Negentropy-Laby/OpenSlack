// The write must finish before initialize can be read. Without an early stderr
// drain this exceeds the OS pipe capacity and deterministically stalls startup.
await new Promise((resolve, reject) => {
  process.stderr.write(Buffer.alloc(512 * 1024, 120), error => error ? reject(error) : resolve());
});
await import('./mcp-server.js');
