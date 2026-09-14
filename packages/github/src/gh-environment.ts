export function validateGhGoDebug(
  parentEnvironment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const value = parentEnvironment.OPENSLACK_BOT_GH_GODEBUG;
  if (value === undefined || (typeof value === 'string' && value.trim() === '')) return undefined;
  if (typeof value === 'string' && value.trim() === 'tlsmlkem=0') return 'tlsmlkem=0';
  const error = new Error('BOT_GH_GODEBUG_INVALID: only tlsmlkem=0 is supported.');
  Object.assign(error, { code: 'BOT_GH_GODEBUG_INVALID' });
  throw error;
}

export function createGhEnvironment(
  credentials: { value: string; repository?: string },
  parentEnvironment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH',
    'Path',
    'PATHEXT',
    'SystemRoot',
    'WINDIR',
    'COMSPEC',
    'TEMP',
    'TMP',
    'TMPDIR',
    'HOME',
    'USERPROFILE',
    'LANG',
    'LC_ALL',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
  ]) {
    if (parentEnvironment[key] !== undefined) env[key] = parentEnvironment[key];
  }
  const childGoDebug = validateGhGoDebug(parentEnvironment);
  if (childGoDebug) env.GODEBUG = childGoDebug;
  env.GH_TOKEN = credentials.value;
  env.GH_REPO = credentials.repository;
  env.GH_PAGER = 'cat';
  env.PAGER = 'cat';
  env.GH_PROMPT_DISABLED = '1';
  env.GH_EDITOR = 'false';
  env.GH_BROWSER = 'false';
  env.NO_COLOR = '1';
  return env;
}

/** Apply the opt-in only at an actual gh launch, preserving the caller's auth mode. */
export function ghProcessEnvironment(parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const value = validateGhGoDebug(parent);
  const env = { ...parent };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === 'GODEBUG' || key.toUpperCase() === 'OPENSLACK_BOT_GH_GODEBUG')
      delete env[key];
  }
  if (value) env.GODEBUG = value;
  return env;
}
