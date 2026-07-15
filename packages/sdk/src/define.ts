import type {
  BundledActionContribution,
  BundledPluginDefinition,
  BundledPrmsBlockerContribution,
  BundledWorkflowContribution,
  DeclarativeActionAliasV1,
  DeclarativeWorkflowAliasV1,
  HostPlanStep,
  PluginManifestV1,
} from '@openslack/plugin-api';

export function defineManifest<const TManifest extends PluginManifestV1>(
  manifest: TManifest,
): TManifest {
  return manifest;
}

export function defineBundledPlugin<
  TPlanStep = HostPlanStep,
  TWorkflow = unknown,
  TPrmsReport = unknown,
  const TPlugin extends BundledPluginDefinition<TPlanStep, TWorkflow, TPrmsReport> =
    BundledPluginDefinition<TPlanStep, TWorkflow, TPrmsReport>,
>(plugin: TPlugin): TPlugin {
  return plugin;
}

export function defineActionAlias<const TAlias extends DeclarativeActionAliasV1>(
  alias: TAlias,
): TAlias {
  return alias;
}

export function defineWorkflowAlias<const TAlias extends DeclarativeWorkflowAliasV1>(
  alias: TAlias,
): TAlias {
  return alias;
}

export function defineBundledAction<
  TPlanStep = HostPlanStep,
  const TContribution extends BundledActionContribution<TPlanStep> =
    BundledActionContribution<TPlanStep>,
>(contribution: TContribution): TContribution {
  return contribution;
}

export function defineBundledWorkflow<
  TWorkflow = unknown,
  const TContribution extends BundledWorkflowContribution<TWorkflow> =
    BundledWorkflowContribution<TWorkflow>,
>(contribution: TContribution): TContribution {
  return contribution;
}

export function definePrmsBlocker<
  TPrmsReport = unknown,
  const TContribution extends BundledPrmsBlockerContribution<TPrmsReport> =
    BundledPrmsBlockerContribution<TPrmsReport>,
>(contribution: TContribution): TContribution {
  return contribution;
}
