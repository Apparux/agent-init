import { privateClaudeReference, sensitiveClaudeText } from './claude-input-policy.js';

function stop(code) {
  throw Object.assign(new Error(code), { code });
}

function text(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

// Invocation-local transport inputs; never a credential store or login adapter.
export function resolveClaudeConnection(options, source, defaultModel) {
  if ((options.reuseCurrentConnection !== undefined && options.reuseCurrentConnection !== true)
    || (options.model !== undefined && options.reuseCurrentConnection !== true)) stop('CONNECTION_OPT_IN_REQUIRED');
  if (options.reuseCurrentConnection !== true) {
    const key = source.ANTHROPIC_API_KEY;
    if (!text(key)) stop('AUTHENTICATION_UNAVAILABLE');
    return { env: { ANTHROPIC_API_KEY: key }, secrets: [key], model: defaultModel, bare: true };
  }
  if (['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']
    .some((name) => source[name] !== undefined && source[name] !== '')) stop('CONNECTION_PROVIDER_UNSUPPORTED');
  const types = { ANTHROPIC_AUTH_TOKEN: 'bearer-token', ANTHROPIC_API_KEY: 'api-key', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token' };
  if (Object.keys(types).some((name) => source[name] !== undefined && source[name] !== '' && !text(source[name]))) stop('CONNECTION_AUTH_INVALID');
  const names = Object.keys(types).filter((name) => text(source[name]));
  if (!names.length) stop('AUTHENTICATION_UNAVAILABLE');
  if (names.length !== 1) stop('CONNECTION_AUTH_AMBIGUOUS');
  const name = names[0];
  const credential = source[name];
  if (credential.length > 16384 || /[^\x21-\x7e]/.test(credential)) stop('CONNECTION_AUTH_INVALID');
  const endpoint = source.ANTHROPIC_BASE_URL;
  const secrets = [credential];
  if (endpoint !== undefined) {
    if (!text(endpoint) || endpoint.length > 2048 || /[^\x21-\x7e]/.test(endpoint)) stop('CONNECTION_ENDPOINT_INVALID');
    let parsed;
    try { parsed = new URL(endpoint); }
    catch { stop('CONNECTION_ENDPOINT_INVALID'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) stop('CONNECTION_ENDPOINT_INVALID');
    if (name === 'CLAUDE_CODE_OAUTH_TOKEN') stop('CONNECTION_ROUTE_UNVERIFIED');
    secrets.push(endpoint, parsed.href, parsed.origin);
  }
  if (name === 'ANTHROPIC_AUTH_TOKEN' && endpoint === undefined) stop('CONNECTION_ENDPOINT_REQUIRED');
  const selectedModel = options.model !== undefined ? options.model : source.ANTHROPIC_MODEL;
  if (options.model !== undefined && !text(selectedModel)) stop('CONNECTION_MODEL_INVALID');
  if (!text(selectedModel)) stop('CONNECTION_MODEL_REQUIRED');
  if (secrets.some((value) => selectedModel.includes(value))) stop('SECRET_CONNECTION');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(selectedModel)
    || privateClaudeReference(selectedModel) || sensitiveClaudeText(selectedModel)) stop('CONNECTION_MODEL_INVALID');
  const bare = name === 'ANTHROPIC_API_KEY';
  return { env: { [name]: credential, ...(text(endpoint) ? { ANTHROPIC_BASE_URL: endpoint } : {}) },
    secrets: [...new Set(secrets)], model: selectedModel, bare,
    provenance: { source: 'existing-environment', authentication: types[name], gatewayConfigured: text(endpoint),
      requestedModel: selectedModel, modelSource: options.model !== undefined ? 'explicit-option' : 'environment', bare,
      storedLoginReused: false, parentConnectionIdentityProven: false, contextIsolationProven: false } };
}
