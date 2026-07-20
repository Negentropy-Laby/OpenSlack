import { getClient } from './client.js';

export interface IssueTask {
  issueNumber: number;
  issueNodeId: string;
  title: string;
  url: string;
  labels: string[];
  body: string;
  taskManifest?: IssueTaskManifest;
}

export interface IssueTaskManifest {
  taskId?: string;
  agentType?: string;
  riskLevel?: string;
  requiredCapabilities?: string[];
  allowedPaths?: string[];
  forbiddenPaths?: string[];
  outputContract?: string[];
}

export async function createTaskIssue(
  title: string,
  body: string,
  labels: string[],
): Promise<{ issueNumber: number; url: string; nodeId: string; id?: number }> {
  const client = await getClient();
  if (client.isDryRun) {
    console.log(`[DRY RUN] Would create task issue: "${title}" with labels: ${labels.join(',')}`);
    return { issueNumber: 0, url: '', nodeId: '' };
  }

  const { data } = await client.octokit.issues.create({
    owner: client.owner,
    repo: client.repo,
    title,
    body,
    labels,
  });

  return {
    issueNumber: data.number,
    url: data.html_url,
    nodeId: data.node_id,
    id: data.id,
  };
}

export async function queryReadyIssueTasks(
  options: {
    agentType?: string;
    capabilities?: string[];
    maxRisk?: string;
  } = {},
): Promise<IssueTask[]> {
  const client = await getClient();
  if (client.isDryRun) {
    console.log('[DRY RUN] Would query ready issue tasks');
    return [];
  }

  // Search for issues with openslack:task AND openslack:ready labels
  const q = [
    `repo:${client.owner}/${client.repo}`,
    'is:issue',
    'is:open',
    'label:openslack:task',
    'label:openslack:ready',
  ].join(' ');

  const { data } = await client.octokit.search.issuesAndPullRequests({
    q,
    per_page: 20,
    sort: 'created',
    order: 'asc',
  });

  const tasks: IssueTask[] = data.items.map((item) => ({
    issueNumber: item.number,
    issueNodeId: item.node_id,
    title: item.title,
    url: item.html_url,
    labels: item.labels.map((l: string | { name?: string }) =>
      typeof l === 'string' ? l : l.name || '',
    ),
    body: item.body || '',
  }));

  // Local filter: agent type, capabilities, risk level
  return tasks.filter((t) => {
    if (options.agentType && t.labels.includes(`agent-type:${options.agentType}`) === false) {
      // If issue doesn't specify agent type, it matches any
      const hasTypeLabel = t.labels.some((l) => l.startsWith('agent-type:'));
      if (hasTypeLabel) return false;
    }
    if (options.maxRisk) {
      const riskOrder = ['low', 'medium', 'high', 'critical'];
      const taskRisk = t.labels.find((l) => l.startsWith('risk:'))?.replace('risk:', '') || 'low';
      if (riskOrder.indexOf(taskRisk) > riskOrder.indexOf(options.maxRisk)) return false;
    }
    if (options.capabilities?.length) {
      // Not filterable by labels alone — accept all, let agent self-filter
    }
    return true;
  });
}

export function parseTaskManifest(body: string): IssueTaskManifest | undefined {
  const match = body.match(/^```yaml\s*\n\s*([\s\S]*?)\s*\n```/m);
  if (!match) return undefined;
  try {
    const lines = match[1].split('\n');
    const manifest: Record<string, unknown> = {};
    let currentList: string[] | null = null;
    let currentListKey = '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('- ')) {
        if (currentList !== null) currentList.push(trimmed.slice(2).trim());
        continue;
      }
      currentList = null;
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx === -1) continue;
      const key = trimmed.slice(0, colonIdx).trim();
      const value = trimmed
        .slice(colonIdx + 1)
        .trim()
        .replace(/^["']|["']$/g, '');
      if (value === '') {
        currentList = [];
        currentListKey = key;
        manifest[key] = currentList;
      } else {
        manifest[key] = value;
      }
    }

    return {
      taskId: manifest.task_id as string | undefined,
      agentType: manifest.agent_type as string | undefined,
      riskLevel: manifest.risk_level as string | undefined,
      requiredCapabilities: manifest.required_capabilities as string[] | undefined,
      allowedPaths: manifest.allowed_paths as string[] | undefined,
      forbiddenPaths: manifest.forbidden_paths as string[] | undefined,
      outputContract: manifest.output_contract as string[] | undefined,
    };
  } catch {
    return undefined;
  }
}

export function buildTaskManifestYaml(manifest: IssueTaskManifest): string {
  const lines: string[] = [];
  if (manifest.taskId) lines.push(`task_id: ${manifest.taskId}`);
  if (manifest.agentType) lines.push(`agent_type: ${manifest.agentType}`);
  if (manifest.riskLevel) lines.push(`risk_level: ${manifest.riskLevel}`);
  if (manifest.requiredCapabilities?.length) {
    lines.push('required_capabilities:');
    for (const c of manifest.requiredCapabilities) lines.push(`  - ${c}`);
  }
  if (manifest.allowedPaths?.length) {
    lines.push('allowed_paths:');
    for (const p of manifest.allowedPaths) lines.push(`  - ${p}`);
  }
  if (manifest.forbiddenPaths?.length) {
    lines.push('forbidden_paths:');
    for (const p of manifest.forbiddenPaths) lines.push(`  - ${p}`);
  }
  if (manifest.outputContract?.length) {
    lines.push('output_contract:');
    for (const o of manifest.outputContract) lines.push(`  - ${o}`);
  }
  return lines.join('\n');
}
