const EXECUTABLE_FIELD_NAMES = [
  'entry',
  'main',
  'exports',
  'bin',
  'executable',
  'implementation',
  'handler',
  'evaluate',
  'evaluator',
  'predicate',
  'callback',
  'command',
  'argv',
  'args',
  'shell',
  'exec',
  'spawn',
  'template',
  'path',
  'file',
  'module',
  'url',
  'activate',
  'deactivate',
  'raw',
  'rawcommand',
  'raw_command',
] as const;

const AUTHORITY_FIELD_NAMES = [
  '__proto__',
  'prototype',
  'constructor',
  'tostring',
  'providerkind',
  'source',
  'lifecycle',
  'state',
  'activationevidence',
  'approval',
  'approvals',
  'approved',
  'isapproved',
  'is_approved',
  'is-approved',
  'approvedby',
  'approvedat',
  'actor',
  'identity',
  'agentidentity',
  'risk',
  'risklevel',
  'riskzone',
  'confirmationrequired',
  'effectivecapabilities',
  'hostallowedcapabilities',
  'actorallowedcapabilities',
  'authoritywriterhandle',
  'authoritystate',
  'authority_state',
  'authority-state',
  'proposemutation',
  'permission',
  'permissions',
  'codeowners',
  'bypass',
  'humanapproval',
  'approvaldecision',
  'reviewdecision',
  'mergeable',
] as const;

export const PLUGIN_MANIFEST_EXECUTABLE_FIELD_NAMES = Object.freeze(EXECUTABLE_FIELD_NAMES);
export const PLUGIN_MANIFEST_AUTHORITY_FIELD_NAMES = Object.freeze(AUTHORITY_FIELD_NAMES);

const EXECUTABLE_FIELD_SET = new Set<string>(PLUGIN_MANIFEST_EXECUTABLE_FIELD_NAMES);
const AUTHORITY_FIELD_SET = new Set<string>(PLUGIN_MANIFEST_AUTHORITY_FIELD_NAMES);

export function isPluginManifestExecutableFieldName(name: string): boolean {
  return EXECUTABLE_FIELD_SET.has(name.toLowerCase());
}

export function isPluginManifestAuthorityFieldName(name: string): boolean {
  return AUTHORITY_FIELD_SET.has(name.toLowerCase());
}
