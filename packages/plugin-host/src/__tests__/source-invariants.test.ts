import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import * as pluginHostPublicApi from '../index.js';
import type { LoadPluginManifestOptions } from '../index.js';

const SOURCE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const EXCLUDED_DIRECTORIES = new Set(['__fixtures__', '__tests__']);
const FORBIDDEN_NODE_MODULES = [
  'node:module',
  'node:vm',
  'node:worker_threads',
  'node:child_process',
] as const;
const FORBIDDEN_CALLS = new Set(['require', 'eval', 'Function', 'createRequire']);

async function productionSourceFiles(directory = SOURCE_ROOT): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry): Promise<readonly string[]> => {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return EXCLUDED_DIRECTORIES.has(entry.name) ? [] : productionSourceFiles(absolutePath);
      }
      if (
        !entry.isFile() ||
        !entry.name.endsWith('.ts') ||
        entry.name.endsWith('.d.ts') ||
        entry.name.endsWith('.test.ts') ||
        entry.name.endsWith('.spec.ts')
      ) {
        return [];
      }
      return [absolutePath];
    }),
  );
  return files.flat().sort((left, right) => left.localeCompare(right));
}

function relativeSourcePath(filePath: string): string {
  return path.relative(SOURCE_ROOT, filePath).replaceAll(path.sep, '/');
}

function location(sourceFile: ts.SourceFile, node: ts.Node): string {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${relativeSourcePath(sourceFile.fileName)}:${line + 1}:${character + 1}`;
}

function calledIdentifier(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
}

function moduleSpecifierText(node: ts.Node): string | undefined {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier &&
    ts.isStringLiteral(node.moduleSpecifier)
  ) {
    return node.moduleSpecifier.text;
  }
  if (
    ts.isImportEqualsDeclaration(node) &&
    ts.isExternalModuleReference(node.moduleReference) &&
    node.moduleReference.expression &&
    ts.isStringLiteral(node.moduleReference.expression)
  ) {
    return node.moduleReference.expression.text;
  }
  return undefined;
}

function isForbiddenNodeModule(specifier: string): boolean {
  return FORBIDDEN_NODE_MODULES.some(
    (forbidden) => specifier === forbidden || specifier.startsWith(`${forbidden}/`),
  );
}

describe('plugin-host production source invariants', () => {
  it('does not expose deterministic I/O race hooks from the package root', () => {
    const publicLoadOptionsHaveTestHooks: '__testHooks' extends keyof LoadPluginManifestOptions
      ? true
      : false = false;

    expect(publicLoadOptionsHaveTestHooks).toBe(false);
    expect(Object.hasOwn(pluginHostPublicApi, 'loadPluginManifestForTest')).toBe(false);
    expect(Object.hasOwn(pluginHostPublicApi, 'readPluginLockForTest')).toBe(false);
    expect(Object.hasOwn(pluginHostPublicApi, 'writePluginLockAtomicForTest')).toBe(false);
  });

  it('contains production sources and excludes tests and fixtures from the scan', async () => {
    const files = await productionSourceFiles();
    const relativeFiles = files.map(relativeSourcePath);

    expect(relativeFiles).toContain('index.ts');
    expect(relativeFiles.length).toBeGreaterThan(1);
    expect(relativeFiles.every((file) => !file.includes('__tests__'))).toBe(true);
    expect(relativeFiles.every((file) => !file.includes('__fixtures__'))).toBe(true);
  });

  it('contains no dynamic loading, evaluation, or forbidden Node execution module', async () => {
    const violations: string[] = [];

    for (const filePath of await productionSourceFiles()) {
      const sourceText = await readFile(filePath, 'utf8');
      const sourceFile = ts.createSourceFile(
        filePath,
        sourceText,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
            violations.push(`${location(sourceFile, node)} dynamic import`);
          } else {
            const identifier = calledIdentifier(node.expression);
            if (identifier && FORBIDDEN_CALLS.has(identifier)) {
              violations.push(`${location(sourceFile, node)} ${identifier}()`);
            }
          }
        }
        if (ts.isNewExpression(node) && calledIdentifier(node.expression) === 'Function') {
          violations.push(`${location(sourceFile, node)} new Function()`);
        }
        const specifier = moduleSpecifierText(node);
        if (specifier && isForbiddenNodeModule(specifier)) {
          violations.push(`${location(sourceFile, node)} import ${specifier}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }

    expect(violations).toEqual([]);
  });

  it('uses @openslack/plugin-api only through type-only imports and re-exports', async () => {
    const violations: string[] = [];

    for (const filePath of await productionSourceFiles()) {
      const sourceText = await readFile(filePath, 'utf8');
      const sourceFile = ts.createSourceFile(
        filePath,
        sourceText,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      const visit = (node: ts.Node): void => {
        const specifier = moduleSpecifierText(node);
        if (specifier === '@openslack/plugin-api') {
          const typeOnly =
            (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly === true) ||
            (ts.isExportDeclaration(node) && node.isTypeOnly);
          if (!typeOnly) {
            violations.push(`${location(sourceFile, node)} runtime ${node.getText(sourceFile)}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }

    expect(violations).toEqual([]);
  });
});
