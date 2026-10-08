import { createInterface } from 'node:readline/promises';
import { PassThrough } from 'node:stream';
import { privateClaudeReference, sensitiveClaudeField, sensitiveClaudeText } from './claude-input-policy.js';

function stop(code) {
  throw Object.assign(new Error(code), { code });
}

function freezeData(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeData(child);
    Object.freeze(value);
  }
  return value;
}

export function claudeTerminalJson(value, space) {
  // JSON already quotes C0 characters; make C1/format controls visible too.
  return JSON.stringify(value, null, space).replace(/[\u007f-\u009f]|\p{Cf}/gu,
    (characters) => characters.split('').map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`).join(''));
}

// This is a local human-input contract, not a native CLI permission message.
export function claudeApprovalRequest(captured, { nativeApply = false } = {}) {
  const proposal = captured.proposal;
  const writable = proposal.actions.filter((action) => ['CREATE', 'UPDATE'].includes(action.action));
  const nonwriting = proposal.actions.filter((action) => !['CREATE', 'UPDATE'].includes(action.action));
  const cited = new Set(proposal.actions.flatMap((action) => action.evidenceIds));
  const claims = [];
  const pending = [proposal.projectSummary, proposal.unknowns, proposal.warnings, proposal.validationPlan,
    ...proposal.actions.flatMap(({ reason, summary }) => [reason, summary])];
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === 'string') claims.push(value);
    else if (value && typeof value === 'object') pending.push(...Object.values(value));
  }
  for (const entry of captured.decisionRecord.evidenceLedger) {
    const spelling = entry.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const reference = new RegExp(`(?:^|[^\\p{L}\\p{N}_-])${spelling}(?=$|[^\\p{L}\\p{N}_-])`, 'u');
    if (claims.some((value) => reference.test(value))) cited.add(entry.id);
  }
  const audit = JSON.parse(JSON.stringify({ proposal,
    evidenceLedger: captured.decisionRecord.evidenceLedger.filter((entry) => cited.has(entry.id)) }));
  const literal = (value) => claudeTerminalJson(value);
  const summary = [
    '尚未执行项目写入。',
    `Proposal ${literal(proposal.id)}, revision ${proposal.revision}`,
    '会改变（仅 CREATE/UPDATE）：',
    ...writable.map((action) => `${action.action} ${literal(action.id)} → ${literal(action.target)}：${literal(action.reason)}`),
    ...(writable.length ? [] : ['无写动作。']),
    ...writable.filter(action => action.kind === 'claude-skill-reference').map(action =>
      `Reference ${literal(action.id)}：父目录（0755）${literal(action.parentDirectories ?? '未声明：不能开放 mkdir')}；仅创建相对 symlink ${literal(action.target)} → ${literal(action.linkTarget)}，不覆盖。`),
    '不会写入（KEEP/SKIP/RECOMMEND）：',
    ...nonwriting.map((action) => `${action.action} ${literal(action.id)} → ${literal(action.target)}：${literal(action.summary)}`),
    ...(nonwriting.length ? [] : ['无非写动作。']),
    `Unknowns：${literal(proposal.unknowns)}；warnings：${literal(proposal.warnings)}`,
    '不改业务代码、CI、settings、Hooks、权限、生产、远端或用户环境。',
    nativeApply ? '精确批准后将尝试受门禁约束的原生 Apply；安全门禁或调用额度未通过时不会写入。批准这些文件动作不授权额外模型调用，也不证明原生权限底线。'
      : '本轮仅记录精确批准；直接 CLI 的 Apply 协议未验证，批准后也不会写入。',
    `批准范围句：Approve Proposal ${literal(proposal.id)} revision ${proposal.revision}, actions ${literal(writable.map((action) => action.id))}.`,
    '可以明确拒绝或指定较小的确切子集；本入口不会把部分批准扩成全部批准。',
    '\n完整审计（完整 payload/diff、证据与验证计划）：', claudeTerminalJson(audit, 2),
    `Proposal digest: ${captured.proposalDigest}`,
    '\n输入单行 JSON：type="approval", decision="approve"或"reject", scope="exact-proposal", proposalId, revision, proposalDigest, approvedActionIds。',
    '必须显式列出上述 ID、revision、digest 和每个写动作 ID；拒绝时 approvedActionIds 为 []。不接受 approve all、沉默或运行 consent。',
  ];
  return freezeData({ audit, proposalDigest: captured.proposalDigest, presentation: summary.join('\n'),
    requestedWriteActionIds: writable.map((action) => action.id), maxInputBytes: 65536, timeoutMs: 180000 });
}

export async function readClaudeTerminalApproval(request, { input = process.stdin, output = process.stdout } = {}) {
  if (!input.isTTY || !output.isTTY) stop('APPROVAL_TERMINAL_REQUIRED');
  const previousRawMode = input.isRaw;
  input.pause();
  const bounded = new PassThrough();
  bounded.isTTY = input.isTTY;
  bounded.setRawMode = (value) => { input.setRawMode?.(value); return bounded; };
  const controller = new AbortController();
  let bytes = 0;
  let abortCode;
  function abort(code) {
    if (controller.signal.aborted) return;
    abortCode = code;
    input.pause();
    controller.abort();
  }
  function receive(chunk) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > request.maxInputBytes) abort('APPROVAL_INPUT_LIMIT');
    else if (!controller.signal.aborted) bounded.write(chunk);
  }
  const ended = () => abort('APPROVAL_INPUT_CLOSED');
  const failed = () => abort('APPROVAL_INPUT_FAILED');
  const interrupted = () => abort('APPROVAL_INTERRUPTED');
  const terminal = createInterface({ input: bounded, output, terminal: true });
  const timer = setTimeout(() => abort('APPROVAL_TIMEOUT'), request.timeoutMs);
  terminal.once('close', ended);
  terminal.once('SIGINT', interrupted);
  input.on('data', receive);
  input.once('end', ended);
  input.once('close', ended);
  input.once('error', failed);
  try {
    const answer = terminal.question(`${request.presentation}\n> `, { signal: controller.signal });
    if (input.readableEnded || input.destroyed) ended();
    else input.resume();
    return await answer;
  } catch (cause) {
    if (cause.name === 'AbortError') stop(abortCode ?? 'APPROVAL_INPUT_FAILED');
    if (cause.code === 'ERR_USE_AFTER_CLOSE') stop('APPROVAL_INPUT_CLOSED');
    throw cause;
  } finally {
    clearTimeout(timer);
    input.pause();
    input.off('data', receive);
    input.off('end', ended);
    input.off('close', ended);
    input.off('error', failed);
    terminal.close();
    bounded.destroy();
    if (typeof previousRawMode === 'boolean') input.setRawMode?.(previousRawMode);
  }
}

export function captureClaudeApproval(input, request, source, secrets = []) {
  const result = { status: 'invalid', source, humanApprovalProven: false, code: 'VAGUE_APPROVAL' };
  if (input == null || input === '') return { ...result, code: 'APPROVAL_REQUIRED' };
  if (typeof input !== 'string') return result;
  if (Buffer.byteLength(input) > request.maxInputBytes) return { ...result, code: 'APPROVAL_INPUT_LIMIT' };
  const fields = new Set();
  let duplicateField = false;
  let literals = 0;
  // Flat approval keys are unique; inspect shadowed/escaped literals first.
  for (const match of input.matchAll(/"(?:[^"\\]|\\.)*"/g)) {
    if (++literals > 10000) return { ...result, code: 'APPROVAL_INPUT_LIMIT' };
    let value;
    try { value = JSON.parse(match[0]); }
    catch (cause) { if (cause instanceof SyntaxError) return result; throw cause; }
    if (secrets.some((secret) => secret && value.includes(secret))) return { ...result, code: 'SECRET_TRACE' };
    const isKey = /^\s*:/.test(input.slice(match.index + match[0].length));
    if ((isKey && sensitiveClaudeField(value)) || sensitiveClaudeText(value) || privateClaudeReference(value)) return { ...result, code: 'APPROVAL_PRIVATE' };
    if (isKey) {
      if (fields.has(value)) duplicateField = true;
      fields.add(value);
    }
  }
  if (duplicateField) return { ...result, code: 'APPROVAL_DUPLICATE_FIELDS' };
  let record;
  try { record = JSON.parse(input); }
  catch (cause) { if (cause instanceof SyntaxError) return result; throw cause; }
  const keys = ['type', 'decision', 'scope', 'proposalId', 'revision', 'proposalDigest', 'approvedActionIds'];
  if (!record || typeof record !== 'object' || Array.isArray(record) || Object.keys(record).length !== keys.length
    || keys.some((key) => !Object.hasOwn(record, key)) || record.type !== 'approval'
    || !['approve', 'reject'].includes(record.decision) || record.scope !== 'exact-proposal'
    || !Array.isArray(record.approvedActionIds)) return result;
  if (record.proposalId !== request.audit.proposal.id || record.revision !== request.audit.proposal.revision) return { ...result, code: 'STALE_APPROVAL' };
  if (record.proposalDigest !== request.proposalDigest) return { ...result, code: 'APPROVAL_PAYLOAD' };
  const ids = record.approvedActionIds;
  if (new Set(ids).size !== ids.length || ids.some((id) => !request.requestedWriteActionIds.includes(id))) return { ...result, code: 'APPROVAL_ACTIONS' };
  if (record.decision === 'reject' && ids.length) return { ...result, code: 'APPROVAL_ACTIONS' };
  const status = record.decision === 'reject' ? 'rejected' : ids.length === request.requestedWriteActionIds.length ? 'exact' : 'partial';
  return { status, source, record, humanApprovalProven: source === 'human-terminal' && record.decision === 'approve',
    code: status === 'exact' ? 'APPLY_PROTOCOL_UNVERIFIED' : status === 'rejected' ? 'PROPOSAL_REJECTED' : 'PARTIAL_APPROVAL',
    unapprovedActionIds: request.requestedWriteActionIds.filter((id) => !ids.includes(id)) };
}
