import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const sourceRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const entry = join(sourceRoot, 'scripts/cleanup-broker/administration/verify-workspace.ts');
const sha = (raw: string | Buffer) => createHash('sha256').update(raw).digest('hex');
const fixtureRoots: string[] = [];
const fixed = {
  agent_id: 'cleanup_qualification_pr418',
  principal_id: 'principal:cleanup_qualification_pr418',
  runtime_uid_claim: 'cleanup_qualification_pr418',
  run_id: 'cleanup-pr418-f8db249a48c8492587e4515a31c60c45',
  workspace_id: 'openslack-self',
};
const registryBytes = readFileSync(
  join(sourceRoot, '.openslack/agents/registry/cleanup_qualification_pr418.yaml'),
);
let bundleRoot: string;
let tool: string;

beforeAll(() => {
  bundleRoot = mkdtempSync(join(tmpdir(), 'cleanup-workspace-tool '));
  tool = join(bundleRoot, 'verify-workspace.mjs');
  execFileSync('bun', ['build', entry, '--target=node', '--format=esm', '--outfile', tool], {
    cwd: sourceRoot,
    stdio: 'pipe',
    timeout: 60_000,
  });
}, 65_000);
afterAll(() => rmSync(bundleRoot, { recursive: true, force: true }));
afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const container = mkdtempSync('/var/tmp/cleanup-workspace-fixture ');
  fixtureRoots.push(container);
  chmodSync(container, 0o700);
  const workspace = join(container, 'fixed workspace');
  mkdirSync(workspace, { mode: 0o700 });
  const registry = join(workspace, '.openslack/agents/registry', `${fixed.agent_id}.yaml`);
  const identity = join(workspace, '.openslack.local/agents', fixed.agent_id, 'identity.yaml');
  for (const directory of [
    '.openslack',
    '.openslack/agents',
    '.openslack/agents/registry',
    '.openslack.local',
    '.openslack.local/agents',
    `.openslack.local/agents/${fixed.agent_id}`,
  ])
    mkdirSync(join(workspace, directory), { mode: 0o700 });
  const uid = process.getuid!(),
    gid = process.getgid!();
  const selectedValue = {
    schema: 'openslack.cleanup_admin_selected_bindings.v1',
    selected: {
      ...fixed,
      target_distro: 'NON_SENSITIVE_FIXTURE',
      agent_uid: String(uid),
      agent_gid: String(gid),
      broker_uid: String(uid + 1),
      broker_gid: String(gid + 1),
      qualification_repository_owner: 'Negentropy-Laby',
      qualification_repository_name: 'openslack-cleanup-qualification',
      qualification_repository_numeric_id: '1380965476',
      qualification_repository_default_branch: 'main',
    },
    priorInput: {
      source: 'non-sensitive fixture selection, not an administrator approval',
      sha256: '1'.repeat(64),
      approvalNotInherited: true,
    },
  };
  const config = {
    schema: 'openslack.workspace.v1',
    workspace_id: fixed.workspace_id,
    name: 'Non-sensitive dedicated workspace fixture',
    mode: 'normal',
    canonical_remote: {
      provider: 'github',
      owner: 'Negentropy-Laby',
      repo: 'OpenSlack',
      default_branch: 'main',
    },
    workspace: { root: '.', state_root: '.openslack' },
    product: { repo_role: 'managed', source_roots: [], protected_roots: [] },
  };
  const identityValue = {
    schema: 'openslack.agent_runtime_identity.v1',
    agent_id: fixed.agent_id,
    agent_uid: fixed.runtime_uid_claim,
    run_id: fixed.run_id,
    provider: 'cli',
    started_at: new Date().toISOString(),
    public_key_jwk: null,
    key_id: null,
    key_generated_at: null,
  };
  const selected = join(container, 'selected.json');
  const put = (path: string, value: unknown) => {
    writeFileSync(path, Buffer.isBuffer(value) ? value : JSON.stringify(value) + '\n', {
      mode: 0o600,
    });
  };
  put(registry, registryBytes);
  put(identity, identityValue);
  put(join(workspace, 'openslack.yaml'), config);
  put(selected, selectedValue);
  const args = () => [
    '--workspace',
    workspace,
    '--selected-bindings',
    selected,
    '--selected-bindings-sha256',
    sha(readFileSync(selected)),
  ];
  return {
    container,
    workspace,
    registry,
    identity,
    selected,
    selectedValue,
    identityValue,
    config,
    put,
    args,
  };
}
function invoke(args: string[]) {
  const result = spawnSync(process.execPath, [tool, ...args], {
    cwd: bundleRoot,
    encoding: 'utf8',
    timeout: 10_000,
    env: { PATH: process.env.PATH },
  });
  return { ...result, value: result.stdout.trim() ? JSON.parse(result.stdout) : undefined };
}
function faultScript(code: string, args: string[]) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code, tool, ...args], {
    cwd: bundleRoot,
    encoding: 'utf8',
    timeout: 10_000,
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

describe('standalone read-only fixed workspace acceptance', () => {
  it.each(
    [
      [],
      ['--workspace', '/missing'],
      ['--workspace', '/missing', '--selected-bindings', '/missing'],
      ['--workspace', '/missing', '--workspace', '/different'],
      ['--unknown', 'value'],
      ['--workspace', '/missing', '--now', '2099'],
    ].map((args) => ({ args })),
  )('rejects incomplete/duplicate/unknown option set $args', ({ args }) => {
    const result = invoke(args);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('WORKSPACE_ARGUMENT_INVALID');
  });

  it.each(['win32', 'darwin'])('refuses %s before filesystem access', (platform) => {
    const report = faultScript(
      `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { pathToFileURL } from 'node:url';
      const target=process.argv[1];process.argv[1]='fixture-driver.mjs';
      const mod=await import(pathToFileURL(target).href);
      let opens=0;
      fs.openSync=()=>{opens++; throw new Error('unexpected access');};
      syncBuiltinESMExports();
      Object.defineProperty(process,'platform',{value:${JSON.stringify(platform)}});
      const value=mod.verifyCleanupWorkspace({workspace:'/missing',selectedBindings:'/missing',selectedBindingsSHA256:'1'.repeat(64)});
      process.stdout.write(JSON.stringify({opens,value}));
    `,
      [],
    );
    expect(report.opens).toBe(0);
    expect(report.value.status).toBe('BLOCKED');
    expect(report.value.blockingIssues).toContainEqual({
      code: 'WORKSPACE_PLATFORM_UNSUPPORTED',
      role: 'platform',
    });
  });

  it.runIf(process.platform === 'linux')(
    'refuses root before reading selection or workspace',
    () => {
      const report = faultScript(
        `
      import fs from 'node:fs';
      import {syncBuiltinESMExports} from 'node:module';
      import {pathToFileURL} from 'node:url';
      const target=process.argv[1];process.argv[1]='fixture-driver.mjs';
      const mod=await import(pathToFileURL(target).href);
      let opens=0;
      process.getuid=()=>0;process.geteuid=()=>0;
      fs.openSync=()=>{opens++;throw new Error('unexpected access')};
      syncBuiltinESMExports();
      const value=mod.verifyCleanupWorkspace({workspace:'/missing',selectedBindings:'/missing',selectedBindingsSHA256:'1'.repeat(64)});
      process.stdout.write(JSON.stringify({opens,value}));
    `,
        [],
      );
      expect(report.opens).toBe(0);
      expect(report.value.blockingIssues).toContainEqual({
        code: 'WORKSPACE_OS_IDENTITY_MISMATCH',
        role: 'osIdentity',
      });
    },
  );

  it.runIf(process.platform === 'linux')(
    'parses real production identity/registry and authorizes a non-created record path without writes',
    () => {
      const value = fixture();
      const before = readdirSync(join(value.workspace, '.openslack'));
      const result = invoke(value.args());
      expect(result.status, result.stderr).toBe(0);
      expect(result.value).toMatchObject({
        schema: 'openslack.cleanup_workspace_observation.v1',
        status: 'PASS',
        scope: 'readonly-parsed-identity-and-path-evidence',
        identity: { state: 'MATCHED', runId: fixed.run_id },
        osIdentity: { matched: true },
        pathAuthorization: {
          decision: 'allow',
          immutableSnapshot: true,
          executionContextCreated: false,
        },
        outbox: { state: 'NOT_CREATED' },
        effects: {
          filesystemWrites: false,
          identityCreated: false,
          brokerQueried: false,
          approvalRecorded: false,
        },
      });
      expect(result.value.blockingIssues).toEqual([]);
      expect(readdirSync(join(value.workspace, '.openslack'))).toEqual(before);
      expect(existsSync(join(value.workspace, '.openslack/outbox'))).toBe(false);
      expect(readFileSync(value.identity)).toEqual(
        Buffer.from(JSON.stringify(value.identityValue) + '\n'),
      );
    },
  );

  it.runIf(process.platform === 'linux')(
    'accepts existing Agent-owned private record directories',
    () => {
      const value = fixture();
      for (const part of ['.openslack/outbox', '.openslack/outbox/cleanup-operations'])
        mkdirSync(join(value.workspace, part), { mode: 0o700 });
      const result = invoke(value.args());
      expect(result.status).toBe(0);
      expect(result.value.outbox.state).toBe('PRESENT');
      expect(readdirSync(join(value.workspace, '.openslack/outbox/cleanup-operations'))).toEqual(
        [],
      );
    },
  );

  it.runIf(process.platform === 'linux').each([
    ['run_id', 'unexpected-run'],
    ['agent_uid', 'unexpected-uid'],
    ['agent_id', 'unexpected-agent'],
    ['provider', 'github'],
    ['started_at', 'not-a-canonical-timestamp'],
  ])('refuses identity mutation %s without bootstrap', (field, replacement) => {
    const value = fixture();
    value.put(value.identity, { ...value.identityValue, [field]: replacement });
    const before = readFileSync(value.identity);
    const result = invoke(value.args());
    expect(result.status).toBe(2);
    expect(result.value.identity.state).not.toBe('MATCHED');
    expect(result.value.effects.identityCreated).toBe(false);
    expect(readFileSync(value.identity)).toEqual(before);
  });

  it.runIf(process.platform === 'linux')(
    'reports missing identity instead of generating another run',
    () => {
      const value = fixture();
      rmSync(value.identity);
      const result = invoke(value.args());
      expect(result.status).toBe(2);
      expect(result.value.blockingIssues).toContainEqual({
        code: 'WORKSPACE_IDENTITY_MISSING',
        role: 'identity',
      });
      expect(existsSync(value.identity)).toBe(false);
    },
  );

  it.runIf(process.platform === 'linux')(
    'refuses a different actual OS identity before opening the workspace',
    () => {
      const value = fixture();
      value.selectedValue.selected.agent_uid = String(process.getuid!() + 7);
      value.put(value.selected, value.selectedValue);
      const result = invoke(value.args());
      expect(result.status).toBe(2);
      expect(result.value.blockingIssues).toContainEqual({
        code: 'WORKSPACE_OS_IDENTITY_MISMATCH',
        role: 'osIdentity',
      });
      expect(result.value.identity.state).toBe('NOT_OBSERVED');
    },
  );

  it.runIf(process.platform === 'linux')(
    'refuses bytes differing from the historical selected registry and preserves deny precedence',
    () => {
      const value = fixture();
      const registry = JSON.parse(registryBytes.toString()) as {
        permissions: { paths: { deny: string[] } };
      };
      registry.permissions.paths.deny.push('.openslack/outbox/**');
      value.put(value.registry, registry);
      const result = invoke(value.args());
      expect(result.status).toBe(2);
      expect(result.value.pathAuthorization).toMatchObject({
        decision: 'deny',
        rule: 'path_denied',
      });
      expect(result.value.blockingIssues).toContainEqual({
        code: 'WORKSPACE_REGISTRY_BYTES_MISMATCH',
        role: 'registry',
      });
      expect(existsSync(join(value.workspace, '.openslack/outbox'))).toBe(false);
    },
  );

  it.runIf(process.platform === 'linux').each([
    ['workspace_id', 'wrong-workspace'],
    [
      'canonical_remote',
      { provider: 'github', owner: 'Other', repo: 'Repo', default_branch: 'main' },
    ],
    ['workspace', { root: '.', state_root: '../escape' }],
  ])('refuses workspace production config mutation %s', (field, replacement) => {
    const value = fixture();
    value.put(join(value.workspace, 'openslack.yaml'), { ...value.config, [field]: replacement });
    const result = invoke(value.args());
    expect(result.status).toBe(2);
    expect(
      result.value.blockingIssues.some((issue: { role: string }) => issue.role === 'workspace'),
    ).toBe(true);
  });

  it
    .runIf(process.platform === 'linux')
    .each(['workspace', '.openslack', '.openslack.local', '.openslack/outbox'])(
    'refuses writable/private-directory mismatch at %s',
    (part) => {
      const value = fixture();
      const path = part === 'workspace' ? value.workspace : join(value.workspace, part);
      if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
      chmodSync(path, 0o770);
      const result = invoke(value.args());
      expect(result.status).toBe(2);
      expect(
        result.value.blockingIssues.some(
          (issue: { code: string }) => issue.code === 'WORKSPACE_DIRECTORY_UNSAFE',
        ),
      ).toBe(true);
    },
  );

  it.runIf(process.platform === 'linux').each(['link', 'hardlink', 'fifo'])(
    'refuses %s identity without hanging or reading alternate data',
    (kind) => {
      const value = fixture();
      const ordinary = join(value.container, 'identity-source.json');
      value.put(ordinary, value.identityValue);
      rmSync(value.identity);
      if (kind === 'link') symlinkSync(ordinary, value.identity);
      else if (kind === 'hardlink') linkSync(ordinary, value.identity);
      else execFileSync('mkfifo', [value.identity]);
      const result = invoke(value.args());
      expect(result.status).toBe(2);
      expect(result.value.identity.state).not.toBe('MATCHED');
    },
  );

  it.runIf(process.platform === 'linux')(
    'refuses a symlink parent with no changes to the linked directory',
    () => {
      const value = fixture();
      const old = join(value.workspace, '.openslack/agents');
      const other = join(value.container, 'external');
      mkdirSync(other, { mode: 0o700 });
      rmSync(old, { recursive: true });
      symlinkSync(other, old);
      const result = invoke(value.args());
      expect(result.status).toBe(2);
      expect(readdirSync(other)).toEqual([]);
    },
  );

  it.runIf(process.platform === 'linux')(
    'rejects selected-source digest conflicts and duplicate JSON keys before workspace reads',
    () => {
      const value = fixture();
      const wrong = value.args();
      wrong[5] = '0'.repeat(64);
      const digest = invoke(wrong);
      expect(digest.status).toBe(2);
      expect(digest.value.blockingIssues).toContainEqual({
        code: 'WORKSPACE_SELECTION_DIGEST_MISMATCH',
        role: 'selection',
      });
      value.put(value.selected, Buffer.from('{"schema":"x","schema":"y"}'));
      const duplicate = invoke(value.args());
      expect(duplicate.status).toBe(2);
      expect(duplicate.value.blockingIssues).toContainEqual({
        code: 'WORKSPACE_SELECTION_INVALID',
        role: 'selection',
      });
    },
  );

  it.runIf(process.platform === 'linux').each(['inode', 'parent'])(
    'refuses identity %s replacement during descriptor reads',
    (kind) => {
      const value = fixture();
      const report = faultScript(
        `
      import fs from 'node:fs';
      import {syncBuiltinESMExports} from 'node:module';
      import {pathToFileURL} from 'node:url';
      import {dirname} from 'node:path';
      const target=process.argv[1];process.argv[1]='fixture-driver.mjs';
      const mod=await import(pathToFileURL(target).href);
      const real=fs.readSync;
      let changed=false;
      const identity=${JSON.stringify(value.identity)};
      fs.readSync=(fd,...args)=>{
        if(!changed && fs.readlinkSync('/proc/self/fd/'+fd)===identity){
          changed=true;
          const raw=fs.readFileSync(identity);
          if(${JSON.stringify(kind)}==='inode')fs.renameSync(identity,identity+'.owned-original');
          else {fs.renameSync(dirname(identity),dirname(identity)+'.owned-original');fs.mkdirSync(dirname(identity),{mode:0o700});}
          fs.writeFileSync(identity,raw,{mode:0o600});
        }
        return real(fd,...args);
      };
      syncBuiltinESMExports();
      const result=mod.verifyCleanupWorkspace(mod.parseVerifyWorkspaceArguments(process.argv.slice(2)));
      process.stdout.write(JSON.stringify({changed,result}));
    `,
        value.args(),
      );
      expect(report.changed).toBe(true);
      expect(report.result.status).toBe('BLOCKED');
      expect(report.result.blockingIssues).toContainEqual({
        code: 'WORKSPACE_FILE_CHANGED',
        role: 'identity',
      });
      expect(report.result.effects.executionContextCreated).toBe(false);
    },
  );

  it.runIf(process.platform === 'linux').each([5, 20, 50])(
    'closes all directory descriptors after failing fstat %s',
    (failureAt) => {
      const value = fixture();
      const report = faultScript(
        `
      import fs from 'node:fs';
      import {syncBuiltinESMExports} from 'node:module';
      import {pathToFileURL} from 'node:url';
      const target=process.argv[1];process.argv[1]='fixture-driver.mjs';
      const mod=await import(pathToFileURL(target).href);
      const real=fs.fstatSync;
      const before=fs.readdirSync('/proc/self/fd').length;
      let n=0;
      fs.fstatSync=(...args)=>{if(++n===${failureAt})throw new Error('fixture fstat fault');return real(...args)};
      syncBuiltinESMExports();
      const input=mod.parseVerifyWorkspaceArguments(process.argv.slice(2));
      const value=mod.verifyCleanupWorkspace(input);
      fs.fstatSync=real;syncBuiltinESMExports();
      const after=fs.readdirSync('/proc/self/fd').length;
      process.stdout.write(JSON.stringify({before,after,value}));
    `,
        value.args(),
      );
      expect(report.value.status).toBe('BLOCKED');
      expect(report.after).toBe(report.before);
    },
  );
});
