import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { findWorkflow, loadWorkflow } from './loader.js'

export interface SaveWorkflowOptions {
  rootDir?: string
  to: 'project' | 'user'
  sourcePath?: string
}

export interface SaveWorkflowResult {
  workflowName: string
  path: string
  scriptHash: string
  source: 'project' | 'user'
}

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16)
}

export async function saveWorkflow(workflowName: string, options: SaveWorkflowOptions): Promise<SaveWorkflowResult> {
  const rootDir = options.rootDir ?? process.cwd()
  const found = options.sourcePath ? { path: resolve(rootDir, options.sourcePath) } : await findWorkflow(workflowName, rootDir)
  if (!found) throw new Error(`Workflow not found: ${workflowName}`)
  const loaded = await loadWorkflow(found.path)
  const content = await readFile(found.path, 'utf-8')
  const targetDir = options.to === 'project'
    ? resolve(rootDir, '.openslack', 'workflows')
    : resolve(process.env.USERPROFILE ?? process.env.HOME ?? rootDir, '.claude', 'workflows')
  await mkdir(targetDir, { recursive: true })
  const targetPath = join(targetDir, `${loaded.meta.name}.mjs`)
  await writeFile(targetPath, content, 'utf-8')
  return {
    workflowName: loaded.meta.name,
    path: targetPath,
    scriptHash: hash(content),
    source: options.to,
  }
}

export interface ExportWorkflowSkillOptions {
  rootDir?: string
  outDir: string
}

export interface ExportWorkflowSkillResult {
  workflowName: string
  skillDir: string
  skillPath: string
  workflowPath: string
}

export async function exportWorkflowSkill(
  workflowName: string,
  options: ExportWorkflowSkillOptions,
): Promise<ExportWorkflowSkillResult> {
  const rootDir = options.rootDir ?? process.cwd()
  const found = await findWorkflow(workflowName, rootDir)
  if (!found) throw new Error(`Workflow not found: ${workflowName}`)
  const loaded = await loadWorkflow(found.path)
  const content = await readFile(found.path, 'utf-8')
  const skillDir = resolve(rootDir, options.outDir)
  const workflowDir = join(skillDir, 'workflows')
  await mkdir(workflowDir, { recursive: true })
  const workflowPath = join(workflowDir, basename(found.path).replace(/\.(ts|js)$/, '.mjs'))
  const skillPath = join(skillDir, 'SKILL.md')
  await writeFile(workflowPath, content, 'utf-8')
  await writeFile(skillPath, `# ${loaded.meta.name}

Use this skill when a task matches this reusable OpenSlack workflow:

- Description: ${loaded.meta.description}
- Workflow script: workflows/${basename(workflowPath)}
- Inputs: pass workflow args through OpenSlack's workflow command surface.

This package exports the workflow template only. It does not include run-local transcripts, secrets, or absolute evidence paths.
`, 'utf-8')
  return {
    workflowName: loaded.meta.name,
    skillDir,
    skillPath,
    workflowPath,
  }
}
