import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_MESSAGES = 200;
const MAX_TEXT = 24_000;
const RECENT_MEMBER_MS = 30 * 60 * 1000;
const PERMISSION_HINT =
  '未允许向其他会话发送消息：请到「设置 → 插件 → Session Bridge」打开“允许向任意运行中的会话发送消息”';

const rootIdOf = (id) => (typeof id === 'string' && id ? id.split('::')[0] : '');
const trimText = (v, max = MAX_TEXT) => String(v ?? '').trim().slice(0, max);
const shortId = (id) => String(id ?? '').slice(0, 8);

async function tryOpenView(enso, sessionId) {
  if (typeof enso?.ui?.view?.open !== 'function') return false;
  try {
    await enso.ui.view.open(
      sessionId ? { viewId: 'bridge', sessionId } : 'bridge'
    );
    return true;
  } catch {
    return false;
  }
}

function tryEmit(enso, name, data) {
  try {
    enso?.ui?.view?.emit?.(name, data);
  } catch {
    // 侧栏未打开或处于非调用上下文时忽略
  }
}

export function activate(enso) {
  let chain = Promise.resolve();
  const locked = (fn) => {
    const p = chain.then(fn);
    chain = p.catch(() => {});
    return p;
  };

  // targetSessionId -> Array<{ requestId, projectRoot, fromKind, fromId, fromTitle, targetId, targetTitle, wait, notify }>
  const pendingByTarget = new Map();

  const roomKey = (projectRoot) =>
    projectRoot
      ? createHash('sha256').update(String(projectRoot)).digest('hex').slice(0, 16)
      : 'default';

  const fileFor = (projectRoot) => join(enso.dataDir, 'rooms', `${roomKey(projectRoot)}.json`);

  const loadRoom = async (projectRoot) => {
    try {
      const raw = JSON.parse(await readFile(fileFor(projectRoot), 'utf8'));
      if (Array.isArray(raw?.messages)) {
        return { rev: Number(raw.rev) || 0, messages: raw.messages };
      }
    } catch {}
    return { rev: 0, messages: [] };
  };

  const saveRoom = async (projectRoot, room) => {
    room.rev = (Number(room.rev) || 0) + 1;
    if (room.messages.length > MAX_MESSAGES) {
      room.messages = room.messages.slice(-MAX_MESSAGES);
    }
    const dir = join(enso.dataDir, 'rooms');
    await mkdir(dir, { recursive: true });
    const file = fileFor(projectRoot);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(room, null, 2));
    await rename(tmp, file);
    return room;
  };

  const withRoom = (projectRoot, fn) =>
    locked(async () => {
      const room = await loadRoom(projectRoot);
      const changed = await fn(room);
      return changed === false ? room : saveRoom(projectRoot, room);
    });

  const listProjectSessions = async () => {
    try {
      const res = await enso.session.list();
      const current = rootIdOf(res?.current);
      const sessions = Array.isArray(res?.sessions) ? res.sessions : [];
      return { current, sessions };
    } catch {
      return { current: '', sessions: [] };
    }
  };

  const collectParticipantIds = (messages) => {
    const ids = new Set();
    for (const m of messages ?? []) {
      if (m?.fromId && m.fromId !== 'user') ids.add(m.fromId);
      if (m?.toId && m.toId !== 'user') ids.add(m.toId);
      for (const t of m?.targets ?? []) {
        if (t?.id) ids.add(t.id);
      }
    }
    return ids;
  };

  const rankSessions = (sessions, currentId, participantIds = new Set()) => {
    const scoreOf = (s) => {
      if (s.id === currentId) return 4;
      if (s.running || (s.state && s.state !== 'idle')) return 3;
      if (participantIds.has(s.id)) return 2;
      return 1;
    };
    return [...sessions].sort((a, b) => {
      const diff = scoreOf(b) - scoreOf(a);
      if (diff !== 0) return diff;
      return (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0);
    });
  };

  const resolveTargets = (rawTargets, sessions, currentId) => {
    const queries = (Array.isArray(rawTargets) ? rawTargets : [rawTargets])
      .map((x) => String(x ?? '').trim())
      .filter(Boolean);
    const resolved = [];
    const seen = new Set();
    for (const q of queries) {
      if (q === '*' || q.toLowerCase() === 'all') {
        for (const s of sessions) {
          if (s.id !== currentId && !seen.has(s.id)) {
            seen.add(s.id);
            resolved.push(s);
          }
        }
        continue;
      }
      const exact = sessions.find((s) => s.id === q);
      const byTitle =
        exact ??
        sessions.find((s) => s.title && s.title.toLowerCase() === q.toLowerCase()) ??
        sessions.find(
          (s) =>
            (s.title && s.title.toLowerCase().includes(q.toLowerCase())) ||
            s.id.startsWith(q)
        );
      if (!byTitle) {
        const available = sessions
          .map((s) => `${s.title || '未命名会话'} (${s.id})`)
          .join('、');
        throw new Error(`找不到目标会话「${q}」${available ? `（当前同项目会话：${available}）` : ''}`);
      }
      if (!seen.has(byTitle.id)) {
        seen.add(byTitle.id);
        resolved.push(byTitle);
      }
    }
    return resolved;
  };

  const isMessageForSession = (msg, sessionId, questionById) => {
    if (!sessionId) return false;
    if (Array.isArray(msg?.clearedBy) && msg.clearedBy.includes(sessionId)) {
      return false;
    }
    if (msg?.kind === 'question') {
      return (
        msg.fromId === sessionId ||
        (Array.isArray(msg.targets) && msg.targets.some((t) => t?.id === sessionId))
      );
    }
    if (msg?.kind === 'reply') {
      if (msg.fromId === sessionId || msg.toId === sessionId) return true;
      const parent = msg.requestId ? questionById.get(msg.requestId) : null;
      if (parent) return isMessageForSession(parent, sessionId, questionById);
    }
    return false;
  };

  const filterMessagesForSession = (messages, sessionId) => {
    if (!sessionId) return [];
    const questionById = new Map();
    for (const m of messages ?? []) {
      if (m?.kind === 'question' && m.id) questionById.set(m.id, m);
    }
    return (messages ?? []).filter((m) => isMessageForSession(m, sessionId, questionById));
  };

  const buildSnapshot = async (ctx) => {
    const projectRoot = ctx?.projectRoot ?? null;
    const [{ current, sessions }, room] = await Promise.all([
      listProjectSessions(),
      locked(() => loadRoom(projectRoot)),
    ]);
    const selfId = rootIdOf(ctx?.sessionId) || current || null;
    const sessionMessages = filterMessagesForSession(room.messages, selfId);
    const participantIds = collectParticipantIds(sessionMessages);
    const ranked = rankSessions(sessions, selfId, participantIds);
    return {
      rev: room.rev,
      current: selfId,
      totalSessions: ranked.length,
      sessions: ranked,
      messages: sessionMessages,
    };
  };

  const recordReply = async ({ targetId, text, requestId, via, ctx }) => {
    const clean = trimText(text);
    if (!clean) return null;
    const queue = pendingByTarget.get(targetId) ?? [];
    let idx = -1;
    if (requestId) {
      idx = queue.findIndex((item) => item.requestId === requestId);
    } else if (queue.length > 0) {
      idx = 0;
    }
    const entry = idx >= 0 ? queue.splice(idx, 1)[0] : null;
    if (queue.length === 0) pendingByTarget.delete(targetId);

    const projectRoot = entry?.projectRoot ?? ctx?.projectRoot ?? null;
    const now = Date.now();
    const replyMsg = {
      id: `msg-${randomUUID().slice(0, 8)}`,
      kind: 'reply',
      requestId: entry?.requestId ?? requestId ?? null,
      fromKind: 'session',
      fromId: targetId,
      fromTitle: entry?.targetTitle || `会话 ${shortId(targetId)}`,
      toId: entry?.fromId ?? null,
      toTitle: entry?.fromTitle ?? '群聊',
      text: clean,
      via,
      createdAt: now,
    };

    const room = await withRoom(projectRoot, (r) => {
      if (entry?.requestId) {
        const qMsg = r.messages.find((m) => m.id === entry.requestId && m.kind === 'question');
        const targetSlot = qMsg?.targets?.find((t) => t.id === targetId);
        if (targetSlot) {
          targetSlot.status = 'replied';
          targetSlot.repliedAt = now;
          targetSlot.replyMessageId = replyMsg.id;
        }
      }
      r.messages.push(replyMsg);
    });

    tryEmit(enso, 'room', { rev: room.rev, messages: room.messages });

    if (entry) {
      entry.notify?.({ ok: true, text: clean, replyMsg });
      if (!entry.wait && entry.fromKind === 'session' && entry.fromId && entry.fromId !== targetId) {
        const callbackText = [
          `[会话桥回传 · 来自「${replyMsg.fromTitle}」(${targetId}) 对请求 #${entry.requestId} 的回复]`,
          clean,
        ].join('\n\n');
        try {
          await enso.session.inject({
            sessionId: entry.fromId,
            text: callbackText,
            deliverAs: 'followUp',
            triggerTurn: true,
          });
        } catch {
          // 原提问会话已关闭或不可注入时保留在侧栏群聊中即可
        }
      }
    }
    return { replyMsg, room, entry };
  };

  const dispatchQuestion = async ({
    fromKind,
    fromId,
    fromTitle,
    targets,
    question,
    wait,
    ctx,
  }) => {
    const cleanQuestion = trimText(question);
    if (!cleanQuestion) throw new Error('提问内容不能为空');
    if (!targets.length) throw new Error('请至少指定一个目标会话');

    const projectRoot = ctx?.projectRoot ?? null;
    const requestId = `req-${randomUUID().slice(0, 8)}`;
    const now = Date.now();

    const questionMsg = {
      id: requestId,
      kind: 'question',
      fromKind,
      fromId,
      fromTitle,
      targets: targets.map((t) => ({
        id: t.id,
        title: t.title || `会话 ${shortId(t.id)}`,
        status: 'pending',
      })),
      text: cleanQuestion,
      wait: Boolean(wait),
      createdAt: now,
    };

    const roomAfterCreate = await withRoom(projectRoot, (r) => {
      r.messages.push(questionMsg);
    });

    await tryOpenView(enso);
    tryEmit(enso, 'room', { rev: roomAfterCreate.rev, messages: roomAfterCreate.messages });

    const results = new Map();
    const replyPromises = [];

    for (const target of targets) {
      let resolveWait;
      if (wait) {
        replyPromises.push(
          new Promise((resolve) => {
            resolveWait = resolve;
          })
        );
      }
      const pendingEntry = {
        requestId,
        projectRoot,
        fromKind,
        fromId,
        fromTitle,
        targetId: target.id,
        targetTitle: target.title || `会话 ${shortId(target.id)}`,
        wait: Boolean(wait),
        notify: (outcome) => {
          results.set(target.id, outcome);
          if (wait && typeof ctx?.progress === 'function') {
            const doneCount = results.size;
            ctx.progress(
              `会话桥：已收到 ${doneCount}/${targets.length} 个会话回复（最新：${target.title || shortId(target.id)}）`
            );
          }
          resolveWait?.(outcome);
        },
      };
      const list = pendingByTarget.get(target.id) ?? [];
      list.push(pendingEntry);
      pendingByTarget.set(target.id, list);

      const promptText = [
        `[会话桥提问 #${requestId} · 来自${fromKind === 'user' ? '用户（会话桥群聊）' : `会话「${fromTitle}」(${fromId})`}]`,
        cleanQuestion,
        '---',
        `请直接回答上述问题（或调用 bridge_reply 工具并传入 requestId: "${requestId}" 回传结论）。`,
      ].join('\n');

      try {
        await enso.session.inject({
          sessionId: target.id,
          text: promptText,
          deliverAs: 'followUp',
          triggerTurn: true,
        });
      } catch (error) {
        const q = pendingByTarget.get(target.id) ?? [];
        const idx = q.indexOf(pendingEntry);
        if (idx >= 0) q.splice(idx, 1);
        if (q.length === 0) pendingByTarget.delete(target.id);

        const errMsg =
          error?.code === 'PERMISSION_DENIED'
            ? PERMISSION_HINT
            : error?.message || String(error);

        const roomAfterErr = await withRoom(projectRoot, (r) => {
          const qMsg = r.messages.find((m) => m.id === requestId);
          const slot = qMsg?.targets?.find((t) => t.id === target.id);
          if (slot) {
            slot.status = 'failed';
            slot.error = errMsg;
          }
        });
        tryEmit(enso, 'room', { rev: roomAfterErr.rev, messages: roomAfterErr.messages });

        if (error?.code === 'PERMISSION_DENIED') {
          throw new Error(PERMISSION_HINT);
        }
        pendingEntry.notify({ ok: false, error: errMsg });
      }
    }

    if (wait && typeof ctx?.progress === 'function' && results.size < targets.length) {
      const names = targets.map((t) => t.title || shortId(t.id)).join('、');
      ctx.progress(`会话桥：已向 ${names} 发送提问，正在等待回复 (${results.size}/${targets.length})…`);
    }

    if (wait) {
      if (ctx?.signal) {
        const onAbort = () => {
          for (const target of targets) {
            const q = pendingByTarget.get(target.id) ?? [];
            const idx = q.findIndex((item) => item.requestId === requestId);
            if (idx >= 0) {
              const [removed] = q.splice(idx, 1);
              removed.notify?.({ ok: false, error: '提问等待已取消' });
            }
          }
        };
        ctx.signal.addEventListener('abort', onAbort, { once: true });
      }
      await Promise.all(replyPromises);
    }

    return { requestId, results };
  };

  enso.tools.register('bridge_sessions', async (args, ctx) => {
    const [{ current, sessions }, room] = await Promise.all([
      listProjectSessions(),
      locked(() => loadRoom(ctx?.projectRoot ?? null)),
    ]);
    const selfId = current || rootIdOf(ctx?.sessionId);
    const since = Date.now() - RECENT_MEMBER_MS;
    const participantIds = collectParticipantIds(
      room.messages.filter((m) => Number(m?.createdAt) >= since)
    );
    const ranked = rankSessions(sessions, selfId, participantIds);
    const query = String(args?.query ?? '').trim().toLowerCase();
    const activeOnly = Boolean(args?.activeOnly);
    const limit = Math.max(1, Math.min(100, Number(args?.limit) || 15));

    const filtered = ranked.filter((s) => {
      if (query) {
        const hit =
          (s.title && s.title.toLowerCase().includes(query)) ||
          s.id.toLowerCase().includes(query);
        if (!hit) return false;
      }
      if (activeOnly) {
        return (
          s.id === selfId ||
          Boolean(s.running) ||
          (s.state && s.state !== 'idle') ||
          participantIds.has(s.id)
        );
      }
      return true;
    });

    const shown = filtered.slice(0, limit);
    const peers = shown.filter((s) => s.id !== selfId);
    const runningCount = ranked.filter(
      (s) => s.running || (s.state && s.state !== 'idle')
    ).length;
    const lines = shown.map(
      (s) =>
        `- ${s.id === selfId ? '[当前会话] ' : ''}${s.title || '未命名会话'} (id: ${s.id}, 状态: ${s.state}${s.running ? ', 运行中' : ''}${participantIds.has(s.id) && s.id !== selfId ? ', 群成员' : ''})`
    );
    const moreHint =
      filtered.length > shown.length
        ? `\n（已截断，仅展示前 ${shown.length}/${filtered.length} 个；可传 query 过滤或增大 limit）`
        : '';
    return {
      content: lines.length
        ? `当前项目共有 ${ranked.length} 个会话（运行中 ${runningCount} 个，展示最近 ${shown.length} 个）：\n${lines.join('\n')}${moreHint}`
        : '当前项目暂无其他活跃会话。',
      details: {
        current: selfId,
        total: ranked.length,
        runningCount,
        sessions: shown,
        peers,
      },
    };
  });

  enso.tools.register('bridge_ask', async (args, ctx) => {
    const { current, sessions } = await listProjectSessions();
    const selfId = current || rootIdOf(ctx?.sessionId);
    const selfSession = sessions.find((s) => s.id === selfId);
    const fromTitle = selfSession?.title || `会话 ${shortId(selfId)}`;
    const targets = resolveTargets(args?.targets, sessions, selfId);
    const wait = args?.wait !== false;

    const { requestId, results } = await dispatchQuestion({
      fromKind: 'session',
      fromId: selfId,
      fromTitle,
      targets,
      question: args?.question,
      wait,
      ctx,
    });

    if (!wait) {
      const targetNames = targets.map((t) => `${t.title || shortId(t.id)} (${t.id})`).join('、');
      return {
        content: `已发送提问至 ${targetNames}（请求 #${requestId}）。目标会话回复后将自动投递回当前会话，也可在右侧「会话桥」群聊面板实时查看。`,
        details: { requestId, targets: targets.map((t) => t.id), wait: false },
      };
    }

    const sections = targets.map((t) => {
      const r = results.get(t.id);
      const label = `### 来自「${t.title || shortId(t.id)}」(${t.id}) 的回复`;
      if (!r) return `${label}\n（未收到回复）`;
      if (!r.ok) return `${label}\n（发送或执行失败：${r.error}）`;
      return `${label}\n${r.text}`;
    });

    return {
      content: sections.join('\n\n'),
      details: {
        requestId,
        replies: Object.fromEntries(
          targets.map((t) => [t.id, results.get(t.id) ?? { ok: false, error: '未收到回复' }])
        ),
      },
    };
  });

  enso.tools.register('bridge_reply', async (args, ctx) => {
    const selfId = rootIdOf(ctx?.sessionId);
    if (!selfId) throw new Error('当前调用不属于任何会话');
    const recorded = await recordReply({
      targetId: selfId,
      text: args?.reply,
      requestId: typeof args?.requestId === 'string' ? args.requestId : undefined,
      via: 'tool',
      ctx,
    });
    if (!recorded) throw new Error('回复内容不能为空');
    return {
      content: `已将回复发送至会话桥群聊${recorded.entry?.fromTitle ? `（回应「${recorded.entry.fromTitle}」）` : ''}。`,
      details: { messageId: recorded.replyMsg.id, requestId: recorded.replyMsg.requestId },
    };
  });

  enso.tools.register('bridge_history', async (args, ctx) => {
    const limit = Math.max(1, Math.min(100, Number(args?.limit) || 20));
    const selfId = rootIdOf(ctx?.sessionId);
    const room = await locked(() => loadRoom(ctx?.projectRoot ?? null));
    const scoped = selfId ? filterMessagesForSession(room.messages, selfId) : room.messages;
    const recent = scoped.slice(-limit);
    if (!recent.length) {
      return { content: '当前会话暂无跨会话桥历史消息。', details: { messages: [] } };
    }
    const lines = recent.map((m) => {
      if (m.kind === 'question') {
        const toList = (m.targets ?? []).map((t) => `@${t.title}`).join(' ');
        return `[#${m.id}] ${m.fromTitle} -> ${toList}: ${m.text}`;
      }
      return `[回复 #${m.requestId || '-'}] ${m.fromTitle} -> @${m.toTitle || '群聊'}: ${m.text}`;
    });
    return {
      content: lines.join('\n\n'),
      details: { messages: recent },
    };
  });

  enso.events.on('agent_end', async (data, ctx) => {
    // 仅处理主会话结束，忽略子代理与 coworker
    if (ctx?.agent) return;
    const targetId = rootIdOf(ctx?.sessionId);
    if (!targetId) return;
    const queue = pendingByTarget.get(targetId);
    if (!queue || queue.length === 0) return;
    const text = trimText(data?.text);
    if (!text) return;
    await recordReply({
      targetId,
      text,
      via: 'agent_end',
      ctx,
    });
  });

  enso.events.on('session_status', (data) => {
    if (!data?.sessionId) return;
    tryEmit(enso, 'status', data);
  });

  enso.renderer.handle('snapshot', (_args, ctx) => buildSnapshot(ctx));

  enso.renderer.handle('focus', async (args) => {
    const sessionId = String(args?.sessionId ?? '').trim();
    if (!sessionId) throw new Error('缺少会话 id');
    await enso.session.focus(sessionId);
    await tryOpenView(enso, sessionId);
    return { ok: true };
  });

  enso.renderer.handle('abort', async (args) => {
    const sessionId = String(args?.sessionId ?? '').trim();
    if (!sessionId) throw new Error('缺少会话 id');
    await enso.session.abort(sessionId);
    return { ok: true };
  });

  enso.renderer.handle('clear', async (_args, ctx) => {
    const projectRoot = ctx?.projectRoot ?? null;
    const selfId = rootIdOf(ctx?.sessionId);
    await withRoom(projectRoot, (r) => {
      if (!selfId) {
        r.messages = [];
        return;
      }
      const questionById = new Map();
      for (const m of r.messages) {
        if (m?.kind === 'question' && m.id) questionById.set(m.id, m);
      }
      for (const m of r.messages) {
        if (isMessageForSession(m, selfId, questionById)) {
          const set = new Set(Array.isArray(m.clearedBy) ? m.clearedBy : []);
          set.add(selfId);
          m.clearedBy = [...set];
        }
      }
    });
    return buildSnapshot(ctx);
  });
}
