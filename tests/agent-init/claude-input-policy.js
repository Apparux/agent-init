// Claude-only retention policy. Transport decoding and fixture exceptions stay
// with callers; neither credentials nor private references gain authority here.
export function sensitiveClaudeField(value) {
  return /auth|credential|password|secret|token|config|setting|(?:api|private|access|ssh|client)[_-]?key|(?:^|[_-])key(?:$|[_-])|^__proto__$|^constructor$|^prototype$/i.test(value);
}

export function sensitiveClaudeText(value) {
  return /\b(?:token|password|secret|credential|api[-_ ]?key|auth[-_ ]?token)["']?\s*[:=]|sk-ant-|gh[pousr]_|github_pat_|\bBearer\s+[a-zA-Z0-9_-]+|AKIA[A-Z0-9]{16}/i.test(value);
}

// Inspect escaped/shadowed strings before JSON.parse can discard an echo.
export function claudeJsonSecretFailure(input, configuredSecrets = []) {
  const secrets = configuredSecrets.filter((value) => typeof value === 'string' && value.length);
  if (secrets.some((secret) => input.includes(secret))) return 'SECRET_TRACE';
  let literals = 0;
  for (const match of input.matchAll(/"(?:\\.|[^"\\])*"/g)) {
    if (++literals > 10000) return 'TRACE_COMPLEXITY_LIMIT';
    let value;
    try { value = JSON.parse(match[0]); } catch { return 'TRACE_MALFORMED'; }
    if (secrets.some((secret) => value.includes(secret))) return 'SECRET_TRACE';
  }
  return null;
}

export function privateClaudeReference(value) {
  return /\bfile:|(?:^|[\s"'`(=:\[{},;])(?:[A-Za-z]:[\\/]|\/(?!\/|\s))[^\s"'`<>)]*/i.test(value);
}
