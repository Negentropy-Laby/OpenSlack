// TEST ONLY resource evidence. The PRMS decision/transport remain real.
import { appendFileSync } from 'node:fs';
function record(name: string) {
  appendFileSync(process.env.CLEANUP_FIXTURE_LOG!, `${name}\n`);
}
export async function getDefaultBranch() {
  record('default');
  return 'main';
}
export async function isBranchProtected() {
  record('protected');
  return process.env.CLEANUP_FIXTURE_PROTECTED === '1';
}
export async function listOpenPRsForBranch() {
  record('dependencies');
  return [];
}
export async function claimRefPresent() {
  record('claim');
  return false;
}
