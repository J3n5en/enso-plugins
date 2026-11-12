import { createHash } from 'node:crypto';

/** 与 Enso src/agent/mcpNames.ts 的 mcpNamespaceName 一致。工具调用名是 mcp__<slug>__<tool>。 */
export function mcpNamespaceName(serverName) {
  const slug =
    String(serverName || '')
      .replace(/[^A-Za-z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '') || `server_${shortHash(String(serverName || ''))}`;
  return `mcp__${slug}`;
}

function shortHash(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 8);
}

export function parseMcpToolName(name) {
  if (typeof name !== 'string' || !name.startsWith('mcp__')) return null;
  const rest = name.slice('mcp__'.length);
  const split = rest.indexOf('__');
  if (split <= 0) return { namespace: `mcp__${rest}`, tool: '' };
  return { namespace: `mcp__${rest.slice(0, split)}`, tool: rest.slice(split + 2) };
}

const PLUGIN_ID = /^[a-z][a-z0-9]*(\.[a-z0-9]+)+$/;
const LOCAL_ID = /^[a-z][a-z0-9-]{0,31}$/;

/** 与 Enso parsePluginPresetId 一致：plugin:<插件 id>:<预设 id>。 */
export function parsePluginPresetId(id) {
  if (typeof id !== 'string' || !id.startsWith('plugin:')) return null;
  const rest = id.slice('plugin:'.length);
  const split = rest.lastIndexOf(':');
  if (split <= 0) return null;
  const pluginId = rest.slice(0, split);
  const localId = rest.slice(split + 1);
  if (!PLUGIN_ID.test(pluginId) || !LOCAL_ID.test(localId)) return null;
  return { pluginId, localId };
}

export function pluginPresetId(pluginId, localId) {
  return `plugin:${pluginId}:${localId}`;
}

/** 插件 MCP 在会话里的服务名：plugin-<id 的点换成横线>-<清单里的名字>。 */
export function extensionMcpName(pluginId, name) {
  return `plugin-${String(pluginId).replaceAll('.', '-')}-${name}`;
}
