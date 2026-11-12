import { statSync } from 'node:fs';
import { childFile, listChildRuns, matchChild, readSessionText, sessionFileFor } from './locate.mjs';
import { mergeLive, parseSessionText, toView } from './parse.mjs';

export function pickSession(requested, current, sessions) {
  const ids = new Set((sessions ?? []).map((session) => session.id).filter(Boolean));
  if (current) ids.add(current);
  if (typeof requested === 'string' && ids.has(requested)) return requested;
  if (current && ids.has(current)) return current;
  return sessions?.[0]?.id || current || '';
}

export function loadParsed(userData, sessionId, cache) {
  const file = sessionFileFor(userData, sessionId);
  if (!file) return { parsed: null, file: false };
  let stat;
  try {
    stat = statSync(file);
  } catch {
    return { parsed: null, file: false, missing: true };
  }
  const key = `${file}:${stat.mtimeMs}:${stat.size}`;
  const hit = cache?.get(sessionId);
  if (hit?.key === key) return { parsed: hit.parsed, file: true };
  let parsed;
  try {
    const read = readSessionText(file);
    parsed = parseSessionText(read.text, { truncated: read.truncated });
  } catch {
    return { parsed: null, file: false, missing: true };
  }
  cache?.set(sessionId, { key, parsed });
  if (cache && cache.size > 8) cache.delete(cache.keys().next().value);
  return { parsed, file: true };
}

export function attachChildren(parsed, runs) {
  if (!parsed || !runs?.length) return parsed;
  for (const turn of parsed.turns) {
    for (const item of turn.items) {
      if (item.kind !== 'agent' || !item.agent) continue;
      const run = matchChild(runs, { ...item.agent, at: item.at || 0 });
      if (!run) continue;
      item.child = {
        childId: run.childId,
        name: run.name,
        title: run.title || '',
        agentType: run.agentType || '',
        file: run.file,
      };
    }
  }
  return parsed;
}

export function compose({ parsed, live, runs, meta }) {
  const merged = attachChildren(mergeLive(parsed, live), runs);
  return { view: toView(merged, meta), details: merged.details, merged };
}

export function childTrajectory(userData, parentId, child) {
  if (!userData || !child?.file) return null;
  const runs = listChildRuns(userData, parentId);
  const run = runs.find((item) => item.childId === child.childId && item.file === child.file) ?? {
    ...child,
    startedAt: 0,
  };
  const file = childFile(userData, parentId, run);
  if (!file) return null;
  try {
    const read = readSessionText(file);
    const parsed = parseSessionText(read.text, { truncated: read.truncated });
    const view = toView(parsed, { sessionId: child.childId, title: child.title || child.name, file: true });
    return {
      title: child.title || child.name || '子代理',
      name: child.name || '',
      agentType: child.agentType || '',
      truncated: parsed.truncated,
      stats: view.stats,
      turns: view.turns.slice(-12),
    };
  } catch {
    return null;
  }
}
