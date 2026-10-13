import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const skillsDir = join(root, 'skills');
const ALLOWED = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const TOOLS = ['list_requests', 'get_trace', 'slowest_endpoints', 'find_n_plus_one', 'errors_since', 'service_map'];
const PARAMS = ['errors_only'];
const BANNED = /\b(comprehensive|seamless(ly)?|powerful|robust|elevate|unlock|blazing|leverag(e|es|ing))\b/i;
const EMOJI = /\p{Extended_Pictographic}/u;

function unquote(v) {
  if (/^".*"$/.test(v)) return JSON.parse(v);
  if (/^'.*'$/.test(v)) return v.slice(1, -1).replaceAll("''", "'");
  if (/: | #/.test(v)) throw new Error(`plain scalar needs quoting: ${v}`);
  return v;
}

export function parseFrontmatter(src) {
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!m) throw new Error('missing --- frontmatter block');
  const data = {};
  let map = null;
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim()) continue;
    const nested = line.match(/^ {2}([\w.-]+):\s*(.*)$/);
    if (nested && map) {
      map[nested[1]] = unquote(nested[2]);
      continue;
    }
    const top = line.match(/^([\w-]+):\s*(.*)$/);
    if (!top) throw new Error(`unparseable frontmatter line: ${line}`);
    if (top[2] === '') {
      map = data[top[1]] = {};
    } else {
      map = null;
      data[top[1]] = unquote(top[2]);
    }
  }
  return { data, body: m[2] };
}

function slug(heading) {
  return heading.toLowerCase().trim().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name === '.git') return [];
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const skills = readdirSync(skillsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
const docs = walk(root).filter((f) => f.endsWith('.md'));

test('skills directory is not empty', () => {
  assert.ok(skills.length > 0);
});

for (const dir of skills) {
  test(`skills/${dir} follows the Agent Skills spec`, () => {
    const file = join(skillsDir, dir, 'SKILL.md');
    assert.ok(existsSync(file), 'SKILL.md missing');
    const { data, body } = parseFrontmatter(readFileSync(file, 'utf8'));

    for (const key of Object.keys(data)) assert.ok(ALLOWED.has(key), `unknown frontmatter key: ${key}`);
    assert.equal(typeof data.name, 'string', 'name required');
    assert.ok(data.name.length <= 64, 'name > 64 chars');
    assert.match(data.name, NAME_RE, 'name must be lowercase a-z, 0-9, single hyphens');
    assert.equal(data.name, dir, 'name must match folder name');
    assert.equal(typeof data.description, 'string', 'description required');
    assert.ok(data.description.length <= 1024, 'description over 1024 chars');
    assert.match(data.description, /\bUse (when|for|this)\b/i, 'description must say when to use it');
    if ('compatibility' in data) assert.ok(data.compatibility.length >= 1 && data.compatibility.length <= 500);
    if ('metadata' in data) {
      assert.equal(typeof data.metadata, 'object', 'metadata must be a map');
      for (const v of Object.values(data.metadata)) assert.equal(typeof v, 'string', 'metadata values must be strings');
    }
    assert.ok(body.split('\n').length < 500, 'SKILL.md body must stay under 500 lines');
    for (const tool of TOOLS) assert.ok(body.includes(`\`${tool}\``), `SKILL.md does not mention ${tool}`);
  });
}

test('relative links and anchors resolve', () => {
  for (const file of docs) {
    const src = readFileSync(file, 'utf8');
    for (const [, target, anchor] of src.matchAll(/\]\((?!https?:|mailto:)([^)#\s]*)(?:#([^)\s]+))?\)/g)) {
      const dest = target ? join(dirname(file), target) : file;
      const where = `${relative(root, file)} -> ${target}${anchor ? '#' + anchor : ''}`;
      assert.ok(existsSync(dest), `broken link: ${where}`);
      if (anchor && dest.endsWith('.md')) {
        const slugs = [...readFileSync(dest, 'utf8').matchAll(/^#{1,6} (.+)$/gm)].map((m) => slug(m[1]));
        assert.ok(slugs.includes(anchor), `missing anchor: ${where}`);
      }
    }
  }
});

test('docs mention only real runlens MCP tools', () => {
  for (const file of docs) {
    const src = readFileSync(file, 'utf8');
    for (const [, name] of src.matchAll(/`((?:list|get|find|slowest|errors|service)_[a-z_]+)`/g)) {
      assert.ok(TOOLS.includes(name) || PARAMS.includes(name), `${relative(root, file)}: unknown tool ${name}`);
    }
  }
});

test('no filler words or emoji in docs', () => {
  for (const file of docs) {
    const src = readFileSync(file, 'utf8');
    const word = src.match(BANNED);
    assert.equal(word, null, `${relative(root, file)}: filler word "${word?.[0]}"`);
    assert.ok(!EMOJI.test(src), `${relative(root, file)}: contains emoji`);
  }
});

test('plugin and marketplace manifests', () => {
  const plugin = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
  const market = JSON.parse(readFileSync(join(root, '.claude-plugin', 'marketplace.json'), 'utf8'));
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.match(plugin.name, NAME_RE);
  assert.ok(market.name && market.owner?.name && Array.isArray(market.plugins));
  const entry = market.plugins.find((p) => p.name === plugin.name);
  assert.ok(entry, 'marketplace must list the plugin');
  assert.ok(entry.source === './' || entry.source === '.', 'plugin source must be the repo root');
  assert.equal(plugin.version, pkg.version, 'plugin.json and package.json versions differ');
  const { data } = parseFrontmatter(readFileSync(join(skillsDir, 'trace-driven-debugging', 'SKILL.md'), 'utf8'));
  assert.equal(data.metadata.version, pkg.version, 'SKILL.md metadata.version and package.json differ');
});

test('parseFrontmatter rejects bad input', () => {
  assert.throws(() => parseFrontmatter('no frontmatter'));
  assert.throws(() => parseFrontmatter('---\nname: a\ndescription: bad: colon\n---\n'));
  assert.deepEqual(parseFrontmatter('---\nname: a\nmetadata:\n  v: "1"\n---\nx').data, { name: 'a', metadata: { v: '1' } });
  assert.equal(slug('Slow outbound calls'), 'slow-outbound-calls');
  assert.equal(slug('HTTP API without MCP'), 'http-api-without-mcp');
});
