import { readFileSync } from 'node:fs'

const OPEN = '<improved-prompt>'
const CLOSE = '</improved-prompt>'
// 开标签必须独占一行；改写后的提示词里可能顺带提到这个标签
const OPEN_LINE = `\n${OPEN}\n`
const NO_PROMPT =
  'None given: deepen the task in progress in the conversation so far, including any feedback I gave on work already done.'
const HISTORY = 20
const WAIT_MS = 20_000
const EMIT_MS = 150
const TIMEOUT_MS = 20 * 60_000
const TOOLS_KEPT = 40

export const STEPS = [
  '阅读代码和文件',
  '想清楚高手会多做什么',
  '找到最原始的材料',
  '选定方法和工具',
  '确定什么能证明结果正确',
  '写出改进后的提示词',
]

export function buildTask(prompt) {
  return [
    `## Prompt to deepen\n\n${prompt || NO_PROMPT}`,
    `## Return\n\nGive answers (1) to (4) in your reply, each starting a new line with its number, like "(1)". Then end it with the rewritten prompt, complete, between these two lines and nothing after them:\n\n${OPEN}\nthe rewritten prompt\n${CLOSE}`,
  ].join('\n\n')
}

export function parseMarkedPrompt(reply) {
  const end = reply.lastIndexOf(CLOSE)
  const before = `\n${reply.slice(0, Math.max(end, 0))}`
  const start = before.lastIndexOf(OPEN_LINE)
  if (end < 0 || start < 0) throw new Error(`回复里没有 ${OPEN} … ${CLOSE} 块，再试一次。`)
  const prompt = before.slice(start + OPEN_LINE.length).trim()
  if (!prompt) throw new Error(`回复里的 ${OPEN} 块是空的，再试一次。`)
  return prompt
}

/** 0 读材料，1–4 正在答第几问，5 写提示词 */
export function stepOf(text) {
  if (`\n${text}`.includes(OPEN_LINE)) return 5
  let answered = 0
  for (const [, n] of text.matchAll(/^\W*\(([1-4])\)/gm)) answered = Math.max(answered, Number(n))
  return answered === 0 ? 0 : Math.min(answered, 4)
}

/** 工具行的简短说明：读哪个文件、搜什么 */
export function describeTool(name, args) {
  let parsed = null
  try {
    parsed = JSON.parse(args)
  } catch {}
  if (!parsed || typeof parsed !== 'object') return name
  const pick = (...keys) => keys.map((key) => parsed[key]).find((v) => typeof v === 'string' && v)
  const target = pick('pattern', 'query', 'path', 'file_path', 'command') ??
    Object.values(parsed).find((v) => typeof v === 'string' && v)
  const extra = parsed.pattern && parsed.path ? ` · ${parsed.path}` : ''
  return target ? `${name} ${target}${extra}`.slice(0, 160) : name
}

