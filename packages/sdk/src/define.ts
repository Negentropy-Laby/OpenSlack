import type {
  BundledActionContribution,
  BundledPluginDefinition,
  BundledPrmsBlockerContribution,
  BundledPrmsBlockerDefinition,
  BundledWorkflowContribution,
  DeclarativeActionAliasV1,
  DeclarativeWorkflowAliasV1,
  HostPlanStep,
  PluginManifestV1,
} from '@openslack/plugin-api';

type NoExtraProperties<TShape, TValue extends TShape> = TValue &
  Record<Exclude<keyof TValue, keyof TShape>, never>;

type NormalizeBundledContribution<TContribution> =
  TContribution extends BundledPrmsBlockerDefinition<infer TPrmsReport>
    ? BundledPrmsBlockerContribution<TPrmsReport>
    : TContribution;

type DefinedBundledPlugin<TPlugin extends BundledPluginDefinition<unknown, unknown, unknown>> =
  Omit<TPlugin, 'contributions'> & {
    readonly contributions: {
      readonly [TIndex in keyof TPlugin['contributions']]: NormalizeBundledContribution<
        TPlugin['contributions'][TIndex]
      >;
    };
  };

export function defineManifest<const TManifest extends PluginManifestV1>(
  manifest: NoExtraProperties<PluginManifestV1, TManifest>,
): TManifest {
  return manifest;
}

export function defineBundledPlugin<
  TPlanStep = HostPlanStep,
  TWorkflow = unknown,
  TPrmsReport = unknown,
  const TPlugin extends BundledPluginDefinition<TPlanStep, TWorkflow, TPrmsReport> =
    BundledPluginDefinition<TPlanStep, TWorkflow, TPrmsReport>,
>(plugin: TPlugin): DefinedBundledPlugin<TPlugin> {
  const contributions = plugin.contributions.map((contribution) =>
    contribution.kind === 'prms_blocker' ? definePrmsBlocker(contribution) : contribution,
  );

  return {
    ...plugin,
    contributions: Object.freeze(contributions),
  } as DefinedBundledPlugin<TPlugin>;
}

export function defineActionAlias<const TAlias extends DeclarativeActionAliasV1>(
  alias: NoExtraProperties<DeclarativeActionAliasV1, TAlias>,
): TAlias {
  return alias;
}

export function defineWorkflowAlias<const TAlias extends DeclarativeWorkflowAliasV1>(
  alias: NoExtraProperties<DeclarativeWorkflowAliasV1, TAlias>,
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

export function definePrmsBlocker<TPrmsReport = unknown>(
  contribution: BundledPrmsBlockerDefinition<TPrmsReport>,
): BundledPrmsBlockerContribution<TPrmsReport> {
  return {
    kind: 'prms_blocker',
    id: contribution.id,
    async evaluate(report, context) {
      const result = await contribution.evaluate(report, context);
      return { blockers: result.blockers };
    },
  } as BundledPrmsBlockerContribution<TPrmsReport>;
}
