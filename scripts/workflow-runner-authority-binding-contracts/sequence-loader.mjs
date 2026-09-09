let target;
let source;

export function initialize(data) {
  target = data.target;
  source =
    'export const WORKFLOW_CONTROL_SEQUENCES = Object.freeze(' +
    JSON.stringify(data.rules) +
    ');\n' +
    'export function workflowControlCompanionSequence(kind) { return WORKFLOW_CONTROL_SEQUENCES[kind]; }\n';
}

export function resolve(specifier, context, nextResolve) {
  if (context.parentURL && /workflow-control-sequences\.generated\.(?:js|ts)$/.test(specifier)) {
    const candidate = new URL(specifier, context.parentURL).href.replace(/\.js$/, '.ts');
    if (candidate === target) return { url: target, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export function load(url, context, nextLoad) {
  if (url === target) return { format: 'module', source, shortCircuit: true };
  return nextLoad(url, context);
}
