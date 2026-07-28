import { generateDocumentation, verifyDocumentation, verifyMigration } from './lib.js';

const command = process.argv[2];
const root = process.cwd();

try {
  switch (command) {
    case 'generate': {
      const written = generateDocumentation(root);
      console.log(`Generated ${written.length} documentation projection(s).`);
      for (const path of written) console.log(`- ${path}`);
      break;
    }
    case 'verify': {
      const result = verifyDocumentation(root);
      console.log(
        `Documentation verified: ${result.schemas} schemas, ${result.documents} active documents, ${result.generated} generated projections.`,
      );
      break;
    }
    case 'migration-check': {
      const result = verifyMigration(root);
      console.log(
        `Documentation migration ${result.phase} check passed for ${result.entries} manifest entries.`,
      );
      break;
    }
    default:
      throw new Error(
        'Usage: bun scripts/documentation/index.ts <generate|verify|migration-check>',
      );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
