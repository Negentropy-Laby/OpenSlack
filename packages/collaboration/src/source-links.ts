export function buildSourceLink(kind: string, id: string): string | undefined {
  const repo = process.env.OPENSLACK_REPO || 'Negentropy-Laby/OpenSlack';

  switch (kind) {
    case 'issue':
      return `https://github.com/${repo}/issues/${id}`;
    case 'pr':
      return `https://github.com/${repo}/pull/${id}`;
    case 'plan':
      return `.openslack.local/chat/plans/${id}.json`;
    case 'module':
      return `.openslack/modules.yaml`;
    case 'handoff':
      return `.openslack/collaboration/handoffs/${id}.yaml`;
    case 'decision':
      return `.openslack/collaboration/decisions/${id}.yaml`;
    case 'workspace':
      return `.openslack/`;
    default:
      return undefined;
  }
}
