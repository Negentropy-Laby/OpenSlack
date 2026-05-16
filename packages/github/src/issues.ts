import type { GitHubClient } from './client.js';
import { getClient } from './client.js';

export interface CreateIssueResult {
  url: string;
  number: number;
  nodeId: string;
}

export async function createIssue(
  title: string,
  body: string,
  labels: string[] = [],
): Promise<CreateIssueResult> {
  const client = await getClient();
  if (client.isDryRun) {
    const dryResult = {
      url: `https://github.com/${client.owner}/${client.repo}/issues/DRY_RUN`,
      number: 0,
      nodeId: 'DRY_RUN',
    };
    console.log(`[DRY RUN] Would create issue in ${client.owner}/${client.repo}: "${title}"`);
    return dryResult;
  }

  const { data } = await client.octokit.issues.create({
    owner: client.owner,
    repo: client.repo,
    title,
    body,
    labels,
  });

  return {
    url: data.html_url,
    number: data.number,
    nodeId: data.node_id,
  };
}

export interface ProjectItemResult {
  projectItemId: string;
}

export async function addIssueToProject(
  projectNodeId: string,
  issueNodeId: string,
): Promise<ProjectItemResult> {
  const client = await getClient();
  if (client.isDryRun) {
    console.log(`[DRY RUN] Would add issue ${issueNodeId} to project ${projectNodeId}`);
    return { projectItemId: 'DRY_RUN' };
  }

  const response = await client.octokit.graphql<{
    addProjectV2ItemById: { item: { id: string } };
  }>(
    `mutation($projectId: ID!, $contentId: ID!) {
      addProjectV2ItemById(input: {
        projectId: $projectId,
        contentId: $contentId
      }) {
        item { id }
      }
    }`,
    { projectId: projectNodeId, contentId: issueNodeId },
  );

  return { projectItemId: response.addProjectV2ItemById.item.id };
}

export interface ReadyTask {
  issueNodeId: string;
  projectItemId: string;
  title: string;
  number: number;
  url: string;
  status: string;
  riskLevel: string;
  priority: string;
  requiredAgentType: string;
}

export async function queryReadyItems(
  projectNodeId: string,
  agentType?: string,
): Promise<ReadyTask[]> {
  const client = await getClient();
  if (client.isDryRun) {
    console.log(`[DRY RUN] Would query Ready items from project ${projectNodeId}`);
    return [];
  }

  // First find the status field ID
  const response = await client.octokit.graphql<{
    node: {
      fields: {
        nodes: Array<{ id: string; name: string; options?: Array<{ id: string; name: string }> }>;
      };
    };
  }>(
    `query($projectId: ID!) {
      node(id: $projectId) {
        ... on ProjectV2 {
          fields(first: 20) {
            nodes {
              ... on ProjectV2SingleSelectField { id name options { id name } }
              ... on ProjectV2Field { id name }
            }
          }
        }
      }
    }`,
    { projectId: projectNodeId },
  );

  const statusField = response.node.fields.nodes.find(
    (f) => 'name' in f && f.name === 'OpenSlack Status',
  );
  const readyOption = statusField?.options?.find((o: { name: string }) => o.name === 'Ready');

  if (!statusField || !readyOption) {
    console.log('[WARN] No OpenSlack Status field with Ready option found on project');
    return [];
  }

  // Query items filtered by Ready status
  const itemsResponse = await client.octokit.graphql<{
    node: {
      items: {
        nodes: Array<{
          id: string;
          content: { id: string; title: string; number: number; url: string };
          fieldValues: {
            nodes: Array<{
              field: { name: string };
              name?: string;
              text?: string;
            }>;
          };
        }>;
      };
    };
  }>(
    `query($projectId: ID!, $statusFieldId: ID!, $readyId: String!) {
      node(id: $projectId) {
        ... on ProjectV2 {
          items(first: 20, filter: {fieldId: $statusFieldId, singleSelectOptionId: $readyId}) {
            nodes {
              id
              content { ... on Issue { id title number url } }
              fieldValues(first: 20) {
                nodes {
                  ... on ProjectV2ItemFieldSingleSelectValue { field { ... on ProjectV2FieldCommon { name } } name }
                  ... on ProjectV2ItemFieldTextValue { field { ... on ProjectV2FieldCommon { name } } text }
                }
              }
            }
          }
        }
      }
    }`,
    {
      projectId: projectNodeId,
      statusFieldId: statusField.id,
      readyId: readyOption.id,
    },
  );

  return itemsResponse.node.items.nodes.map((item: {
    id: string;
    content: { id: string; title: string; number: number; url: string };
    fieldValues: {
      nodes: Array<{
        field: { name: string };
        name?: string;
        text?: string;
      }>;
    };
  }) => {
    const fields: Record<string, string> = {};
    for (const fv of item.fieldValues.nodes) {
      if ('name' in fv) fields[fv.field.name] = fv.name || '';
      if ('text' in fv) fields[fv.field.name] = fv.text || '';
    }
    return {
      issueNodeId: item.content.id,
      projectItemId: item.id,
      title: item.content.title,
      number: item.content.number,
      url: item.content.url,
      status: fields['OpenSlack Status'] || 'Ready',
      riskLevel: fields['Risk Level'] || 'medium',
      priority: fields['Priority'] || 'p2',
      requiredAgentType: fields['Required Agent Type'] || '',
    };
  });
}

export async function updateProjectField(
  projectId: string,
  projectItemId: string,
  fieldId: string,
  value: string,
  fieldType: 'text' | 'single_select' = 'text',
): Promise<void> {
  const client = await getClient();
  if (client.isDryRun) {
    console.log(`[DRY RUN] Would update field ${fieldId} on item ${projectItemId} to "${value}"`);
    return;
  }

  const valueInput = fieldType === 'single_select'
    ? `singleSelectOptionId: "${value}"`
    : `text: "${value}"`;

  await client.octokit.graphql(
    `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId,
        itemId: $itemId,
        fieldId: $fieldId,
        value: { ${valueInput} }
      }) {
        projectV2Item { id }
      }
    }`,
    { projectId, itemId: projectItemId, fieldId },
  );
}
