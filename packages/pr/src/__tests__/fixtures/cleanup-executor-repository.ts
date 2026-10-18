// One synthetic repository for the offline HTTP and bare-Git composition.
const owner = 'example';
const name = 'qualification';
const fullName = `${owner}/${name}`;
export const CLEANUP_FIXTURE_REPOSITORY = Object.freeze({
  owner,
  name,
  fullName,
  id: 123,
  appId: 1,
  installationId: 2,
  apiPath: `/repos/${fullName}`,
  gitUrl: `https://github.com/${fullName}.git`,
  branch: 'fixture',
  defaultBranch: 'main',
});
