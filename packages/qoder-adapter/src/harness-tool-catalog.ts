import { getOpenSlackToolCatalog } from './tool-catalog.js';
import type { OpenSlackReadToolName, OpenSlackMutationToolName } from './tool-catalog.js';

// A reviewed subset, deliberately independent of future additions to the host.
// Definitions and schemas still come from the host's canonical catalog.
const reads = Object.freeze([
  'openslack_get_executive_overview', 'openslack_list_work_items', 'openslack_get_work_room', 'openslack_get_activity',
  'openslack_get_workflow_progress', 'openslack_get_pr_readiness', 'openslack_list_pending_approvals', 'openslack_get_business_outcomes',
  'openslack_get_notification_status', 'openslack_list_scenarios', 'openslack_query_graph', 'openslack_explain_graph',
] as const satisfies readonly OpenSlackReadToolName[]);
const mutations = Object.freeze(['openslack_preview_scenario', 'openslack_preview_workflow', 'openslack_confirm_plan', 'openslack_cancel_plan'] as const satisfies readonly OpenSlackMutationToolName[]);

/** Host-owned metadata only; this leaf contains no transport or execution authority. */
export function getReviewedHarnessToolCatalog(mode: 'read-only' | 'task') {
  const catalog = getOpenSlackToolCatalog({ includeDemoReset: false, includeGovernedMutations: mode === 'task' });
  const names: readonly string[] = mode === 'task' ? [...reads, ...mutations] : reads;
  return Object.freeze(names.map(name => {
    const selected = catalog.find(tool => tool.name === name);
    if (!selected) throw new TypeError('Reviewed Harness tool is absent from the canonical catalog');
    return selected;
  }));
}
