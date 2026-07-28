import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Qoder MCP config examples', () => {
  it.each(['windows', 'wsl', 'unix'])(
    'keeps the %s workspace path as one argument and launches default read-only over stdio',
    (platform: string) => {
      const path = resolve(
        process.cwd(),
        'templates',
        'qoder-skill',
        'examples',
        `mcp-config.${platform}.json`,
      );
      const config = JSON.parse(readFileSync(path, 'utf8')) as {
        mcpServers: {
          openslack: {
            type: string;
            command: string;
            args: string[];
            env?: Record<string, string>;
          };
        };
      };
      const server = config.mcpServers.openslack;

      expect(server.type).toBe('stdio');
      expect(server.args.slice(-4)).toEqual(['openslack', 'mcp', 'serve', '--stdio']);
      expect(server.args.some((argument) => /\s/.test(argument))).toBe(true);
      expect(server.env).toBeUndefined();
      expect(JSON.stringify(server)).not.toMatch(/token|secret|password|http:|https:/i);
    },
  );

  it.each(['windows', 'wsl', 'unix'])(
    'keeps the %s agent-bound example credential-free and explicit',
    (platform: string) => {
      const path = resolve(
        process.cwd(),
        'templates',
        'qoder-skill',
        'examples',
        `mcp-config.agent-bound.${platform}.json`,
      );
      const config = JSON.parse(readFileSync(path, 'utf8')) as {
        mcpServers: {
          openslack: {
            type: string;
            command: string;
            args: string[];
            env?: Record<string, string>;
          };
        };
      };
      const server = config.mcpServers.openslack;

      expect(server.type).toBe('stdio');
      expect(server.args.slice(-8)).toEqual([
        'openslack',
        'mcp',
        'serve',
        '--stdio',
        '--profile',
        'agent-bound',
        '--principal-ref',
        '<agent-id>',
      ]);
      expect(server.args.some((argument) => /\s/.test(argument))).toBe(true);
      expect(server.args).not.toContain('--workspace-id');
      expect(server.env).toBeUndefined();
      expect(JSON.stringify(server)).not.toMatch(/token|secret|password|http:|https:/i);
    },
  );
});
