import { Command } from 'commander';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  createThread,
  listThreads,
  getThread,
  appendMessage,
  archiveThread,
  renderMessage,
} from '@openslack/collaboration';
import type { ConversationStatus } from '@openslack/collaboration';

function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, 'openslack.yaml'))) return dir;
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export function conversationCommands(): Command {
  const cmd = new Command('conversation').description('Conversation thread management');

  cmd
    .command('start')
    .description('Create a new conversation thread')
    .requiredOption('--title <string>', 'Thread title')
    .option('--pr <number>', 'Link to PR number')
    .option('--issue <number>', 'Link to issue number')
    .option('--workflow <string>', 'Link to workflow run ID')
    .action((options: { title: string; pr?: string; issue?: string; workflow?: string }) => {
      const rootDir = findRepoRoot();
      const linkedObjects: Array<{ kind: 'pr' | 'issue' | 'workflow_run'; id: string }> = [];
      if (options.pr) linkedObjects.push({ kind: 'pr', id: options.pr });
      if (options.issue) linkedObjects.push({ kind: 'issue', id: options.issue });
      if (options.workflow) linkedObjects.push({ kind: 'workflow_run', id: options.workflow });

      const thread = createThread({
        title: options.title,
        linkedObjects: linkedObjects.length > 0 ? linkedObjects : undefined,
        rootDir,
      });
      console.log(`Created thread: ${thread.id}`);
      console.log(`Title: ${thread.title}`);
      console.log(`Status: ${thread.status}`);
    });

  cmd
    .command('list')
    .description('List conversation threads')
    .option('--status <status>', 'Filter by status: open, active, paused, completed, archived')
    .action((options: { status?: string }) => {
      const validStatuses: ConversationStatus[] = [
        'open',
        'active',
        'paused',
        'completed',
        'archived',
      ];
      const filterStatus =
        options.status && validStatuses.includes(options.status as ConversationStatus)
          ? (options.status as ConversationStatus)
          : undefined;

      const threads = listThreads(
        filterStatus
          ? { status: filterStatus, rootDir: findRepoRoot() }
          : { rootDir: findRepoRoot() },
      );

      if (threads.length === 0) {
        console.log('No conversation threads found.');
        return;
      }

      console.log('| Thread ID | Title | Participants | Last Activity | Status |');
      console.log('|-----------|-------|-------------|---------------|--------|');
      for (const t of threads) {
        const title = t.title.length > 30 ? t.title.slice(0, 27) + '...' : t.title;
        const lastActivity = new Date(t.updatedAt).toLocaleDateString();
        console.log(
          `| ${t.id} | ${title} | ${t.participants.length} | ${lastActivity} | ${t.status} |`,
        );
      }
    });

  cmd
    .command('show <threadId>')
    .description('Show conversation thread with messages')
    .action((threadId: string) => {
      try {
        const rootDir = findRepoRoot();
        const result = getThread(threadId, rootDir);
        if (!result) {
          console.log(`Thread ${threadId} not found.`);
          process.exit(1);
        }

        const { thread, messages } = result;

        console.log(`Thread: ${thread.title}`);
        console.log(`ID: ${thread.id}`);
        console.log(`Status: ${thread.status}`);
        console.log(`Created: ${new Date(thread.createdAt).toLocaleString()}`);
        console.log(`Updated: ${new Date(thread.updatedAt).toLocaleString()}`);
        if (thread.participants.length > 0) {
          console.log(
            `Participants: ${thread.participants.map((p) => p.displayName || p.id).join(', ')}`,
          );
        }
        if (thread.linkedObjects.length > 0) {
          console.log(`Linked: ${thread.linkedObjects.map((o) => `${o.kind}:${o.id}`).join(', ')}`);
        }
        console.log('');

        if (messages.length === 0) {
          console.log('No messages yet.');
          return;
        }

        console.log('Messages:');
        for (const msg of messages) {
          console.log(`  ${renderMessage(msg)}`);
        }
      } catch (err) {
        console.log((err as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command('send <threadId> <message>')
    .description('Send a user message to a thread. Use @agent-id to dispatch a subagent.')
    .action(async (threadId: string, message: string) => {
      try {
        const rootDir = findRepoRoot();

        // Phase AR: Check for @agent-id mention pattern
        const mentionMatch = message.match(/^@(\S+)\s+(.+)$/);
        if (mentionMatch) {
          const agentId = mentionMatch[1];
          const prompt = mentionMatch[2];

          // Resolve agent
          const { resolveAgentType } = await import('@openslack/workflows');
          const resolvedConfig = resolveAgentType(agentId, rootDir);
          if (!resolvedConfig) {
            console.log(`Agent "${agentId}" not found. Message sent as plain text.`);
          } else {
            // Append user message first
            appendMessage(
              threadId,
              {
                kind: 'user_message',
                threadId,
                authorId: 'cli-user',
                text: message,
              },
              rootDir,
            );

            // Launch agent run
            const { createOpenSlackAgentLauncher, createRunStore } =
              await import('@openslack/agent-runtime');
            const store = createRunStore(rootDir);
            const launcher = createOpenSlackAgentLauncher({ runStore: store, rootDir });

            const runResult = await launcher(prompt, {
              label: agentId,
              phase: 'conversation',
              agentType: agentId,
              resolvedAgentConfig: resolvedConfig,
            });

            // Append agent response
            appendMessage(
              threadId,
              {
                kind: 'agent_response',
                threadId,
                authorId: agentId,
                text:
                  typeof runResult.data === 'string'
                    ? runResult.data
                    : JSON.stringify(runResult.data, null, 2),
                structured: runResult.data,
              },
              rootDir,
            );

            // Link run to thread using the actual runId from the launcher
            const { linkRunToThread } = await import('@openslack/collaboration');
            linkRunToThread(threadId, runResult.runId, rootDir);

            console.log(`Agent "${agentId}" dispatched. Result appended to thread.`);
            console.log(`Thread: ${threadId}`);
            return;
          }
        }

        const msg = appendMessage(
          threadId,
          {
            kind: 'user_message',
            threadId,
            authorId: 'cli-user',
            text: message,
          },
          rootDir,
        );
        console.log(`Message sent: ${msg.id}`);
        console.log(`Thread: ${threadId}`);
      } catch (err) {
        console.log((err as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command('summarize <threadId>')
    .description('Show thread summary and next action')
    .action((threadId: string) => {
      try {
        const rootDir = findRepoRoot();
        const result = getThread(threadId, rootDir);
        if (!result) {
          console.log(`Thread ${threadId} not found.`);
          process.exit(1);
        }

        const { thread, messages } = result;

        if (thread.summary) {
          console.log(`Summary: ${thread.summary}`);
        } else {
          const userMsgs = messages.filter((m) => m.kind === 'user_message').length;
          const agentMsgs = messages.filter((m) => m.kind === 'agent_response').length;
          console.log(
            `Summary: ${messages.length} message(s) — ${userMsgs} user, ${agentMsgs} agent`,
          );
        }

        if (thread.nextAction) {
          console.log(
            `Next action: ${thread.nextAction.action} (owner: ${thread.nextAction.owner})`,
          );
          if (thread.nextAction.command) {
            console.log(`Command: ${thread.nextAction.command}`);
          }
        } else {
          console.log('No next action defined.');
        }
      } catch (err) {
        console.log((err as Error).message);
        process.exit(1);
      }
    });

  cmd
    .command('archive <threadId>')
    .description('Archive a conversation thread')
    .action((threadId: string) => {
      try {
        const rootDir = findRepoRoot();
        const success = archiveThread(threadId, rootDir);
        if (!success) {
          console.log(`Thread ${threadId} not found or already archived.`);
          process.exit(1);
        }
        console.log(`Thread ${threadId} archived.`);
      } catch (err) {
        console.log((err as Error).message);
        process.exit(1);
      }
    });

  return cmd;
}
