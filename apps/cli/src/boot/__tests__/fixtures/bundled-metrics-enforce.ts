import type {
  BundledActionContribution,
  BundledActivationEvidence,
  BundledPluginDefinition,
  HostPlanStep,
} from '@openslack/plugin-api';
import type { ReviewedBundledPluginRegistration } from '@openslack/plugin-host';
import { defineBundledAction, defineBundledPlugin } from '@openslack/sdk';

export const BUNDLED_METRICS_FIXTURE_ID = 'metrics-enforce';
export const BUNDLED_METRICS_FIXTURE_ACTION_ID = 'ready-count';

export interface BundledMetricsFixture {
  readonly registration: ReviewedBundledPluginRegistration;
  readonly evidence: BundledActivationEvidence;
}

export function createBundledMetricsFixture(
  buildPlanStep: BundledActionContribution<HostPlanStep>['buildPlanStep'] = () => ({
    id: 'metrics-enforce.ready-count',
    actionId: 'github.metrics',
    input: {},
  }),
  activate?: BundledPluginDefinition<HostPlanStep>['activate'],
): BundledMetricsFixture {
  const evidence: BundledActivationEvidence = Object.freeze({
    schema: 'openslack.plugin_activation_evidence.v1',
    plugin: Object.freeze({ id: BUNDLED_METRICS_FIXTURE_ID, version: '1.0.0' }),
    observedAt: '2026-07-16T00:00:00.000Z',
    actor: Object.freeze({
      id: 'p2-pr3-composition-test',
      kind: 'application',
      provider: 'openslack',
    }),
    humanApproval: Object.freeze({
      required: false,
      satisfied: false,
      evidenceRefs: Object.freeze([]),
    }),
    providerKind: 'bundled',
    source: Object.freeze({
      kind: 'bundled',
      compositionId: 'openslack.cli',
      reviewEvidenceRefs: Object.freeze(['test-review:metrics-enforce']),
    }),
  });

  const action = defineBundledAction({
    kind: 'bundled_action',
    id: BUNDLED_METRICS_FIXTURE_ACTION_ID,
    target: { kind: 'host_action', id: 'github.metrics' },
    buildPlanStep,
  });
  const definition = defineBundledPlugin({
    providerKind: 'bundled',
    id: BUNDLED_METRICS_FIXTURE_ID,
    version: '1.0.0',
    name: 'Bundled metrics enforce fixture',
    description: 'A reviewed in-process proof that routes only to github.metrics.',
    requires: { openslack: '>=0.1.1 <1.0.0' },
    gate: { mode: 'ENFORCE', gateId: 'host.bundled' },
    requestedCapabilities: ['host.actions.plan', 'github.issues.read'],
    contributions: [action],
    ...(activate ? { activate } : {}),
  });

  return Object.freeze({
    registration: Object.freeze({ definition, evidence }),
    evidence,
  });
}
