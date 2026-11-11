import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_TASKS = 50;
const MAX_PROMPT = 8000;
const MAX_HISTORY = 10;
/** 宿主每 60 秒唤醒一次；超过这个时长才发现到点（应用关闭过），视为错过不补跑 */
const GRACE_MS = 10 * 60_000;
/** 一次唤醒内守候到点的窗口，须小于唤醒间隔，避免与下一次唤醒重叠被宿主跳过 */
const WATCH_MS = 55_000;
const MINUTE = 60_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

// ---- cron：5 段（分 时 日 月 周），本地时区 ----
const BOUNDS = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

function parseField(field, min, max) {
  const out = new Set();
  for (const item of field.split(',')) {
    const [range, stepText, extra] = item.split('/');
    if (extra !== undefined) return null;
    const num = (t) => (/^\d+$/.test(t ?? '') && +t >= min && +t <= max ? +t : null);
    const step = stepText === undefined ? 1 : /^\d+$/.test(stepText) && +stepText > 0 ? +stepText : null;
    if (step === null) return null;
    let lo;
    let hi;
    if (range === '*') [lo, hi] = [min, max];
    else {
      const [a, b, more] = range.split('-');
      if (more !== undefined) return null;
      lo = num(a);
      hi = b === undefined ? (stepText === undefined ? lo : max) : num(b);
    }
    if (lo === null || hi === null || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr) {
  const fields = String(expr ?? '').trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const sets = fields.map((f, i) => parseField(f, ...BOUNDS[i]));
  if (sets.some((s) => !s)) return null;
  const [minute, hour, dom, month, dow] = sets;
  return {
    source: fields.join(' '),
    minute,
    hour,
    dom,
    month,
    dow: new Set([...dow].map((d) => d % 7)),
    domStar: fields[2].startsWith('*'),
    dowStar: fields[4].startsWith('*'),
  };
}

export function nextRun(cron, after) {
  let t = Math.floor(after / MINUTE) * MINUTE + MINUTE;
  for (let i = 0; i < 50_000; i++) {
    const d = new Date(t);
    const dayOk = (() => {
      const a = cron.dom.has(d.getDate());
      const b = cron.dow.has(d.getDay());
      return cron.domStar || cron.dowStar ? a && b : a || b;
    })();
    let next;
    if (!cron.month.has(d.getMonth() + 1)) next = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
    else if (!dayOk) next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
    else if (!cron.hour.has(d.getHours())) next = t - d.getMinutes() * MINUTE + 60 * MINUTE;
    else if (!cron.minute.has(d.getMinutes())) next = t + MINUTE;
    else return t;
    t = Math.max(next, t + MINUTE);
  }
  return null;
}

const pad = (n) => String(n).padStart(2, '0');
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

export function describeCron(cron) {
  const [min, hour, dom, month, dow] = cron.source.split(' ');
  if (month !== '*') return cron.source;
  const every = /^\*\/(\d+)$/.exec(min);
  if (hour === '*' && dom === '*' && dow === '*') {
    if (min === '*') return '每分钟';
    if (every) return `每 ${every[1]} 分钟`;
    if (/^\d+$/.test(min)) return `每小时第 ${pad(+min)} 分`;
    return cron.source;
  }
  if (!/^\d+$/.test(min) || !/^\d+$/.test(hour)) return cron.source;
  const time = `${pad(+hour)}:${pad(+min)}`;
  if (dom === '*' && dow === '*') return `每天 ${time}`;
  if (dom === '*' && dow === '1-5') return `工作日 ${time}`;
  if (dom === '*' && /^\d+(,\d+)*$/.test(dow))
    return `每周${[...cron.dow].sort().map((d) => WEEK[d]).join('、')} ${time}`;
  if (dow === '*' && /^\d+$/.test(dom)) return `每月 ${dom} 日 ${time}`;
  return cron.source;
}

// ---- 存储 ----
export function activate(enso) {
  const file = join(enso.dataDir, 'tasks.json');
  let chain = Promise.resolve();
  const locked = (fn) => {
    const p = chain.then(fn);
    chain = p.catch(() => {});
    return p;
  };

  const load = async () => {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };
  const save = async (tasks) => {
    await mkdir(enso.dataDir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(tasks, null, 2));
    await rename(tmp, file);
  };

  const arm = (task, now = Date.now()) => {
    const cron = parseCron(task.schedule);
    task.nextRunAt = task.enabled && cron ? nextRun(cron, now) : null;
  };

  const view = (tasks, ctx) => ({
    now: Date.now(),
    sessionId: ctx?.sessionId ?? null,
    // 任务按会话隔离：只返回当前会话创建的
    tasks: tasks.filter((t) => ctx?.sessionId && t.sessionId === ctx.sessionId).map((t) => {
      const cron = parseCron(t.schedule);
      return {
        ...t,
        description: cron ? describeCron(cron) : t.schedule,
        followingAt: cron && t.nextRunAt ? nextRun(cron, t.nextRunAt) : null,
      };
    }),
  });

  const explain = (error) => {
    const code = error?.code;
    if (code === 'PERMISSION_DENIED')
      return '没有向其他会话发消息的授权：到 设置 → 插件 → Scheduler 打开“允许向任意运行中的会话发送消息”';
    if (code === 'INJECT_FAILED' || code === 'NO_SESSION') return `目标会话不可用（可能已关闭）：${error.message}`;
    if (code === 'RATE_LIMITED') return '发送过于频繁，已被宿主限流';
    return error?.message ?? String(error);
  };

  const execute = async (task) => {
    if (task.action === 'prompt') {
      if (!task.sessionId) throw new Error('任务没有绑定会话');
      await enso.session.inject({
        sessionId: task.sessionId,
        text: task.prompt,
        deliverAs: 'followUp',
        triggerTurn: true,
      });
    }
    if (task.action === 'notify' || task.notify)
      await enso.ui.notify(`⏰ ${task.name}`, task.action === 'notify' ? task.prompt : '已发送到会话');
  };

  const record = (task, status, error, at = Date.now()) => {
    task.lastRunAt = at;
    task.lastStatus = status;
    task.lastError = error ?? null;
    task.history = [{ at, status, ...(error ? { error } : {}) }, ...(task.history ?? [])].slice(0, MAX_HISTORY);
  };

  const runOne = async (task) => {
    try {
      await execute(task);
      record(task, 'ok');
    } catch (error) {
      record(task, 'error', explain(error));
    }
  };

  const runDue = () =>
    locked(async () => {
      const tasks = await load();
      const now = Date.now();
      let dirty = false;
      for (const task of tasks) {
        if (!task.enabled) continue;
        if (task.nextRunAt == null) {
          arm(task, now);
          dirty = true;
          continue;
        }
        if (task.nextRunAt > now) continue;
        if (now - task.nextRunAt > GRACE_MS) record(task, 'missed', '应用未运行，已错过', task.nextRunAt);
        else await runOne(task);
        arm(task, now);
        dirty = true;
      }
      if (dirty) await save(tasks);
      return tasks;
    });

  // 宿主每分钟唤醒一次；唤醒期间守候窗口内到点的任务，让触发准点到秒
  enso.schedules.register('tick', async () => {
    const deadline = Date.now() + WATCH_MS;
    let tasks = await runDue();
    for (;;) {
      const now = Date.now();
      const next = Math.min(
        ...tasks.filter((t) => t.enabled && t.nextRunAt > now).map((t) => t.nextRunAt)
      );
      if (!Number.isFinite(next) || next > deadline) return;
      await sleep(next - now);
      tasks = await runDue();
    }
  });

  enso.renderer.handle('list', (_args, ctx) => locked(async () => view(await load(), ctx)));

  enso.renderer.handle('preview', (args) => {
    const cron = parseCron(args?.schedule);
    if (!cron) return { valid: false };
    const runs = [];
    let t = Date.now();
    for (let i = 0; i < 3; i++) {
      t = nextRun(cron, t);
      if (t == null) break;
      runs.push(t);
    }
    return { valid: runs.length > 0, description: describeCron(cron), runs };
  });

  /** 侧栏表单与 cron_create 共用：新建或按 id 更新当前会话的任务 */
  const upsert = (args, ctx) =>
    locked(async () => {
      const name = String(args?.name ?? '').trim().slice(0, 60);
      const prompt = String(args?.prompt ?? '').trim().slice(0, MAX_PROMPT);
      const action = args?.action === 'notify' ? 'notify' : 'prompt';
      const cron = parseCron(args?.schedule);
      if (!name) throw new Error('请填写任务名称');
      if (!prompt) throw new Error(action === 'prompt' ? '请填写提示词' : '请填写通知内容');
      if (!cron || nextRun(cron, Date.now()) == null) throw new Error('执行时间无效');
      if (!ctx?.sessionId) throw new Error('请先打开一个会话，任务会绑定到该会话');
      const tasks = await load();
      let task = tasks.find((t) => t.id === args?.id && t.sessionId === ctx.sessionId);
      if (!task) {
        if (tasks.length >= MAX_TASKS) throw new Error(`最多 ${MAX_TASKS} 个任务`);
        task = {
          id: randomUUID(),
          createdAt: Date.now(),
          enabled: true,
          history: [],
          sessionId: ctx.sessionId,
        };
        tasks.unshift(task);
      }
      Object.assign(task, {
        name,
        prompt,
        action,
        schedule: cron.source,
        notify: action === 'prompt' && args?.notify === true,
      });
      arm(task);
      await save(tasks);
      return { tasks, task };
    });

  enso.renderer.handle('save', async (args, ctx) => view((await upsert(args, ctx)).tasks, ctx));

  const mutate = (fn) => (args, ctx) =>
    locked(async () => {
      const tasks = await load();
      const task = tasks.find((t) => t.id === args?.id && t.sessionId === ctx?.sessionId);
      if (!task) throw new Error('任务不存在');
      const next = (await fn(task, tasks)) ?? tasks;
      await save(next);
      return view(next, ctx);
    });

  enso.renderer.handle(
    'toggle',
    mutate((task) => {
      task.enabled = !task.enabled;
      arm(task);
    })
  );
  enso.renderer.handle(
    'remove',
    mutate((task, tasks) => tasks.filter((t) => t !== task))
  );
  enso.renderer.handle('runNow', mutate(runOne));

  // ---- Agent 工具：模型自己建/看/删定时任务，等价于侧栏表单（任务同样绑当前会话） ----
  const mine = (tasks, ctx) => tasks.filter((t) => ctx?.sessionId && t.sessionId === ctx.sessionId);
  const brief = (t) => {
    const cron = parseCron(t.schedule);
    const prompt = String(t.prompt ?? '');
    return {
      id: t.id,
      name: t.name,
      schedule: t.schedule,
      description: cron ? describeCron(cron) : t.schedule,
      action: t.action === 'notify' ? 'notify' : 'prompt',
      prompt: prompt.length > 400 ? `${prompt.slice(0, 400)}…` : prompt,
      enabled: t.enabled !== false,
      notify: !!t.notify,
      nextRunAt: t.nextRunAt ?? null,
      lastRunAt: t.lastRunAt ?? null,
      lastStatus: t.lastStatus ?? null,
      lastError: t.lastError ?? null,
    };
  };
  const requireSession = (ctx) => {
    if (!ctx?.sessionId) throw new Error('只能在会话里调用，任务会绑定到该会话');
    return ctx.sessionId;
  };

  enso.tools.register('cron_create', async (args, ctx) => {
    const { tasks, task } = await upsert(args, ctx);
    const cron = parseCron(task.schedule);
    return {
      ok: true,
      task: brief(task),
      followingAt: cron && task.nextRunAt ? nextRun(cron, task.nextRunAt) : null,
      total: mine(tasks, ctx).length,
      hint: '到点后宿主会向本会话注入提示词；应用没运行超过 10 分钟的任务算错过不补跑。',
    };
  });

  enso.tools.register('cron_list', async (_args, ctx) => {
    requireSession(ctx);
    const tasks = mine(await load(), ctx);
    return { now: Date.now(), tasks: tasks.map(brief) };
  });

  enso.tools.register('cron_delete', async (args, ctx) => {
    const sessionId = requireSession(ctx);
    const id = String(args?.id ?? '').trim();
    if (!id) throw new Error('请提供要删除的任务 id（cron_list 可查）');
    const { tasks, task } = await locked(async () => {
      const all = await load();
      const hit = all.find((t) => t.id === id && t.sessionId === sessionId);
      if (!hit) throw new Error('任务不存在');
      const kept = all.filter((t) => t !== hit);
      await save(kept);
      return { tasks: kept, task: hit };
    });
    return { ok: true, deleted: { id: task.id, name: task.name }, remaining: mine(tasks, ctx).length };
  });
}
