'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { repoRoot } = require('../helpers/fixture-vault');
const matter = require(path.join(repoRoot, 'node_modules/gray-matter'));

// Every card load goes through gray-matter. Bad YAML in one card shouldn't
// crash the engine — callers wrap matter() in try/catch by contract.

test.describe('card schema (gray-matter)', () => {
  test('well-formed frontmatter parses with correct types', () => {
    const card = `---
type: project
status: active
priority: 1
created: '2026-04-29'
---
# title
body content`;
    const m = matter(card);
    assert.strictEqual(m.data.type, 'project');
    assert.strictEqual(m.data.status, 'active');
    assert.strictEqual(m.data.priority, 1);
  });

  test('legacy card with no frontmatter returns empty data + full content', () => {
    const card = `# legacy card with no fm\nbody only`;
    const m = matter(card);
    assert.deepStrictEqual(m.data, {});
    assert.match(m.content, /legacy/);
  });

  test('malformed yaml frontmatter throws (caller contract: wrap in try/catch)', () => {
    const card = `---
type: project
priority: [unclosed
---
body`;
    assert.throws(() => matter(card));
  });
});
