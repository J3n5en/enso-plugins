import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { activate } from '../packages/enso.skillusage/main.mjs';
import { loadReport } from '../packages/enso.skillusage/lib/disk.mjs';
import { userDataCandidates } from '../packages/enso.skillusage/lib/paths.mjs';
import { buildReport } from '../packages/enso.skillusage/lib/report.mjs';
import { scanSessionText, skillNamesInUserText } from '../packages/enso.skillusage/lib/sessions.mjs';
import { parseFrontmatter } from '../packages/enso.skillusage/lib/skillfile.mjs';
import { charsToTokens, skillBlock } from '../packages/enso.skillusage/lib/tokens.mjs';

const NOW = Date.parse('2026-11-12T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

test('userData 指向 Enso 的打包目录和开发目录', () => {
  const home = '/Users/me';
  const mac = userDataCandidates({}, 'darwin', home).map((item) => item.path);
  assert.deepEqual(mac, [
    '/Users/me/Library/Application Support/enso-code',
    '/Users/me/Library/Application Support/enso-code-dev',
  ]);
  const linux = userDataCandidates({ XDG_CONFIG_HOME: '/xdg' }, 'linux', home).map((item) => item.path);
  assert.deepEqual(linux, ['/xdg/enso-code', '/xdg/enso-code-dev']);
  const win = userDataCandidates({ APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, 'win32', home).map((item) => item.path);
  assert.equal(win[0], 'C:\\Users\\me\\AppData\\Roaming/enso-code');
});

test('frontmatter 读出描述、折叠块和 disable-model-invocation', () => {
  const meta = parseFrontmatter('---\nname: demo\ndescription: >\n  第一句\n  第二句\ndisable-model-invocation: true\n---\n\n正文');
  assert.equal(meta.name, 'demo');
  assert.equal(meta.description, '第一句 第二句');
  assert.equal(meta.disableModelInvocation, true);
  assert.equal(charsToTokens(4), 1);
  assert.match(skillBlock({ name: 'a&b', description: 'd', location: '/x' }), /<name>a&amp;b<\/name>/);
});

test('会话里只抽出名字，不留提示词', () => {
  const text = [
    sessionLine({ type: 'session', version: 3, id: 's1', timestamp: new Date(NOW).toISOString(), cwd: '/work/proj' }),
    message('user', NOW, '/skill:big SECRET_PROMPT see /skill:nope'),
    message('assistant', NOW, [
      { type: 'toolCall', id: 'r', name: 'read', arguments: { path: '/skills/big/SKILL.md' } },
      { type: 'toolCall', id: 'm', name: 'mcp__notes__list', arguments: { query: 'SECRET_PROMPT' } },
      { type: 'toolCall', id: 'a', name: 'subagent', arguments: { operation: 'spawn', agent_type: 'scout', prompt: 'SECRET_PROMPT' } },
      { type: 'toolCall', id: 'l', name: 'subagent', arguments: { operation: 'list' } },
    ], { model: 'opus', provider: 'anthropic' }),
    message('user', NOW, '<skill name="proj-skill" location="/x">\nSECRET_PROMPT\n</skill>'),
  ].join('\n');
  const { events } = scanSessionText(text);
  assert.deepEqual(skillNamesInUserText('  /skill:a /skill:b 剩下'), ['a', 'b']);
  assert.deepEqual(
    events.map((event) =>
      event.kind === 'skill-read'
        ? `skill-read:${event.path}`
        : `${event.kind}:${event.name}${event.tool ? `:${event.tool}` : ''}`,
    ),
    ['skill:big', 'skill-read:/skills/big/SKILL.md', 'mcp:mcp__notes:list', 'agent:scout', 'skill:proj-skill'],
  );
  assert.equal(JSON.stringify(events).includes('SECRET_PROMPT'), false);
  assert.equal(events.find((event) => event.kind === 'skill' && event.name === 'big').model, 'opus');
});

test('预设、项目和时间窗口决定谁进提示词、谁算未使用', () => {
  const entries = [
    skill({ name: 'big', settingsId: 'big', enabled: true, description: '很大的说明'.repeat(20) }),
    skill({ name: 'quiet', settingsId: 'quiet', enabled: true, description: '短' }),
    skill({ name: 'local', origin: 'local', projectPath: '/work/proj', description: '项目技能' }),
    mcp({ name: 'notes', settingsId: 'notes', loadMode: 'direct' }),
    mcp({ name: 'lazy-tools', settingsId: 'lazy', loadMode: 'deferred', description: '按需' }),
  ];
  const events = [
    { kind: 'skill', name: 'big', ts: NOW, cwd: '/work/proj', sessionId: 's', model: 'm', provider: 'p', profile: 'packaged' },
    { kind: 'skill', name: 'old', ts: NOW - 100 * DAY, cwd: '/work/proj', sessionId: 's', profile: 'packaged' },
  ];
  const report = buildReport({
    now: NOW,
    platform: 'linux',
    profiles: [{ id: 'packaged', loadLocalSkills: true, loadHarnessAssets: false }],
    presets: [{ profile: 'packaged', id: 'focus', name: '专注', skillIds: ['quiet'], mcpServerIds: ['lazy'], pluginPresetId: '' }],
    entries,
    events,
    filter: { days: 30, project: '/work/proj', preset: 'focus' },
  });
  const byName = Object.fromEntries(report.cards.map((card) => [card.name, card]));
  assert.equal(byName.quiet.inPrompt, true);
  assert.equal(byName.big.inPrompt, false);
  assert.equal(byName.local.inPrompt, false);
  assert.equal(byName.notes.inPrompt, false);
  assert.equal(byName['lazy-tools'].inPrompt, true);
  assert.equal(byName['lazy-tools'].loadedTokens > 0, true);
  assert.equal(byName.notes.loadedTokens, null);
  assert.equal(report.unused.some((card) => card.name === 'old'), false);
  assert.equal(report.unused[0].name, 'quiet');
});

test('从 Enso 的 userData 出报告，不扫 ~/.claude 的会话和密钥', async () => {
  const home = await mkdtemp(join(tmpdir(), 'enso-skill-home-'));
  const cacheDir = await mkdtemp(join(tmpdir(), 'enso-skill-cache-'));
  try {
    const userData = join(home, '.config', 'enso-code');
    const proj = join(home, 'proj');
    const other = join(home, 'other');
    const pluginRoot = join(home, 'claude-plugin');
    await writeSkill(join(userData, 'skills-src', 'big'), 'big', '设置里的大技能');
    await writeSkill(join(userData, 'skills-src', 'off'), 'off', '停用的');
    await writeSkill(join(userData, 'skills-src', 'focus-only'), 'focus-only', '只在专注预设');
    await writeSkill(join(userData, 'skills-src', 'old'), 'old', '很久以前用过');
    await writeSkill(join(home, '.agents', 'skills', 'dup'), 'dup', 'from global');
    await writeSkill(join(home, '.agents', 'skills', 'global-skill'), 'global-skill', '全局技能');
    await writeSkill(join(proj, '.agents', 'skills', 'dup'), 'dup', 'from project');
    await writeSkill(join(proj, '.agents', 'skills', 'proj-skill'), 'proj-skill', '项目技能');
    await writeSkill(join(proj, '.claude', 'skills', 'harness-skill'), 'harness-skill', '其它工具目录');
    await writeSkill(join(pluginRoot, 'skills', 'plug-skill'), 'plug-skill', '插件技能');
    await mkdir(join(pluginRoot, 'agents'), { recursive: true });
    await writeFile(join(pluginRoot, 'agents', 'helper.md'), '---\nname: helper\ndescription: 插件子代理\n---\n\nSECRET_PROMPT\n');
    await writeFile(
      join(pluginRoot, '.mcp.json'),
      JSON.stringify({ mcpServers: { plugmcp: { command: 'node', env: { TOKEN: 'SECRET_ENV' } } } }),
    );
    await mkdir(join(home, '.claude', 'plugins'), { recursive: true });
    await writeFile(
      join(home, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({ plugins: { 'demo@local': [{ scope: 'user', installPath: pluginRoot, version: '1.0.0' }] } }),
    );
    await writeFile(
      join(home, '.claude.json'),
      JSON.stringify({ mcpServers: { UNIQUE_CLAUDE_JSON: { command: 'secret' } } }),
    );
    await mkdir(join(home, '.claude', 'projects'), { recursive: true });
    await writeFile(join(home, '.claude', 'projects', 'lost.jsonl'), message('user', NOW, '/skill:UNIQUE_CLAUDE_SESSION'));

    const pkg = join(userData, 'extension-plugins', 'packages', 'enso.demo', 'abcd');
    await writeSkill(join(pkg, 'skills', 'always'), 'always-skill', '每个会话都在');
    await writeSkill(join(pkg, 'skills', 'tight'), 'tight-skill', '只在插件预设');
    await mkdir(join(userData, 'extension-plugins'), { recursive: true });
    await writeFile(
      join(pkg, 'enso-plugin.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'enso.demo',
        name: 'Demo',
        version: '1.0.0',
        contributes: {
          skills: ['skills/always', 'skills/tight'],
          mcpServers: [{ name: 'lint', command: 'node', env: { TOKEN: 'SECRET_ENV' } }],
          agentTypes: [{ name: 'demo-reviewer', description: '插件审查', systemPrompt: 'prompts/x.md', tools: 'readonly' }],
          presets: [{ id: 'tight', name: '收紧', skills: ['skills/tight'], mcpServers: [], agentTypes: [] }],
        },
      }),
    );
    await writeFile(
      join(userData, 'extension-plugins', 'registry.json'),
      JSON.stringify({ version: 2, plugins: [{ id: 'enso.demo', dir: 'abcd', state: 'enabled' }] }),
    );
    await writeFile(
      join(userData, 'mcp-tool-catalog.json'),
      JSON.stringify({ servers: { notes: { signature: 'x', tools: ['list', 'get'] } } }),
    );
    await writeFile(
      join(userData, 'settings.json'),
      JSON.stringify({
        'enso-settings': {
          state: {
            loadLocalSkills: true,
            loadHarnessAssets: true,
            skills: [
              { id: 'big', name: 'big', description: '设置描述', path: join(userData, 'skills-src', 'big'), enabled: true, source: '设置' },
              { id: 'off', name: 'off', description: '停用', path: join(userData, 'skills-src', 'off'), enabled: false },
              { id: 'focus-only', name: 'focus-only', description: '预设专用', path: join(userData, 'skills-src', 'focus-only'), enabled: false },
              { id: 'old', name: 'old', description: '旧技能', path: join(userData, 'skills-src', 'old'), enabled: true },
            ],
            mcpServers: [
              {
                id: 'notes',
                name: 'notes',
                description: '笔记',
                transport: 'stdio',
                enabled: true,
                loadMode: 'direct',
                command: 'node',
                env: { TOKEN: 'SECRET_ENV' },
                url: 'https://evil.example/SECRET_URL_TOKEN',
                headers: { Authorization: 'SECRET_HEADER' },
              },
              {
                id: 'lazy',
                name: 'lazy-tools',
                description: '按需',
                transport: 'http',
                enabled: true,
                loadMode: 'deferred',
                url: 'https://evil.example/SECRET_URL_TOKEN',
              },
            ],
            presets: [{ id: 'focus', name: '专注', skillIds: ['focus-only'], mcpServerIds: ['lazy'] }],
            agentTypes: [{ id: 'a1', name: 'auditor', description: '看 diff', systemPrompt: 'SECRET_PROMPT' }],
            disabledBuiltinAgentTypes: ['tester'],
            plugins: [{ id: 'p', key: 'demo@local', name: 'Demo', enabled: true, description: '', source: 'claude' }],
            projects: [{ id: 'p1', path: proj, name: '演示项目' }],
            providers: [{ apiKey: 'SECRET_API_KEY' }],
          },
        },
      }),
    );
    const bigFile = join(userData, 'skills-src', 'big', 'SKILL.md');
    await mkdir(join(userData, 'agent', 'sessions'), { recursive: true });
    await writeFile(
      join(userData, 'agent', 'sessions', 's1.jsonl'),
      [
        sessionLine({ type: 'session', version: 3, id: 's1', timestamp: new Date(NOW).toISOString(), cwd: proj }),
        message('user', NOW, '/skill:big SECRET_PROMPT see /skill:nope'),
        message(
          'assistant',
          NOW,
          [
            { type: 'toolCall', id: 'r', name: 'read', arguments: { path: bigFile } },
            { type: 'toolCall', id: 'm', name: 'mcp__notes__list', arguments: {} },
            { type: 'toolCall', id: 'z', name: 'mcp__lazy_tools__ping', arguments: {} },
            { type: 'toolCall', id: 'a', name: 'subagent', arguments: { operation: 'spawn', agent_type: 'scout', prompt: 'SECRET_PROMPT' } },
            { type: 'toolCall', id: 'b', name: 'subagent', arguments: { operation: 'spawn', agent_type: 'auditor', prompt: 'SECRET_PROMPT' } },
            { type: 'toolCall', id: 'l', name: 'subagent', arguments: { operation: 'list' } },
          ],
          { model: 'opus', provider: 'anthropic' },
        ),
        message('user', NOW, '<skill name="proj-skill" location="/x">\n正文\n</skill>'),
        message('user', NOW - 100 * DAY, '/skill:old SECRET_PROMPT'),
      ].join('\n'),
    );
    await writeFile(
      join(userData, 'agent', 'sessions', 's2.jsonl'),
      [sessionLine({ type: 'session', version: 3, id: 's2', timestamp: new Date(NOW).toISOString(), cwd: other }), message('user', NOW, '/skill:global-skill')].join('\n'),
    );

    const options = {
      env: {},
      platform: 'linux',
      homedir: home,
      now: NOW,
      cacheDir,
      filter: { days: 30, project: proj, preset: 'default' },
    };
    const report = await loadReport(options);
    const dumped = JSON.stringify(report);
    for (const secret of ['SECRET_ENV', 'SECRET_URL_TOKEN', 'SECRET_HEADER', 'SECRET_PROMPT', 'SECRET_API_KEY', 'UNIQUE_CLAUDE_JSON', 'UNIQUE_CLAUDE_SESSION']) {
      assert.equal(dumped.includes(secret), false, secret);
    }
    const byName = Object.fromEntries(report.cards.map((card) => [card.name, card]));
    assert.equal(byName.big.inPrompt, true);
    assert.equal(byName.big.calls, 2);
    assert.equal(byName.big.models[0], 'anthropic/opus');
    assert.equal(byName.off.inPrompt, false);
    assert.equal(byName['focus-only'].inPrompt, false);
    assert.equal(byName['proj-skill'].inPrompt, true);
    assert.equal(byName['proj-skill'].calls, 1);
    assert.equal(byName['proj-skill'].project, '演示项目');
    assert.equal(byName.dup.inPrompt, true);
    assert.equal(byName.dup.description, 'from project');
    assert.equal(byName['harness-skill'].inPrompt, true);
    assert.equal(byName['global-skill'].inPrompt, true);
    assert.equal(byName['global-skill'].calls, 0);
    assert.equal(byName.notes.calls, 1);
    assert.equal(byName.notes.loadedTokens, null);
    assert.equal(byName.notes.toolCount, 2);
    assert.equal(byName['lazy-tools'].calls, 1);
    assert.equal(byName['lazy-tools'].loadedTokens > 0, true);
    assert.equal(byName.scout.calls, 1);
    assert.equal(byName.tester.inPrompt, false);
    assert.equal(byName.auditor.calls, 1);
    assert.equal(byName['plug-skill'].inPrompt, true);
    assert.equal(byName.plugmcp.inPrompt, true);
    assert.equal(byName['always-skill'].inPrompt, true);
    assert.equal(byName['tight-skill'].inPrompt, false);
    assert.equal(byName['demo-reviewer'].inPrompt, true);
    assert.equal(byName.old.calls, 0);
    assert.equal(report.unused.some((card) => card.name === 'old'), true);
    assert.equal(report.sources.some((source) => source.detail.includes('agent/sessions')), true);

    const focused = await loadReport({ ...options, filter: { days: 30, project: proj, preset: 'focus' } });
    const focusedBy = Object.fromEntries(focused.cards.map((card) => [card.name, card]));
    assert.equal(focusedBy['focus-only'].inPrompt, true);
    assert.equal(focusedBy.big.inPrompt, false);
    assert.equal(focusedBy['proj-skill'].inPrompt, false);
    assert.equal(focusedBy['harness-skill'].inPrompt, true);
    assert.equal(focusedBy.notes.inPrompt, false);
    assert.equal(focusedBy['lazy-tools'].inPrompt, true);

    const pluginPreset = await loadReport({
      ...options,
      filter: { days: 0, project: 'all', preset: 'plugin:enso.demo:tight' },
    });
    const pluginBy = Object.fromEntries(pluginPreset.cards.map((card) => [card.name, card]));
    assert.equal(pluginBy['tight-skill'].inPrompt, true);
    assert.equal(pluginBy['always-skill'].inPrompt, true);
    assert.equal(pluginBy['global-skill'].calls, 1);

    const again = await loadReport(options);
    assert.equal(again.cards.find((card) => card.name === 'big').calls, 2);
    const cache = JSON.parse(await readFile(join(cacheDir, 'sessions-packaged.json'), 'utf8'));
    assert.equal(cache.version, 1);
    assert.equal(JSON.stringify(cache).includes('SECRET_PROMPT'), false);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test('activate 注册 report', () => {
  let name = '';
  activate({
    dataDir: '/tmp/enso-skillusage-test',
    renderer: { handle(method) { name = method; } },
  });
  assert.equal(name, 'report');
});

function skill(extra) {
  return {
    profile: 'packaged',
    kind: 'skill',
    origin: 'settings',
    priority: 30,
    source: '设置',
    enabled: true,
    modelVisible: true,
    description: extra.description || extra.name,
    filePath: `/skills/${extra.name}/SKILL.md`,
    location: `/skills/${extra.name}/SKILL.md`,
    ...extra,
  };
}

function mcp(extra) {
  return {
    profile: 'packaged',
    kind: 'mcp',
    origin: 'settings',
    priority: extra.loadMode === 'deferred' ? 20 : 10,
    source: '设置',
    enabled: true,
    description: '',
    ...extra,
  };
}

async function writeSkill(dir, name, description) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`);
}

function sessionLine(entry) {
  return JSON.stringify(entry);
}

function message(role, ts, content, extra = {}) {
  return JSON.stringify({
    type: 'message',
    timestamp: new Date(ts).toISOString(),
    message: {
      role,
      timestamp: ts,
      content: typeof content === 'string' ? [{ type: 'text', text: content }] : content,
      ...extra,
    },
  });
}
