/** 只解析技能 frontmatter 里用到的字段，不引入 YAML 依赖。 */

export function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text || ''));
  if (!match) return { name: '', description: '', disableModelInvocation: false };
  const data = parseYamlBlock(match[1]);
  const disable = data['disable-model-invocation'];
  return {
    name: textOf(data.name),
    description: textOf(data.description),
    disableModelInvocation: disable === true || disable === 'true' || disable === 'yes',
  };
}

function textOf(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseYamlBlock(yaml) {
  const data = {};
  const lines = yaml.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith('#')) {
      i += 1;
      continue;
    }
    const found = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!found) {
      i += 1;
      continue;
    }
    const key = found[1];
    const raw = found[2];
    if (raw === '|' || raw === '|-' || raw === '>' || raw === '>-') {
      const block = [];
      const fold = raw.startsWith('>');
      i += 1;
      while (i < lines.length && (lines[i].startsWith(' ') || lines[i].startsWith('\t'))) {
        block.push(lines[i].replace(/^\s{2}/, '').replace(/^\t/, ''));
        i += 1;
      }
      data[key] = block.join(fold ? ' ' : '\n').trim();
      continue;
    }
    data[key] = unquote(raw.trim());
    i += 1;
  }
  return data;
}

function unquote(value) {
  if (value.length >= 2) {
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote)) return value.slice(1, -1);
  }
  return value;
}
