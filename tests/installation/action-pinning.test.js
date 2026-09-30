import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));

function assertPinnedActions(workflow, source = 'fixture.yml') {
  let scalarIndent;
  let flowDepth = 0;
  for (const [index, line] of workflow.split('\n').entries()) {
    const indent = line.match(/^ */)[0].length;
    if (scalarIndent !== undefined && (!line.trim() || indent > scalarIndent)) continue;
    scalarIndent = undefined;
    if (/^\s*#/.test(line)) continue;

    const content = line.replace(/"(?:\\.|[^"\\])*"|'(?:''|[^'])*'|(?:^|\s)#.*$/g,
      (value) => value.trimStart().startsWith('#') ? '' : value);
    const block = content.match(/^\s*(?:-\s*)?(?:uses|'uses'|"uses")\s*:\s*(.*?)\s*$/);
    const flow = flowDepth > 0 || /^\s*(?:-\s*)?(?:[\[{]|[^:]+:\s*[\[{])/.test(content);
    const references = flow ? [...content.matchAll(
      /(?:^|[{,])\s*(?:uses|'uses'|"uses")\s*:\s*("(?:\\.|[^"\\])*"|'(?:''|[^'])*'|[^,}]+)|"(?:\\.|[^"\\])*"|'(?:''|[^'])*'/g,
    )].filter((match) => match[1] !== undefined).map((match) => match[1]) : block ? [block[1]] : [];
    if (flow) {
      const structure = content.replace(/"(?:\\.|[^"\\])*"|'(?:''|[^'])*'/g, '');
      flowDepth += (structure.match(/[\[{]/g)?.length ?? 0) - (structure.match(/[\]}]/g)?.length ?? 0);
    }
    for (const value of references) {
      const reference = value.trim().replace(/^(['"])(.*)\1$/, '$2');
      if (reference.startsWith('./')) continue;
      assert.match(reference, /^[^@\s]+@[a-f0-9]{40}$/i,
        `${source}:${index + 1}: external Action must use a full immutable commit SHA: ${reference}`);
    }
    if (/:\s*[|>][-+\d]*\s*$/.test(content)) {
      scalarIndent = content.match(/^ *(?:- *)?/)[0].length;
    }
  }
}

test('repository workflows pin every external Action to a full commit SHA', async () => {
  const directory = path.join(projectRoot, '.github/workflows');
  const workflows = (await readdir(directory)).filter((name) => /\.ya?ml$/.test(name)).sort();
  assert.ok(workflows.length > 0, 'No repository workflows found');
  for (const name of workflows) {
    const source = path.join('.github/workflows', name);
    assertPinnedActions(await readFile(path.join(directory, name), 'utf8'), source);
  }
});

const verifiedPin = '3d3c42e5aac5ba805825da76410c181273ba90b1';

for (const reference of [
  `actions/checkout@${verifiedPin}`,
  `'actions/checkout@${verifiedPin}'`,
  `"actions/checkout@${verifiedPin}"`,
  `example/actions/subdirectory@${verifiedPin}`,
  './.github/actions/build',
  "'./.github/actions/build'",
]) {
  test(`pinning check accepts ${reference}`, () => {
    assert.doesNotThrow(() => assertPinnedActions(`jobs:
  build:
    steps:
      - uses: ${reference} # version or local Action
`));
  });
}

for (const reference of [
  'actions/checkout@v7',
  'actions/checkout@main',
  'actions/checkout@refs/heads/main',
  'actions/checkout@3d3c42e',
  'actions/checkout',
  "'actions/checkout@v7'",
  '"actions/checkout@main"',
  `actions/checkout@${verifiedPin}extra`,
]) {
  test(`pinning check rejects ${reference}`, () => {
    assert.throws(() => assertPinnedActions(`jobs:
  build:
    steps:
      - uses: ${reference}
`, 'mutable.yml'), /mutable\.yml:4: external Action must use a full immutable commit SHA/);
  });
}

test('pinning check rejects mutable references in flow mappings', () => {
  assert.throws(() => assertPinnedActions(`jobs:
  build:
    steps:
      - { name: Checkout, uses: actions/checkout@v7 }
`, 'flow.yml'), /flow\.yml:4: external Action must use a full immutable commit SHA/);
});

test('pinning check rejects mutable references in continued flow mappings', () => {
  assert.throws(() => assertPinnedActions(`jobs:
  build:
    steps:
      - { name: Checkout
        , uses: actions/checkout@v7 }
`), /fixture\.yml:5: external Action must use a full immutable commit SHA/);
});

test('pinning check accepts continued pinned/local mappings and exits flow context', () => {
  assert.doesNotThrow(() => assertPinnedActions(`jobs:
  build:
    steps:
      - { name: 'Checkout { uses: actions/checkout@main }'
        , uses: 'actions/checkout@${verifiedPin}' }
      - {
          "uses": './.github/actions/build',
          name: "Local { uses: actions/checkout@main }"
        }
      - run: echo '{ uses: actions/checkout@main }'
`));
});

test('pinning check accepts pinned and local flow mappings', () => {
  assert.doesNotThrow(() => assertPinnedActions(`jobs:
  verify: { uses: example/actions/.github/workflows/verify.yml@${verifiedPin} }
  build:
    steps:
      - { name: Checkout, uses: "actions/checkout@${verifiedPin}" }
      - { uses: './.github/actions/build' }
`));
});

test('pinning check covers quoted uses keys', () => {
  assert.doesNotThrow(() => assertPinnedActions(`- 'uses': actions/checkout@${verifiedPin}`));
  assert.throws(() => assertPinnedActions('- "uses": actions/checkout@main'), /full immutable commit SHA/);
  assert.throws(() => assertPinnedActions('- { "uses": actions/checkout@v7 }'), /full immutable commit SHA/);
});

test('pinning check ignores commented references and block-scalar script contents', () => {
  assert.doesNotThrow(() => assertPinnedActions(`jobs:
  build:
    steps:
      # - uses: actions/checkout@main
      - run: |
          uses: not-an-action
          echo '{ uses: actions/checkout@main }'
      - uses: actions/checkout@${verifiedPin}
`));
});

test('pinning check ignores uses-like text in ordinary YAML scalar values', () => {
  assert.doesNotThrow(() => assertPinnedActions(`jobs:
  build:
    name: Example { uses: actions/checkout@main }
    steps:
      - run: echo '{ uses: actions/checkout@main }'
      - { run: "echo '{ uses: actions/checkout@main }'" }
      - { name: 'Example { uses: actions/checkout@main }', run: echo build }
      - uses: actions/checkout@${verifiedPin}
`));
});

test('inline comments cannot hide a mutable Action as block-scalar content', () => {
  assert.throws(() => assertPinnedActions(`jobs:
  build:
    steps: # example: |
      - uses: actions/checkout@main
`), /fixture\.yml:4: external Action must use a full immutable commit SHA/);
});

for (const marker of ['|', '>-']) {
  test(`pinning check resumes at sibling keys after a ${marker} step name`, () => {
    assert.throws(() => assertPinnedActions(`jobs:
  build:
    steps:
      - name: ${marker}
          Checkout repository
        uses: actions/checkout@v7
`), /fixture\.yml:6: external Action must use a full immutable commit SHA/);
  });
}

test('pinning check ignores uses-like text in inline comments', () => {
  assert.doesNotThrow(() => assertPinnedActions(`jobs:
  build:
    steps:
      - run: printf done # example { uses: actions/checkout@v7 }
      - { run: printf done } # example { uses: actions/checkout@main }
`));
});

test('pinning check resumes after a block-scalar script', () => {
  assert.throws(() => assertPinnedActions(`jobs:
  build:
    steps:
      - run: >-
          echo build
      - uses: actions/checkout@main
`), /fixture\.yml:6: external Action must use a full immutable commit SHA/);
});

test('pinning check covers reusable workflow references and later jobs', () => {
  assert.doesNotThrow(() => assertPinnedActions(`jobs:
  verify:
    uses: example/actions/.github/workflows/verify.yml@${verifiedPin}
  local:
    uses: ./.github/workflows/local.yml
`));
  assert.throws(() => assertPinnedActions(`jobs:
  build:
    steps:
      - uses: actions/checkout@${verifiedPin}
  verify:
    uses: example/actions/.github/workflows/verify.yml@main
`, 'reusable.yml'), /reusable\.yml:6: external Action must use a full immutable commit SHA/);
});