export function activate(enso) {
  const helper = readFileSync(new URL('./helper.md', import.meta.url), 'utf8').trim()
  const runs = new Map()

  const view = (run) => ({
    id: run.id,
    sessionId: run.sessionId,
    draft: run.draft,
    status: run.status,
    step: run.status === 'done' ? 5 : stepOf(run.text),
    startedAt: run.startedAt,
    endedAt: run.endedAt ?? null,
    tools: run.tools.slice(-TOOLS_KEPT).map(({ args: _args, output: _output, ...tool }) => tool),
    toolCount: run.toolCount,
    failedCount: run.failedCount,
    text: run.text,
    prompt: run.prompt ?? null,
    error: run.error ?? null,
    model: run.model ?? null,
  })

  const emit = (run) => {
    run.emitTimer = null
    enso.ui.view.emit('run', view(run)).catch(() => {})
  }
  const scheduleEmit = (run) => {
    if (!run.emitTimer) run.emitTimer = setTimeout(() => emit(run), EMIT_MS)
  }

  const onEvent = (run, event) => {
    if (event.type === 'tool-start') {
      run.toolCount += 1
      run.tools.push({
        id: event.id,
        label: describeTool(event.name, event.args),
        status: 'running',
        args: event.args,
        ...(event.parentId ? { parentId: event.parentId } : {}),
      })
      if (run.tools.length > TOOLS_KEPT) run.tools.shift()
    } else if (event.type === 'tool-end') {
      const tool = run.tools.find((item) => item.id === event.id)
      if (tool) {
        tool.status = event.isError ? 'error' : 'ok'
        tool.output = event.output ?? ''
      }
      if (event.isError) run.failedCount += 1
    } else if (event.type === 'text') {
      run.text = event.text
    }
    const step = stepOf(run.text)
    if (step !== run.step) {
      run.step = step
      run.bump()
    }
    scheduleEmit(run)
  }

  /** 换步或结束时唤醒长轮询 */
  const arm = (run) => {
    run.tick = new Promise((resolve) => {
      run.bump = () => {
        arm(run)
        resolve()
      }
    })
  }

  const finish = (run, patch) => {
    Object.assign(run, patch, { endedAt: Date.now() })
    for (const tool of run.tools) if (tool.status === 'running') tool.status = 'error'
    if (run.emitTimer) clearTimeout(run.emitTimer)
    emit(run)
    run.bump()
  }

  const prune = () => {
    const finished = [...runs.values()].filter((run) => run.status !== 'running')
    for (const run of finished.slice(0, Math.max(0, runs.size - HISTORY))) runs.delete(run.id)
  }

  enso.renderer.handle('start', async (args, ctx) => {
    if (!ctx.sessionId) throw Object.assign(new Error('请先打开一个会话'), { code: 'NO_SESSION' })
    if (!enso.agent?.run)
      throw Object.assign(new Error('需要 Enso 0.3.8 或更新版本'), { code: 'UNSUPPORTED' })
    const live = [...runs.values()].find((run) => run.sessionId === ctx.sessionId && run.status === 'running')
    if (live) return { runId: live.id }
    const draft = typeof args?.text === 'string' ? args.text.trim() : ''
    const config = await enso.config.get()
    const run = {
      id: `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      sessionId: ctx.sessionId,
      draft,
      status: 'running',
      startedAt: Date.now(),
      tools: [],
      toolCount: 0,
      failedCount: 0,
      text: '',
      step: 0,
      controller: new AbortController(),
      emitTimer: null,
    }
    arm(run)
    runs.set(run.id, run)
    prune()
    // 没有草稿时改写进行中的任务，必须带上对话
    const context = draft && config.context === 'none' ? 'none' : 'fork'
    enso.agent
      .run({
        prompt: buildTask(draft),
        systemPrompt: helper,
        context,
        timeoutMs: TIMEOUT_MS,
        signal: run.controller.signal,
        onEvent: (event) => onEvent(run, event),
      })
      .then(
        (result) => {
          try {
            finish(run, { status: 'done', text: result.text, prompt: parseMarkedPrompt(result.text), model: result.model ?? null })
          } catch (error) {
            finish(run, { status: 'error', text: result.text, error: error.message })
          }
        },
        (error) =>
          finish(run, {
            status: error?.code === 'ABORTED' ? 'cancelled' : 'error',
            error: error?.message || String(error),
          })
      )
    emit(run)
    await enso.ui.view.open('runs').catch(() => {})
    return { runId: run.id }
  })

  /** 长轮询：客户端已知的步骤变了、跑完或等满 20 秒就返回 */
  enso.renderer.handle('wait', async (args) => {
    const run = runs.get(args?.runId)
    if (!run) return { status: 'missing' }
    if (run.status === 'running' && args?.step === run.step) {
      let timer
      await Promise.race([run.tick, new Promise((resolve) => (timer = setTimeout(resolve, WAIT_MS)))])
      clearTimeout(timer)
    }
    return { status: run.status, step: view(run).step, prompt: run.prompt ?? null, error: run.error ?? null }
  })

  enso.renderer.handle('cancel', async (args) => {
    const run = runs.get(args?.runId)
    if (run?.status === 'running') run.controller.abort()
    return null
  })

  enso.renderer.handle('snapshot', async (_args, ctx) => {
    const config = await enso.config.get()
    const autoClose = Number(config.autoClose ?? 5)
    return {
      sessionId: ctx.sessionId,
      autoClose: Number.isFinite(autoClose) && autoClose > 0 ? autoClose : 0,
      runs: [...runs.values()].filter((run) => run.sessionId === ctx.sessionId).reverse().map(view),
    }
  })

  enso.renderer.handle('closeView', async () => {
    await enso.ui.view.close?.('runs')
    return null
  })

  /** 侧栏展开某次工具调用时取完整输入输出 */
  enso.renderer.handle('tool', async (args) => {
    const tool = runs.get(args?.runId)?.tools.find((item) => item.id === args?.id)
    if (!tool) return null
    let input = tool.args
    try {
      input = JSON.stringify(JSON.parse(tool.args), null, 2)
    } catch {}
    return { input, output: tool.output ?? null }
  })

  enso.renderer.handle('copy', async (args) => {
    const run = runs.get(args?.runId)
    if (!run?.prompt) throw Object.assign(new Error('这次没有可用的提示词'), { code: 'NOT_FOUND' })
    await enso.ui.clipboard.writeText(run.prompt)
    return null
  })

  /** 侧栏按钮：把某次结果插进它所属会话的输入框 */
  enso.renderer.handle('insert', async (args, ctx) => {
    const run = runs.get(args?.runId)
    if (!run?.prompt) throw Object.assign(new Error('这次没有可用的提示词'), { code: 'NOT_FOUND' })
    if (run.sessionId !== ctx.sessionId)
      throw Object.assign(new Error('切回发起这次改写的会话再插入'), { code: 'NO_SESSION' })
    await enso.composer.insertText({ text: run.prompt })
    return null
  })
}
