import assert from 'node:assert/strict';
import test from 'node:test';

import { parseClaudeTrace } from './claude-selection.js';

const sessionId = '11111111-1111-4111-8111-111111111111';
const context = { sessionId, harnessVersion: '2.1.285', requiredSkills: ['agent-init'] };

// These messages exercise the documented envelope, not a captured live Skill protocol.
function syntheticTrace(events = []) {
  const messages = [
    { type: 'system', subtype: 'init', session_id: sessionId, skills: ['agent-init'], tools: ['Read', 'Skill'] },
    ...events,
    { type: 'result', subtype: 'success', session_id: sessionId, is_error: false, permission_denials: [] },
  ];
  return { stdout: `${messages.map((message) => JSON.stringify(message)).join('\n')}\n`, status: 0, signal: null };
}

test('catalog discovery never becomes a loaded list or an empty-selection pass', () => {
  const result = parseClaudeTrace(syntheticTrace(), context);
  assert.equal(result.status, 'blocked');
  assert.equal(result.code, 'SELECTION_PROTOCOL_UNVERIFIED');
  assert.equal(Object.hasOwn(result, 'loaded'), false);
  assert.equal(result.provenance.sessionId, sessionId);
  assert.equal(result.provenance.harnessVersion, '2.1.285');
});

test('unverified init Skill metadata is omitted without proving selection or blocking tool evidence', () => {
  const privateMarker = 'configuration: synthetic-inventory-private-value';
  const unknownPath = '/unknown-inventory/skill';
  const credentialMarker = 'ghs_SYNTHETICINVENTORY0123456789';
  const inventories = [undefined, [], ['another-skill'], ['agent-init'], null, { opaque: 'future-shape' },
    [privateMarker], [unknownPath], [credentialMarker], { auth: privateMarker, opaque: { [credentialMarker]: unknownPath } }];
  for (const metadata of inventories) {
    for (const tool of [null, 'Skill', 'Read']) {
      for (const captureSkillEvidence of [false, true]) {
        const call = syntheticSkillCall();
        call.message.content[0].name = tool ?? 'Skill';
        const reply = syntheticSkillResult();
        reply.message.content[0].content = 'Synthetic technical reply';
        const messages = syntheticTrace(tool ? [call, reply] : []).stdout.trim().split('\n').map(JSON.parse);
        if (metadata === undefined) delete messages[0].skills;
        else messages[0].skills = metadata;
        const result = parseClaudeTrace({ status: 0, stdout: `${messages.map(message => JSON.stringify(message)).join('\n')}\n` },
          { ...context, captureSkillEvidence });
        assert.equal(result.status, 'blocked');
        assert.equal(result.code, 'SELECTION_PROTOCOL_UNVERIFIED');
        assert.equal(Object.hasOwn(result, 'loaded'), false);
        assert.equal(result.provenance.toolCalls.length, tool ? 1 : 0);
        if (tool) {
          assert.equal(result.provenance.toolCalls[0].name, tool);
          assert.equal(result.provenance.toolCalls[0].isError, false);
          assert.deepEqual(result.provenance.toolCalls[0].inputKeys, ['opaque']);
          assert.match(result.provenance.toolCalls[0].resultDigest, /^sha256:[a-f0-9]{64}$/);
        }
        if (captureSkillEvidence) {
          assert.equal(result.provenance.skillSamples.length, tool === 'Skill' ? 1 : 0);
          if (tool === 'Skill') {
            assert.deepEqual(result.provenance.skillSamples[0].input, { opaque: 'agent-init' });
            assert.equal(result.provenance.skillSamples[0].reply.content, 'Synthetic technical reply');
          }
        } else assert.equal(Object.hasOwn(result.provenance, 'skillSamples'), false);
        assert.deepEqual(result.provenance.catalog, { tools: ['Read', 'Skill'] });
        if (metadata === undefined) assert.equal(Object.hasOwn(result.provenance, 'unverifiedInitSkillMetadata'), false);
        else assert.deepEqual(result.provenance.unverifiedInitSkillMetadata, {
          omitted: true, exhaustiveCatalogProven: false, selectionProtocolVerified: false,
        });
        for (const value of [privateMarker, unknownPath, credentialMarker, 'future-shape', 'another-skill']) {
          assert.equal(JSON.stringify(result).includes(value), false);
        }
      }
    }
  }
});

