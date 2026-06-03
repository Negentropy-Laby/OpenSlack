import React from 'react';
import { renderTui } from '../render.js';
import AgentRuntimeDiagnosticsView from './AgentRuntimeDiagnosticsView.js';
import type { AgentRuntimeDiagnosticsViewModel } from '../view-models/agent-runtime.js';

export async function renderAgentRuntimeDiagnosticsTui(
  model: AgentRuntimeDiagnosticsViewModel,
): Promise<void> {
  await renderTui(React.createElement(AgentRuntimeDiagnosticsView, { model }));
}
