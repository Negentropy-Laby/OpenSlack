import { sanitizeTerminalText } from '../sanitize.js';

export interface StatusViewModel {
  title: string;
  version: string;
  mode: 'SOURCE_CHECKOUT' | 'WORKSPACE';
  commit: string;
  commitSubject: string;
  modules: Array<{
    name: string;
    lifecycle: string;
    maturity: string;
    operatorConfigured: boolean;
    externalBlockers: string[];
    evidenceRefs: string[];
    tests: number | null;
    components: Array<{
      name: string;
      maturity: string;
      operatorConfigured: boolean;
      externalBlockers: string[];
      evidenceRefs: string[];
    }>;
  }>;
  deferredWork: Array<{
    name: string;
    maturity: string;
    branch: string | null;
    evidenceRefs: string[];
    countedTowardStandalone: false;
  }>;
  gitHub: {
    available: boolean;
    tasksReady: number;
    tasksClaimed: number;
    tasksBlocked: number;
    prsOpen: number;
    prsBlocked: number;
    prsReady: number;
  };
  testSuite: {
    totalTests: number;
    totalFiles: number;
  };
  recommendations: Array<{
    title: string;
    action: string;
    command: string | null;
  }>;
  attentionItems: Array<{
    type: string;
    description: string;
    action: string;
    priority: 'high' | 'medium' | 'low';
  }>;
  nextAction: string;
}

export function mapStatusToViewModel(data: {
  mode: 'SOURCE_CHECKOUT' | 'WORKSPACE';
  commit: string;
  commitSubject: string;
  modules: Array<{
    name: string;
    lifecycle: string;
    maturity: string;
    operatorConfigured: boolean;
    externalBlockers: string[];
    evidenceRefs: string[];
    tests?: number;
    components?: Array<{
      name: string;
      maturity: string;
      operatorConfigured: boolean;
      externalBlockers: string[];
      evidenceRefs: string[];
    }>;
  }>;
  deferredWork: Array<{
    name: string;
    maturity: string;
    branch?: string;
    evidenceRefs: string[];
    countedTowardStandalone: false;
  }>;
  gitHub: {
    available: boolean;
    tasksReady: number;
    tasksClaimed: number;
    tasksBlocked: number;
    prsOpen: number;
    prsBlocked: number;
    prsReady: number;
  };
  testSuite: { totalTests: number; totalFiles: number };
  recommendations: Array<{ title: string; action: string; command?: string }>;
  attentionItems: Array<{
    type: string;
    description: string;
    action: string;
    priority: 'high' | 'medium' | 'low';
  }>;
  nextAction: string;
}): StatusViewModel {
  const s = sanitizeTerminalText;

  return {
    title: 'OpenSlack Status',
    version: 'v0.1 Developer Preview',
    mode: data.mode,
    commit: s(data.commit),
    commitSubject: s(data.commitSubject),
    modules: data.modules.map((m) => ({
      name: s(m.name),
      lifecycle: s(m.lifecycle),
      maturity: s(m.maturity),
      operatorConfigured: m.operatorConfigured,
      externalBlockers: m.externalBlockers.map(s),
      evidenceRefs: m.evidenceRefs.map(s),
      tests: m.tests ?? null,
      components: (m.components ?? []).map((component) => ({
        name: s(component.name),
        maturity: s(component.maturity),
        operatorConfigured: component.operatorConfigured,
        externalBlockers: component.externalBlockers.map(s),
        evidenceRefs: component.evidenceRefs.map(s),
      })),
    })),
    deferredWork: data.deferredWork.map((item) => ({
      name: s(item.name),
      maturity: s(item.maturity),
      branch: item.branch ? s(item.branch) : null,
      evidenceRefs: item.evidenceRefs.map(s),
      countedTowardStandalone: false,
    })),
    gitHub: data.gitHub,
    testSuite: data.testSuite,
    recommendations: data.recommendations.map((r) => ({
      title: s(r.title),
      action: s(r.action),
      command: r.command ? s(r.command) : null,
    })),
    attentionItems: data.attentionItems.map((a) => ({
      type: s(a.type),
      description: s(a.description),
      action: s(a.action),
      priority: a.priority,
    })),
    nextAction: s(data.nextAction),
  };
}