test('escaped configured secrets in shadowed inventory members remain fatal before omission', () => {
  const secret = 'declared-native-secret-canary-only';
  const escaped = [...secret].map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
  const trace = syntheticTrace();
  trace.stdout = trace.stdout.replace('"skills":["agent-init"]', `"skills":{"shadowed":"${escaped}","shadowed":"public"}`);
  const result = parseClaudeTrace(trace, { ...context, secrets: [secret] });
  assert.equal(result.code, 'SECRET_TRACE');
  assert.equal(result.provenance.unverifiedInitSkillMetadata, undefined);
  assert.equal(Object.hasOwn(result, 'loaded'), false);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('missing, malformed, truncated and cross-session envelopes are explicit errors', () => {
  for (const [stdout, code] of [
    ['', 'TRACE_MISSING'],
    ['not JSON\n', 'TRACE_MALFORMED'],
    [syntheticTrace().stdout.trimEnd(), 'TRACE_TRUNCATED'],
    [syntheticTrace().stdout.split('\n')[0] + '\n', 'TRACE_INCOMPLETE'],
    [syntheticTrace().stdout.replaceAll(sessionId, 'another-session'), 'SESSION_MISMATCH'],
    [syntheticTrace().stdout.replace('"is_error":false', '"is_error":true'), 'SESSION_FAILED'],
    [syntheticTrace().stdout.replace('"Skill"', '"Bash"'), 'UNSAFE_TOOLS'],
  ]) {
    const result = parseClaudeTrace({ ...syntheticTrace(), stdout }, context);
    assert.equal(result.status, 'error', code);
    assert.equal(result.code, code);
    assert.equal(Object.hasOwn(result, 'loaded'), false);
  }
});

function syntheticSkillCall() {
  return { type: 'assistant', session_id: sessionId, parent_tool_use_id: null,
    message: { content: [{ type: 'tool_use', id: 'call-1', name: 'Skill', input: { opaque: 'agent-init' } }] } };
}

function syntheticSkillResult(isError = false) {
  return { type: 'user', session_id: sessionId, parent_tool_use_id: null,
    message: { content: [{ type: 'tool_result', tool_use_id: 'call-1', is_error: isError, content: 'private opaque result' }] } };
}

test('opaque Skill requests and replies are retained, not decoded with a guessed schema', () => {
  const result = parseClaudeTrace(syntheticTrace([syntheticSkillCall(), syntheticSkillResult()]), context);
  assert.equal(result.code, 'SELECTION_PROTOCOL_UNVERIFIED');
  assert.equal(Object.hasOwn(result, 'loaded'), false);
  assert.equal(result.provenance.toolCalls[0].name, 'Skill');
  assert.deepEqual(result.provenance.toolCalls[0].inputKeys, ['opaque']);
  assert.match(result.provenance.toolCalls[0].resultDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(result).includes('private opaque result'), false);
});

test('tool failure, missing reply, replay, retries and permission denials stay non-pass', () => {
  for (const [events, code] of [
    [[syntheticSkillCall()], 'TOOL_REPLY_MISSING'],
    [[syntheticSkillCall(), syntheticSkillResult(true)], 'TOOL_FAILED'],
    [[syntheticSkillResult()], 'TOOL_REPLY_UNMATCHED'],
    [[{ ...syntheticSkillCall(), isReplay: true }], 'REPLAYED_TRACE'],
    [[{ ...syntheticSkillCall(), parent_tool_use_id: 'parent' }], 'UNEXPECTED_SUBAGENT'],
    [[{ type: 'system', subtype: 'api_retry', session_id: sessionId }], 'API_RETRY'],
    [[{ type: 'system', subtype: 'permission_denied', session_id: sessionId }], 'PERMISSION_DENIED'],
  ]) {
    const result = parseClaudeTrace(syntheticTrace(events), context);
    assert.equal(result.status, 'error');
    assert.equal(result.code, code);
  }
});

test('malformed content blocks, reply flags and init order fail with trace location', () => {
  for (const invalid of [null, 42, [], {}, { type: 7 }]) {
    const call = syntheticSkillCall();
    call.message.content = [invalid];
    const result = parseClaudeTrace(syntheticTrace([call]), context);
    assert.equal(result.status, 'error');
    assert.equal(result.code, 'TRACE_MALFORMED');
    assert.deepEqual(result.location, { messageIndex: 1, blockIndex: 0 });
  }
  const reply = syntheticSkillResult();
  reply.message.content[0].is_error = 'true';
  assert.equal(parseClaudeTrace(syntheticTrace([syntheticSkillCall(), reply]), context).code, 'TRACE_MALFORMED');
  const lines = syntheticTrace([syntheticSkillCall(), syntheticSkillResult()]).stdout.trim().split('\n');
  [lines[0], lines[1]] = [lines[1], lines[0]];
  assert.equal(parseClaudeTrace({ status: 0, stdout: `${lines.join('\n')}\n` }, context).code, 'INIT_ORDER');
});

test('opt-in technical Skill samples retain unknown schema without claiming selection', () => {
  const call = syntheticSkillCall();
  call.message.content[0].input = { opaque: 'agent-init', args: '/owned/fixture' };
  const reply = syntheticSkillResult();
  reply.message.content[0].content = 'Synthetic technical reply: /owned/home/skill';
  const result = parseClaudeTrace(syntheticTrace([call, reply]), {
    ...context, captureSkillEvidence: true, evidenceRoots: ['/owned'],
  });
  assert.equal(result.status, 'blocked');
  assert.equal(Object.hasOwn(result, 'loaded'), false);
  assert.deepEqual(result.provenance.skillSamples[0].input, { opaque: 'agent-init', args: '<owned-root>/fixture' });
  assert.equal(result.provenance.skillSamples[0].reply.content, 'Synthetic technical reply: <owned-root>/home/skill');
  assert.equal(result.provenance.skillSamples[0].selectionProtocolVerified, false);
  assert.equal(JSON.stringify(result).includes('/owned'), false);
  call.message.content[0].input = { authorization: 'synthetic-credential' };
  const refused = parseClaudeTrace(syntheticTrace([call, reply]), { ...context, captureSkillEvidence: true });
  assert.equal(refused.code, 'PRIVATE_SKILL_SAMPLE');
  assert.equal(JSON.stringify(refused).includes('synthetic-credential'), false);
});

test('oversized opaque structures stay explicit non-pass before hashing or sampling', () => {
  const call = syntheticSkillCall();
  call.message.content[0].input = 'deep-placeholder';
  const trace = syntheticTrace([call, syntheticSkillResult()]);
  const deep = '{"nested":'.repeat(12000) + 'null' + '}'.repeat(12000);
  const wide = JSON.stringify(Object.fromEntries(Array.from({ length: 10050 }, (_, index) => [`field${index}`, null])));
  for (const input of [deep, wide]) {
    for (const channel of ['input', 'metadata']) {
      const stdout = channel === 'input' ? trace.stdout.replace('"deep-placeholder"', input)
        : trace.stdout.replace('"skills":["agent-init"]', `"skills":${input}`);
      const result = parseClaudeTrace({ ...trace, stdout }, { ...context, captureSkillEvidence: true });
      assert.equal(result.status, 'error');
      assert.equal(result.code, 'TRACE_COMPLEXITY_LIMIT');
      assert.equal(Object.hasOwn(result.provenance, 'unverifiedInitSkillMetadata'), false);
      assert.equal(Object.hasOwn(result, 'loaded'), false);
    }
  }
  assert.equal(parseClaudeTrace({ ...syntheticTrace(), signal: 'SIGTERM', stopReason: 'TRACE_COMPLEXITY_LIMIT' }, context).code, 'TRACE_COMPLEXITY_LIMIT');
});

test('technical Skill samples refuse auth, token and user configuration fields', () => {
  for (const field of ['ANTHROPIC_AUTH_TOKEN', 'auth', 'token', 'privateKey', 'settings', 'config', 'configuration']) {
    for (const sample of ['input', 'reply']) {
      const call = syntheticSkillCall();
      const reply = syntheticSkillResult();
      const privateValue = `synthetic-private-${field}`;
      if (sample === 'input') call.message.content[0].input = { opaque: { [field]: privateValue } };
      else reply.message.content[0].content = { opaque: { [field]: privateValue } };
      const result = parseClaudeTrace(syntheticTrace([call, reply]), { ...context, captureSkillEvidence: true });
      assert.equal(result.code, 'PRIVATE_SKILL_SAMPLE', `${sample}: ${field}`);
      assert.equal(JSON.stringify(result).includes(privateValue), false);
    }
  }
});

test('sample redaction respects owned path boundaries instead of matching substrings', () => {
  for (const unowned of ['/owned-neighbor/fixture', '/owned/../outside', '/outside/fixture', '/var/owned-neighbor/home']) {
    for (const sample of ['input', 'reply']) {
      const call = syntheticSkillCall();
      const reply = syntheticSkillResult();
      if (sample === 'input') call.message.content[0].input = { opaque: unowned };
      else reply.message.content[0].content = `Synthetic technical path: ${unowned}`;
      const result = parseClaudeTrace(syntheticTrace([call, reply]), {
        ...context, captureSkillEvidence: true, evidenceRoots: ['/owned', '/var/owned'],
      });
      assert.equal(result.code, 'PRIVATE_SKILL_SAMPLE', `${sample}: ${unowned}`);
      assert.equal(JSON.stringify(result).includes(unowned), false);
    }
  }
});

test('technical samples refuse credential and configuration markers inside opaque text', () => {
  for (const text of ['ANTHROPIC_AUTH_TOKEN=synthetic-private-value', 'settings: synthetic-private-value', JSON.stringify({ config: 'synthetic-private-value' })]) {
    const reply = syntheticSkillResult();
    reply.message.content[0].content = text;
    const result = parseClaudeTrace(syntheticTrace([syntheticSkillCall(), reply]), { ...context, captureSkillEvidence: true });
    assert.equal(result.code, 'PRIVATE_SKILL_SAMPLE');
    assert.equal(JSON.stringify(result).includes('synthetic-private-value'), false);
  }
});

test('every envelope needs a nonempty string type without guessing unknown event enums', () => {
  for (const invalid of [undefined, null, '', ' ', 7, []]) {
    const event = { session_id: sessionId, ...(invalid === undefined ? {} : { type: invalid }) };
    const result = parseClaudeTrace(syntheticTrace([event]), context);
    assert.equal(result.code, 'TRACE_MALFORMED');
    assert.equal(Object.hasOwn(result, 'loaded'), false);
  }
  const unknown = parseClaudeTrace(syntheticTrace([{ session_id: sessionId, type: 'future-documented-event' }]), context);
  assert.equal(unknown.code, 'SELECTION_PROTOCOL_UNVERIFIED');
});

test('JSON-escaped secrets in decoded values and property names never enter provenance', () => {
  const secret = 'sk-ant-testonly-private-canary';
  for (const field of ['id', 'key']) {
    const call = syntheticSkillCall();
    const reply = syntheticSkillResult();
    if (field === 'id') {
      call.message.content[0].id = secret;
      reply.message.content[0].tool_use_id = secret;
    } else call.message.content[0].input = { [secret]: 'opaque' };
    const trace = syntheticTrace([call, reply]);
    trace.stdout = trace.stdout.replaceAll(secret, `\\u0073${secret.slice(1)}`);
    const result = parseClaudeTrace(trace, { ...context, captureSkillEvidence: true, secrets: [secret] });
    assert.equal(result.code, 'SECRET_TRACE');
    assert.equal(result.status, 'error');
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.equal(Object.hasOwn(result, 'loaded'), false);
  }
});

test('recognizable credentials in unverified metadata or technical Skill samples are never retained', () => {
  for (const value of ['ghs_SYNTHETICCANARY0123456789', 'AKIA1234567890123456']) {
    for (const channel of ['metadata', 'input', 'reply']) {
      for (const position of ['value', 'key', 'root-key']) {
        const payload = position === 'value' ? value : { [value]: 'public' };
        const call = syntheticSkillCall();
        const reply = syntheticSkillResult();
        if (channel === 'input') call.message.content[0].input = position === 'root-key' ? payload : { opaque: payload };
        if (channel === 'reply') reply.message.content[0].content = payload;
        const trace = syntheticTrace([call, reply]);
        if (channel === 'metadata') trace.stdout = trace.stdout.replace('"skills":["agent-init"]', JSON.stringify({ skills: [payload] }).slice(1, -1));
        const result = parseClaudeTrace(trace, { ...context, captureSkillEvidence: true });
        assert.equal(result.code, channel === 'metadata' ? 'SELECTION_PROTOCOL_UNVERIFIED' : 'PRIVATE_SKILL_SAMPLE', `${channel}: ${position}`);
        assert.equal(result.status, channel === 'metadata' ? 'blocked' : 'error', `${channel}: ${position}`);
        if (channel === 'metadata') {
          assert.deepEqual(result.provenance.unverifiedInitSkillMetadata, {
            omitted: true, exhaustiveCatalogProven: false, selectionProtocolVerified: false,
          });
          assert.equal(result.provenance.skillSamples.length, 1);
          assert.equal(result.provenance.toolCalls[0].isError, false);
        }
        assert.equal(JSON.stringify(result).includes(value), false, `${channel}: ${position}`);
        assert.equal(Object.hasOwn(result, 'loaded'), false, `${channel}: ${position}`);
      }
    }
  }
});

test('diagnostic identifiers are screened before retention even when Skill sampling is disabled', () => {
  const value = 'ghs_SYNTHETICCANARY0123456789';
  for (const captureSkillEvidence of [false, true]) {
    for (const field of ['input', 'id', 'name']) {
      const call = syntheticSkillCall();
      const reply = syntheticSkillResult();
      const block = call.message.content[0];
      if (field === 'input') block.input = { [value]: 'public' };
      else block[field] = value;
      if (field === 'id') reply.message.content[0].tool_use_id = value;
      const result = parseClaudeTrace(syntheticTrace([call, reply]), { ...context, captureSkillEvidence });
      assert.equal(result.code, field === 'name' ? 'UNEXPECTED_TOOL' : 'PRIVATE_SKILL_SAMPLE');
      assert.equal(result.status, 'error');
      assert.equal(JSON.stringify(result).includes(value), false, field);
      assert.equal(Object.hasOwn(result, 'loaded'), false);
    }
  }
});

test('sample rejection identifies the native field without retaining its content', () => {
  for (const channel of ['metadata', 'input', 'reply']) {
    const value = 'configuration: synthetic-private-value';
    const call = syntheticSkillCall();
    const reply = syntheticSkillResult();
    if (channel === 'input') call.message.content[0].input = { opaque: value };
    if (channel === 'reply') reply.message.content[0].content = value;
    const trace = syntheticTrace([call, reply]);
    if (channel === 'metadata') trace.stdout = trace.stdout.replace('"skills":["agent-init"]', JSON.stringify({ skills: [value] }).slice(1, -1));
    const result = parseClaudeTrace(trace, { ...context, captureSkillEvidence: true });
    if (channel === 'metadata') {
      assert.equal(result.code, 'SELECTION_PROTOCOL_UNVERIFIED');
      assert.deepEqual(result.provenance.unverifiedInitSkillMetadata, {
        omitted: true, exhaustiveCatalogProven: false, selectionProtocolVerified: false,
      });
      assert.equal(Object.hasOwn(result, 'location'), false);
    } else {
      assert.equal(result.code, 'PRIVATE_SKILL_SAMPLE');
      assert.deepEqual(result.location, { messageIndex: channel === 'input' ? 1 : 2,
        blockIndex: 0, field: channel === 'input' ? 'input' : 'content' });
    }
    assert.equal(JSON.stringify(result).includes(value), false);
  }
});

test('unrepresentable numbers cannot silently change retained native metadata', () => {
  for (const literal of ['1e400', '9007199254740993']) {
    const trace = syntheticTrace();
    trace.stdout = trace.stdout.replace('"skills":["agent-init"]', `"skills":{"opaque":${literal}}`);
    const result = parseClaudeTrace(trace, context);
    assert.equal(result.code, 'TRACE_NUMBER_UNREPRESENTABLE');
    assert.equal(result.status, 'error');
    assert.equal(Object.hasOwn(result.provenance, 'unverifiedInitSkillMetadata'), false);
    assert.equal(Object.hasOwn(result, 'loaded'), false);
  }
});

test('configured secrets in raw and decoded inventory keys or values remain fatal before omission', () => {
  const secret = 'ACTUAL-INVENTORY-CANARY-ONLY';
  for (const channel of ['input', 'metadata-value', 'metadata-key', 'metadata-nested-value', 'metadata-nested-key']) {
    for (const escaped of [false, true]) {
      const call = syntheticSkillCall();
      if (channel === 'input') call.message.content[0].input.opaque = secret;
      const trace = syntheticTrace([call, syntheticSkillResult()]);
      if (channel !== 'input') {
        let inventory = channel.endsWith('key') ? { [secret]: 'public' } : secret;
        if (channel.includes('nested')) inventory = { opaque: [{ nested: inventory }] };
        trace.stdout = trace.stdout.replace('"skills":["agent-init"]', JSON.stringify({ skills: inventory }).slice(1, -1));
      }
      if (escaped) {
        trace.stdout = trace.stdout.replaceAll(secret, `\\u0041${secret.slice(1)}`);
        assert.equal(trace.stdout.includes(secret), false);
      }
      const result = parseClaudeTrace(trace, { ...context, captureSkillEvidence: true, secrets: [secret] });
      assert.equal(result.code, 'SECRET_TRACE', `${channel}: escaped=${escaped}`);
      assert.equal(result.status, 'error');
      assert.equal(JSON.stringify(result).includes(secret), false);
      assert.equal(Object.hasOwn(result.provenance, 'unverifiedInitSkillMetadata'), false);
      assert.equal(Object.hasOwn(result, 'loaded'), false);
    }
  }
});

test('failed processes cannot become empty or successful observations', () => {
  for (const [change, code] of [
    [{ status: 1 }, 'PROCESS_FAILED'],
    [{ cleanupError: { code: 'EPERM', signal: 'SIGKILL' } }, 'PROCESS_CLEANUP_FAILED'],
    [{ signal: 'SIGTERM', stopReason: 'API_RETRY' }, 'API_RETRY'],
    [{ signal: 'SIGTERM', stopReason: 'PERMISSION_DENIED' }, 'PERMISSION_DENIED'],
    [{ status: null, spawnError: new Error('private error text') }, 'PROCESS_UNAVAILABLE'],
    [{ signal: 'SIGTERM' }, 'PROCESS_INTERRUPTED'],
    [{ timedOut: true }, 'PROCESS_TIMEOUT'],
    [{ truncated: true }, 'TRACE_TRUNCATED'],
  ]) {
    const result = parseClaudeTrace({ ...syntheticTrace(), ...change }, context);
    assert.equal(result.status, 'error');
    assert.equal(result.code, code);
    assert.equal(Object.hasOwn(result, 'loaded'), false);
    assert.equal(JSON.stringify(result).includes('private error text'), false);
  }
});
