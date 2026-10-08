import assert from 'node:assert/strict';
import test from 'node:test';

import { digestProposal } from '../agent-init/evaluation-harness.js';
import { parseCodexTurn } from './parser.js';
import * as parser from './parser.js';

function capturedTurn(text = '{"schemaVersion":1,"kind":"setup-proposal"}') {
  return {
    threadId: 'thread-1', turnId: 'turn-1',
    request: { id: 2, method: 'turn/start', params: { threadId: 'thread-1', input: [{ type: 'text', text: 'Test observation.' }] } },
    events: [
      { method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'message-1', delta: text.slice(0, 9) } },
      { method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'message-1', delta: text.slice(9) } },
      { method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item: { type: 'agentMessage', id: 'message-1', text } } },
      { method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [], itemsView: 'notLoaded', error: null } } },
    ],
  };
}

test('Codex parser reconstructs the captured final message, not turn summary items', () => {
  const capture = capturedTurn();
  assert.deepEqual(parseCodexTurn(capture), { schemaVersion: 1, kind: 'setup-proposal' });
});

test('thread-scoped Codex warnings preserve the turn capture but never supply selection completeness', () => {
  const capture = capturedTurn();
  capture.events.splice(2, 0, { method: 'warning', params: { threadId: capture.threadId, message: 'An inspected Skill could not be read.' } });
  assert.deepEqual(parseCodexTurn(capture), { schemaVersion: 1, kind: 'setup-proposal' });
  assert.equal(capture.events[2].params.message, 'An inspected Skill could not be read.');
  const selection = parser.parseCodexSelection(capture, { mode: 'native', freshSession: true, sessionId: 'fresh-1', knownSkills: ['build-verify'] });
  assert.equal(selection.status, 'incomplete');
  assert.equal(selection.selectionEvidence, null);
  for (const params of [
    { threadId: 'foreign-thread', message: 'Other thread.' },
    { threadId: capture.threadId },
    { threadId: capture.threadId, message: 'Other turn.', turnId: 'foreign-turn' },
  ]) {
    const invalid = structuredClone(capture);
    invalid.events[2].params = params;
    assert.throws(() => parseCodexTurn(invalid), { code: 'TURN_CONTEXT' });
  }
  const unknown = structuredClone(capture);
  unknown.events[2].method = 'unknown/threadNotification';
  assert.throws(() => parseCodexTurn(unknown), { code: 'TURN_CONTEXT' });
});

test('synthetic selection requires a complete request-bound receipt, including for observed empty', () => {
  const capture = capturedTurn();
  const options = { mode: 'synthetic', runId: 'run-1', sessionId: 'session-1', knownSkills: ['build-verify'] };
  assert.equal(parser.parseCodexSelection(capture, options).status, 'incomplete');
  capture.events.splice(3, 0, {
    method: 'synthetic/selection.complete',
    params: {
      threadId: capture.threadId, turnId: capture.turnId, runId: options.runId, sessionId: options.sessionId,
      requestDigest: digestProposal(capture.request), complete: true, loaded: [],
    },
  });
  assert.deepEqual(parser.parseCodexSelection(capture, options), {
    status: 'complete', selectionEvidence: { loaded: [] }, evidenceKind: 'synthetic-receipt', synthetic: true,
  });
  capture.events[3].params.loaded = ['build-verify'];
  assert.deepEqual(parser.parseCodexSelection(capture, options).selectionEvidence, { loaded: ['build-verify'] });
  capture.events[3].params.requestDigest = 'sha256:wrong';
  assert.throws(() => parser.parseCodexSelection(capture, options), { code: 'SELECTION_BINDING' });
});

test('native-shaped selected Skill body supports only finite positive evidence, never a complete loaded universe', () => {
  const capture = capturedTurn();
  const body = '---\nname: build-verify\n---\nSynthetic body bytes.\n';
  const skillPath = '/owned/fixture/.agents/skills/build-verify/SKILL.md';
  capture.events.splice(3, 0, {
    method: 'rawResponseItem/completed',
    params: {
      threadId: capture.threadId, turnId: capture.turnId,
      item: {
        type: 'message', role: 'user',
        content: [{ type: 'input_text', text: `<skill>\n<name>build-verify</name>\n<path>${skillPath}</path>\n${body}\n</skill>` }],
        internal_chat_message_metadata_passthrough: { content_item_kinds: ['skills.selected_skill_instructions'] },
      },
    },
  });
  const options = { mode: 'native', freshSession: true, sessionId: 'fresh-1', knownSkills: ['build-verify'], skills: [{ name: 'build-verify', path: skillPath, body }] };
  const result = parser.parseCodexSelection(capture, options);
  assert.equal(result.status, 'incomplete');
  assert.equal(result.selectionEvidence, null);
  assert.deepEqual(result.positiveSelections.map((entry) => entry.name), ['build-verify']);
  assert.equal(result.evidenceKind, 'native-host-fragment');
  capture.request.params.input[0].text = capture.events[3].params.item.content[0].text;
  assert.throws(() => parser.parseCodexSelection(capture, options), { code: 'SELECTION_PROVENANCE' });
  capture.request.params.input[0].text = 'Test observation.';
  capture.request.params.toolOutput = { text: capture.events[3].params.item.content[0].text };
  assert.throws(() => parser.parseCodexSelection(capture, options), { code: 'SELECTION_PROVENANCE' });
});

test('unfinished messages and post-terminal selection receipts are incomplete captures', () => {
  const orphan = capturedTurn();
  orphan.events.unshift({ method: 'item/agentMessage/delta', params: { threadId: orphan.threadId, turnId: orphan.turnId, itemId: 'unfinished-message', delta: '{' } });
  assert.throws(() => parseCodexTurn(orphan), { code: 'TURN_MESSAGE' });
  const late = capturedTurn();
  late.events.push({ method: 'synthetic/selection.complete', params: {
    threadId: late.threadId, turnId: late.turnId, complete: true, runId: 'run-1', sessionId: 'session-1', requestDigest: digestProposal(late.request), loaded: [],
  } });
  assert.throws(() => parser.parseCodexSelection(late, { mode: 'synthetic', runId: 'run-1', sessionId: 'session-1', knownSkills: ['build-verify'] }), { code: 'TURN_INCOMPLETE' });
});

test('complete selection cannot bypass unfinished message framing, and synthetic carriers cannot be native evidence', () => {
  const capture = capturedTurn('Plain synthetic final answer.');
  capture.events.splice(3, 0, { method: 'synthetic/selection.complete', params: {
    threadId: capture.threadId, turnId: capture.turnId, runId: 'run-1', sessionId: 'session-1', requestDigest: digestProposal(capture.request), complete: true, loaded: [],
  } });
  const options = { mode: 'synthetic', runId: 'run-1', sessionId: 'session-1', knownSkills: ['build-verify'] };
  assert.equal(parser.parseCodexSelection(capture, options).status, 'complete');
  assert.throws(() => parser.parseCodexSelection(capture, { ...options, mode: 'native' }), { code: 'SYNTHETIC_EVIDENCE' });
  capture.events.unshift({ method: 'item/agentMessage/delta', params: { threadId: capture.threadId, turnId: capture.turnId, itemId: 'orphan', delta: '{' } });
  assert.throws(() => parser.parseCodexSelection(capture, options), { code: 'TURN_MESSAGE' });
});
