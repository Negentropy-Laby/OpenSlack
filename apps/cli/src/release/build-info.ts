declare const __OPENSLACK_BUILD_VERSION__: string;
declare const __OPENSLACK_BUILD_COMMIT__: string;
declare const __OPENSLACK_BUILD_CHANNEL__: string;
declare const __OPENSLACK_BUILD_TARGET__: string;
declare const __OPENSLACK_ARTIFACT_FORMAT__: string;

export interface OpenSlackBuildInfo {
  schema: 'openslack.build_info.v1';
  version: string;
  commit: string;
  channel: string;
  target: string;
  runtime: string;
  artifactFormat: string;
  workspaceSchemaCompatibility: { min: 1; max: 1 };
  stateSchemaCompatibility: string[];
}

export function getBuildInfo(): OpenSlackBuildInfo {
  const bunRuntime = (globalThis as { Bun?: { version?: string } }).Bun?.version;
  return {
    schema: 'openslack.build_info.v1',
    version: injected('__OPENSLACK_BUILD_VERSION__', () => __OPENSLACK_BUILD_VERSION__) ?? '0.1.1',
    commit: injected('__OPENSLACK_BUILD_COMMIT__', () => __OPENSLACK_BUILD_COMMIT__) ?? 'development',
    channel: injected('__OPENSLACK_BUILD_CHANNEL__', () => __OPENSLACK_BUILD_CHANNEL__) ?? 'source',
    target:
      injected('__OPENSLACK_BUILD_TARGET__', () => __OPENSLACK_BUILD_TARGET__) ??
      `${process.platform}-${process.arch}`,
    runtime: bunRuntime ? `bun-${bunRuntime}` : `node-${process.versions.node}`,
    artifactFormat:
      injected('__OPENSLACK_ARTIFACT_FORMAT__', () => __OPENSLACK_ARTIFACT_FORMAT__) ?? 'source',
    workspaceSchemaCompatibility: { min: 1, max: 1 },
    stateSchemaCompatibility: [
      'openslack.onboarding.v1',
      'openslack.github_app_local.v1',
      'openslack.agent_runtime.v1',
    ],
  };
}

function injected(_name: string, read: () => string): string | undefined {
  try {
    const value = read();
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}
