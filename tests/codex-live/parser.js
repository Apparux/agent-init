import { digestProposal } from '../agent-init/evaluation-harness.js';

function failure(code, message) {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function checkCapture(capture) {
  if (!object(capture) || typeof capture.threadId !== 'string' || !capture.threadId
    || typeof capture.turnId !== 'string' || !capture.turnId || !Array.isArray(capture.events)
    || capture.request?.method !== 'turn/start' || capture.request.params?.threadId !== capture.threadId) {
    throw failure('TURN_CAPTURE', 'missing actual request, thread or turn identity');
  }
  for (const event of capture.events) {
    if (!object(event) || typeof event.method !== 'string' || !object(event.params)
      || event.params.threadId !== capture.threadId
      || (event.method === 'warning'
        ? typeof event.params.message !== 'string' || !event.params.message || Object.hasOwn(event.params, 'turnId')
        : (event.method === 'turn/completed' ? event.params.turn?.id : event.params.turnId) !== capture.turnId)) {
      throw failure('TURN_CONTEXT', 'captured notification has a different or missing context');
    }
  }
  const terminal = capture.events.filter((event) => event.method === 'turn/completed');
  if (terminal.length !== 1 || capture.events.at(-1) !== terminal[0]
    || terminal[0].params.turn.status !== 'completed' || terminal[0].params.turn.error != null) {
    throw failure('TURN_INCOMPLETE', 'turn is missing, repeated, failed or interrupted');
  }
}

function capturedFinalText(capture) {
  checkCapture(capture);
  const deltas = new Map();
  const completed = new Set();
  const finals = [];
  for (const event of capture.events) {
    const params = event.params;
    if (event.method === 'item/agentMessage/delta') {
      if (typeof params.itemId !== 'string' || typeof params.delta !== 'string' || completed.has(params.itemId)) {
        throw failure('TURN_MESSAGE', 'invalid or post-completion message delta');
      }
      deltas.set(params.itemId, (deltas.get(params.itemId) ?? '') + params.delta);
    } else if (event.method === 'item/completed' && params.item?.type === 'agentMessage') {
      const item = params.item;
      if (typeof item.id !== 'string' || typeof item.text !== 'string' || completed.has(item.id)
        || (deltas.has(item.id) && deltas.get(item.id) !== item.text)) {
        throw failure('TURN_MESSAGE', 'completed message does not match its actual deltas');
      }
      completed.add(item.id);
      if (item.phase !== 'commentary') finals.push(item.text);
    }
  }
  if ([...deltas.keys()].some((id) => !completed.has(id))) throw failure('TURN_MESSAGE', 'captured message delta has no completed item');
  if (finals.length !== 1) throw failure('TURN_MESSAGE', 'expected one captured final assistant message');
  return finals[0];
}

export function parseCodexTurn(capture) {
  const text = capturedFinalText(capture);
  let record;
  try { record = JSON.parse(text); } catch { throw failure('MACHINE_RECORD', 'final assistant message is not complete JSON'); }
  if (!object(record)) throw failure('MACHINE_RECORD', 'machine record must be an object');
  return record;
}

export function parseCodexSelection(capture, options) {
  capturedFinalText(capture);
  const receipts = capture.events.filter((event) => event.method === 'synthetic/selection.complete');
  if (!receipts.length) {
    if (options.mode !== 'native') return { status: 'incomplete', selectionEvidence: null, evidenceKind: null };
    if (options.freshSession !== true || !options.sessionId || Object.hasOwn(capture.request.params, 'toolOutput')
      || (capture.request.params.input ?? []).some((input) => !['text', 'skill'].includes(input.type))) {
      throw failure('SELECTION_PROVENANCE', 'native positive fragments require a fresh text/Skill request with no caller tool-output injection');
    }
    const positiveSelections = [];
    for (const event of capture.events.filter((entry) => entry.method === 'rawResponseItem/completed')) {
      const item = event.params.item;
      const kinds = item?.internal_chat_message_metadata_passthrough?.content_item_kinds;
      if (!Array.isArray(kinds) || !kinds.includes('skills.selected_skill_instructions')) continue;
      if (item.type !== 'message' || item.role !== 'user' || !Array.isArray(item.content) || kinds.length !== item.content.length) {
        throw failure('SELECTION_PROVENANCE', 'host fragment role or private classification alignment is invalid');
      }
      for (let index = 0; index < kinds.length; index++) {
        if (kinds[index] !== 'skills.selected_skill_instructions') continue;
        const content = item.content[index];
        if (content.type !== 'input_text' || typeof content.text !== 'string'
          || (capture.request.params.input ?? []).some((input) => input.text?.includes(content.text))) {
          throw failure('SELECTION_PROVENANCE', 'selected fragment is invalid or was directly supplied by the caller');
        }
        const skill = (options.skills ?? []).find((entry) => content.text === `<skill>\n<name>${entry.name}</name>\n<path>${entry.path}</path>\n${entry.body}\n</skill>`);
        if (!skill || !options.knownSkills.includes(skill.name) || positiveSelections.some((entry) => entry.name === skill.name)) {
          throw failure('SELECTION_EVIDENCE', 'selected host body is unknown, repeated, truncated or does not match its physical payload');
        }
        positiveSelections.push({ name: skill.name, path: skill.path, bodyDigest: digestProposal({ body: skill.body }) });
      }
    }
    // This private source-shaped surface is finite positive evidence, not a complete host-read audit.
    return { status: 'incomplete', selectionEvidence: null, positiveSelections, evidenceKind: positiveSelections.length ? 'native-host-fragment' : null };
  }
  if (options.mode !== 'synthetic') throw failure('SYNTHETIC_EVIDENCE', 'synthetic receipts are not native Codex evidence');
  const receipt = receipts[0].params;
  if (receipts.length !== 1 || receipt.complete !== true || !options.runId || !options.sessionId
    || receipt.runId !== options.runId || receipt.sessionId !== options.sessionId
    || receipt.requestDigest !== digestProposal(capture.request)) {
    throw failure('SELECTION_BINDING', 'selection receipt is incomplete, repeated or bound to a different request/session');
  }
  if (!Array.isArray(receipt.loaded) || receipt.loaded.some((name) => typeof name !== 'string' || !options.knownSkills.includes(name))
    || new Set(receipt.loaded).size !== receipt.loaded.length) {
    throw failure('SELECTION_EVIDENCE', 'selection must be an explicit unique list of known names');
  }
  return { status: 'complete', selectionEvidence: { loaded: [...receipt.loaded] }, evidenceKind: 'synthetic-receipt', synthetic: true };
}
