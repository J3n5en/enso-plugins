/** 与 Enso 上下文占用同一套估算：ceil(字符数 / 4)。正文超大时用文件字节数近似。 */

export function charsToTokens(chars) {
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  return Math.ceil(chars / 4);
}

export function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** pi formatSkillsForPrompt 里每个 skill 的那一段（name / description / location）。 */
export function skillBlock(skill) {
  return [
    '  <skill>',
    `    <name>${escapeXml(skill.name)}</name>`,
    `    <description>${escapeXml(skill.description || '')}</description>`,
    `    <location>${escapeXml(skill.location || '')}</location>`,
    '  </skill>',
  ].join('\n');
}

const SKILL_HEAD = [
  '',
  '',
  'The following skills provide specialized instructions for specific tasks.',
  "Use the read tool to load a skill's file when the task matches its description.",
  "Resolve relative paths against the skill's directory (parent of SKILL.md). Use absolute paths in tool calls.",
  '',
  '<available_skills>',
].join('\n');

const SKILL_TAIL = '</available_skills>';

/** 多个可见 skill 拼成的 <available_skills> 整段 token，含只出现一次的说明。 */
export function skillsPromptTokens(skills) {
  if (!skills.length) return 0;
  const text = [SKILL_HEAD, ...skills.map((skill) => skillBlock(skill)), SKILL_TAIL].join('\n');
  return charsToTokens(text.length);
}

export function skillEntryTokens(skill) {
  return charsToTokens(skillBlock(skill).length);
}

/** 子代理类型写进 subagent 工具 agent_type 说明里的那一截，不是子会话系统提示。 */
export function agentEntryTokens(name, description) {
  return charsToTokens(`${name} (${description || 'custom'})`.length);
}

export const AGENT_LIST_PREFIX_TOKENS = charsToTokens('Agent type: '.length);

/** 按需 MCP 只在提示词里留一行名字和说明，不含工具 schema。 */
export function deferredMcpTokens(name, description) {
  const line = description ? `- ${name}: ${description}` : `- ${name}`;
  return charsToTokens(line.length);
}
