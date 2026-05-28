import { Command } from 'commander';
import { getRoleGuide, listRoles, renderGuide } from '@openslack/operator';

export function guideCommands(): Command {
  const cmd = new Command('guide')
    .description('Show role-based quick-start guides')
    .argument('[role]', 'Role name (operator, reviewer, agent-maintainer, lead)')
    .option('--list', 'List available roles')
    .action((role: string | undefined, options: { list?: boolean }) => {
      if (options.list || !role) {
        const roles = listRoles();
        console.log('Available roles:');
        for (const r of roles) {
          const guide = getRoleGuide(r);
          console.log(`  ${r.padEnd(20)} ${guide?.description ?? ''}`);
        }
        console.log('');
        console.log('Usage: openslack guide <role>');
        return;
      }

      const guide = getRoleGuide(role);
      if (!guide) {
        const roles = listRoles();
        console.error(`Unknown role: "${role}"`);
        console.error('');
        console.error('Available roles:');
        for (const r of roles) {
          console.error(`  ${r}`);
        }
        console.error('');
        console.error('Use: openslack guide <role>');
        process.exit(1);
      }

      console.log(renderGuide(guide));
    });

  return cmd;
}
