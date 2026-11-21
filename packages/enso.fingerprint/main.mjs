import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dropData, ensureData } from './data.mjs'
import * as lmfpd from './vendor/lmfpd-sdk.mjs'

/** agent.run 每个插件同时最多 2 个 */
export const MAX_PARALLEL = 2
export const HISTORY_PER_SESSION = 5
const HISTORY_SESSIONS = 100
const TOP = 12
const WAIT_MS = 20_000
const EMIT_MS = 150
const ANSWER_TIMEOUT_MS = 5 * 60_000
/** 写到要求个数的这么多倍还停不下来就截断（宽松模式本来也只用前 expected 个） */
const RUNAWAY_RATIO = 1.5
const QUICK_LOAD_MS = 3000
const RETRY_MS = 1500

const LANGS = [
  [/[\uac00-\ud7af]/, '韩文'],
  [/[\u3040-\u30ff]/, '日文'],
  [/[\u4e00-\u9fff]/, '中文'],
  [/[àâçéèêëîïôûùüÿœ]|\b(entiers|chaque|entre|les|des)\b/i, '法文'],
]
export const languageOf = (prompt) => LANGS.find(([re]) => re.test(prompt))?.[1] ?? '英文'

const coded = (code, message) => Object.assign(new Error(message), { code })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** SDK 的 Analysis 收成面板要的形状，只留前 TOP 名 */
export function summarize(analysis) {
  const results = Array.isArray(analysis?.results) ? analysis.results : []
  return {
    decision: analysis?.decision ?? 'unscorable',
    prediction: analysis?.prediction || null,
    predictionName: analysis?.prediction_name || analysis?.prediction || null,
    family: analysis?.family_prediction || null,
    familyName: analysis?.family_prediction_name || analysis?.family_prediction || null,
    probability: typeof analysis?.probability === 'number' ? analysis.probability : null,
    probabilityStatus: analysis?.probability_status ?? 'unavailable',
    rankingScore: typeof analysis?.ranking_score === 'number' ? analysis.ranking_score : null,
    total: results.length,
    candidates: results.slice(0, TOP).map((item) => ({
      model: item.model,
      name: item.display_name || item.model,
      family: item.family ?? null,
      familyName: item.family_name || item.family || null,
      score: typeof item.score === 'number' ? item.score : null,
      probability: typeof item.probability === 'number' ? item.probability : null,
    })),
    usedOutputs: analysis?.used_outputs ?? 0,
    diagnostics: (analysis?.diagnostics ?? []).map((item) => ({
      parsed: item.parsed_numbers ?? 0,
      minimum: item.minimum_numbers ?? 0,
      accepted: Boolean(item.accepted),
      outOfRange: item.raw_out_of_range_count ?? 0,
    })),
    sequence: analysis?.sequence
      ? {
          modelLike: Boolean(analysis.sequence.model_like),
          autocorrelation: analysis.sequence.autocorrelation ?? null,
          smallStepShare: analysis.sequence.small_step_share ?? null,
        }
      : null,
    evidence: analysis?.evidence ? { label: analysis.evidence.label ?? '', reason: analysis.evidence.reason ?? '' } : null,
    method: analysis?.method ?? null,
    modelVersion: analysis?.model_version ?? null,
  }
}

/** 没有置信度时的说明 */
export function probabilityNote(summary) {
  if (summary.probability != null) return null
  switch (summary.decision) {
    case 'partial':
      return `只有 ${summary.usedOutputs} 条有效回答：只给排名，不给置信度。三条都有效才有置信度。`
    case 'not_model':
      return '数字的变化方式不像语言模型写的，没有生成排名。'
    case 'unscorable':
      return '没有有效回答，无法评分。'
    default:
      return '这次的校准和检测参数对不上，只给排名，不给置信度。'
  }
}

const normalize = (id) =>
  String(id ?? '')
    .toLowerCase()
    .replace(/^.*\//, '')
    .replace(/[._:\s]+/g, '-')

/** 实际模型名和预测对照：same / family / different / unknown */
export function compareModel(actual, summary) {
  const a = normalize(actual)
  if (!a || !summary?.prediction) return 'unknown'
  const p = normalize(summary.prediction)
  if (a === p || a.startsWith(`${p}-`) || p.startsWith(`${a}-`)) return 'same'
  const family = normalize(summary.family)
  if (family && a.includes(family)) return 'family'
  return 'different'
}

const codeOf = (error) => (typeof error?.code === 'string' ? error.code : '')

export function createFingerprint(enso, { sdk = lmfpd, now = Date.now, fetchData = ensureData } = {}) {
  const dataDir = join(enso.dataDir, 'lmfpd')
  const historyFile = join(enso.dataDir, 'history.json')
  const runs = new Map()
  let active = 0
  let detector = null
  let loading = null
  let dataMeta = null
  let history = null
  let saving = Promise.resolve()

  const loadHistory = () =>
    (history ??= readFile(historyFile, 'utf8').then(
      (text) => {
        const parsed = JSON.parse(text)
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
      },
      () => ({})
    ).catch(() => ({})))
  const saveHistory = () => {
    saving = saving
      .then(async () => {
        await mkdir(enso.dataDir, { recursive: true })
        const tmp = `${historyFile}.tmp`
        await writeFile(tmp, JSON.stringify(await loadHistory()))
        await rename(tmp, historyFile)
      })
      .catch((error) => console.error('保存历史失败：', error))
    return saving
  }

  const challengeView = (ch, full) => ({
    index: ch.index,
    lang: ch.lang,
    prompt: ch.prompt,
    expected: ch.expected,
    status: ch.status,
    count: ch.count,
    tools: ch.tools,
    truncated: Boolean(ch.truncated),
    model: ch.model,
    error: ch.error,
    startedAt: ch.startedAt,
    endedAt: ch.endedAt,
    ...(full ? { text: ch.text } : { tail: ch.text.slice(-160) }),
  })

  const view = (run, full = false) => ({
    id: run.id,
    sessionId: run.sessionId,
    status: run.status,
    rev: run.rev,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    data: run.data,
    challenges: run.challenges.map((ch) => challengeView(ch, full)),
    result: run.result,
    error: run.error,
  })

  const emit = (run) => {
    if (run.emitTimer) clearTimeout(run.emitTimer)
    run.emitTimer = null
    enso.ui.view.emit('run', view(run, run.status === 'done')).catch(() => {})
  }
  const scheduleEmit = (run) => {
    run.emitTimer ??= setTimeout(() => emit(run), EMIT_MS)
  }

  const arm = (run) => {
    run.tick = new Promise((resolve) => {
      run.wake = resolve
    })
  }
  /** 状态变了：推给侧栏，唤醒长轮询 */
  const bump = (run) => {
    run.rev += 1
    const wake = run.wake
    arm(run)
    wake()
    emit(run)
  }

  const getDetector = (onProgress) => {
    if (detector) return Promise.resolve(detector)
    loading ??= (async () => {
      const fetch = (url, init) => enso.net.fetch(url, init)
      const open = async () => {
        const data = await fetchData({ dir: dataDir, fetch, onProgress, background: () => {} })
        dataMeta = data.meta
        return { data, detector: await sdk.loadDetector({ source: data.dir }) }
      }
      try {
        let opened
        try {
          opened = await open()
        } catch (error) {
          if (codeOf(error) === 'DATA_UNAVAILABLE') throw error
          // 本地文件坏了：清掉重下一次
          await dropData(dataDir)
          opened = await open()
        }
        detector = opened.detector
        return detector
      } finally {
        loading = null
      }
    })()
    return loading
  }

  const settled = (run) => run.challenges.every((ch) => ch.status !== 'queued' && ch.status !== 'running')

  const record = async (run) => {
    const all = await loadHistory()
    const entry = view(run, true)
    const list = [entry, ...(all[run.sessionId] ?? []).filter((item) => item.id !== run.id)]
    all[run.sessionId] = list.slice(0, HISTORY_PER_SESSION)
    const sessions = Object.keys(all)
    if (sessions.length > HISTORY_SESSIONS) {
      const oldest = sessions
        .map((id) => [id, all[id][0]?.endedAt ?? 0])
        .sort((a, b) => a[1] - b[1])
        .slice(0, sessions.length - HISTORY_SESSIONS)
      for (const [id] of oldest) delete all[id]
    }
    await saveHistory()
  }

  const finish = (run, patch) => {
    Object.assign(run, patch, { endedAt: now() })
    bump(run)
    void record(run)
  }

  /** 三道题都结束后评分；取消的这一轮不评分 */
  const finalize = (run) => {
    if (run.status !== 'answering' || !settled(run)) return
    const answered = run.challenges.filter((ch) => ch.status === 'done')
    if (!answered.length) {
      const first = run.challenges.find((ch) => ch.error)?.error
      finish(run, { status: 'error', error: `三道题都没有拿到回答${first ? `：${first}` : ''}` })
      return
    }
    run.status = 'scoring'
    bump(run)
    try {
      const analysis = detector.analyze(answered.map((ch) => ({ text: ch.text, expected_count: ch.expected })))
      const result = summarize(analysis)
      result.note = probabilityNote(result)
      result.answered = answered.map((ch) => ch.index)
      const models = [...new Set(run.challenges.map((ch) => ch.model).filter(Boolean))]
      result.actualModels = models
      result.match = models.length ? compareModel(models[0], result) : 'unknown'
      finish(run, { status: 'done', result })
    } catch (error) {
      finish(run, { status: 'error', error: `评分失败：${error?.message || error}` })
    }
  }

  const launch = (run, ch) => {
    active += 1
    ch.status = 'running'
    ch.startedAt = now()
    ch.controller = new AbortController()
    scheduleEmit(run)
    let started
    try {
      started = enso.agent.run({
        prompt: ch.prompt,
        context: 'none',
        timeoutMs: ANSWER_TIMEOUT_MS,
        signal: ch.controller.signal,
        onEvent: (event) => {
          if (event.type === 'text' && typeof event.text === 'string') {
            ch.text = event.text
            ch.count = sdk.parseNumbers(event.text).length
            if (ch.count >= ch.expected * RUNAWAY_RATIO && !ch.truncated) {
              ch.truncated = true
              ch.controller?.abort()
            }
            scheduleEmit(run)
          } else if (event.type === 'tool-start') {
            ch.tools += 1
            scheduleEmit(run)
          }
        },
      })
    } catch (error) {
      started = Promise.reject(error)
    }
    started
      .then(
        (result) => {
          if (run.status === 'cancelled') return
          ch.text = typeof result?.text === 'string' ? result.text : ch.text
          ch.count = sdk.parseNumbers(ch.text).length
          ch.model = result?.model ?? null
          ch.status = 'done'
        },
        (error) => {
          if (run.status === 'cancelled') {
            ch.status = 'cancelled'
          } else if (ch.truncated) {
            // 失控连写被截断：用已收到的文本评分，拿不到 result.model
            ch.status = 'done'
          } else if (codeOf(error) === 'RATE_LIMITED' || codeOf(error) === 'NO_INVOCATION') {
            // 宿主名额还没腾出来，或发起调用已结束：放回队列，等侧栏的下一次 wait 再发
            ch.status = 'queued'
            ch.retryAt = now() + RETRY_MS
            ch.startedAt = null
          } else {
            ch.status = 'error'
            ch.error = error?.message || String(error)
          }
        }
      )
      .finally(() => {
        active -= 1
        ch.controller = null
        if (ch.status !== 'queued') ch.endedAt = now()
        for (const other of runs.values()) if (other !== run && other.status === 'answering') bump(other)
        if (run.status === 'answering') {
          bump(run)
          finalize(run)
        }
      })
  }

  /** agent.run 必须在活着的宿主调用里发起，所以只在侧栏调用（start / wait）里派题 */
  const pump = (sessionId) => {
    for (const run of runs.values()) {
      if (run.status !== 'answering' || run.sessionId !== sessionId) continue
      for (const ch of run.challenges) {
        if (active >= MAX_PARALLEL) return
        if (ch.status === 'queued' && (ch.retryAt ?? 0) <= now()) launch(run, ch)
      }
    }
  }

  const liveRun = (sessionId) =>
    [...runs.values()].find((run) => run.sessionId === sessionId && ['loading', 'answering', 'scoring'].includes(run.status))

  const start = async (_args, ctx) => {
    if (!ctx?.sessionId) throw coded('NO_SESSION', '请先打开一个会话')
    if (!enso.agent?.run) throw coded('UNSUPPORTED', '需要 Enso 0.3.8 或更新版本')
    const live = liveRun(ctx.sessionId)
    if (live) return { runId: live.id }
    const run = {
      id: `f${now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      sessionId: ctx.sessionId,
      status: 'loading',
      rev: 0,
      startedAt: now(),
      endedAt: null,
      data: { phase: 'load' },
      challenges: sdk.generateChallenges(3).map((challenge, index) => ({
        index,
        id: challenge.id,
        prompt: challenge.prompt,
        lang: languageOf(challenge.prompt),
        expected: challenge.expected_count,
        status: 'queued',
        count: 0,
        tools: 0,
        text: '',
        model: null,
        error: null,
        startedAt: null,
        endedAt: null,
      })),
      result: null,
      error: null,
    }
    arm(run)
    for (const [id, old] of runs) if (old.sessionId === ctx.sessionId) runs.delete(id)
    runs.set(run.id, run)
    const ready = getDetector((progress) => {
      run.data = { ...progress }
      scheduleEmit(run)
    }).then(
      () => {
        if (run.status !== 'loading') return
        run.data = { phase: 'ready', builtAt: dataMeta?.builtAt ?? null, models: dataMeta?.models ?? 0 }
        run.status = 'answering'
        bump(run)
      },
      (error) => {
        if (run.status === 'loading') finish(run, { status: 'error', error: error?.message || String(error) })
      }
    )
    emit(run)
    // 数据已在本地时几乎立即就绪，直接在这次调用里派题；否则交给侧栏的 wait
    await Promise.race([ready, sleep(QUICK_LOAD_MS)])
    pump(ctx.sessionId)
    return { runId: run.id }
  }

  const wait = async (args, ctx) => {
    const run = runs.get(args?.runId)
    if (!run) return { status: 'missing' }
    pump(ctx?.sessionId)
    if (['loading', 'answering', 'scoring'].includes(run.status) && args?.rev === run.rev) {
      let timer
      const retry = run.challenges.some((ch) => ch.status === 'queued' && ch.retryAt) ? RETRY_MS : WAIT_MS
      await Promise.race([run.tick, new Promise((resolve) => (timer = setTimeout(resolve, retry)))])
      clearTimeout(timer)
      pump(ctx?.sessionId)
    }
    return { status: run.status, rev: run.rev }
  }

  const cancel = async (args) => {
    const run = runs.get(args?.runId)
    if (!run || !['loading', 'answering', 'scoring'].includes(run.status)) return null
    run.status = 'cancelled'
    for (const ch of run.challenges) {
      if (ch.status !== 'queued' && ch.status !== 'running') continue
      ch.status = 'cancelled'
      ch.endedAt = now()
      ch.controller?.abort()
    }
    finish(run, {})
    return null
  }

  const snapshot = async (_args, ctx) => {
    const all = await loadHistory()
    // 插件进程重启后还没加载过检测器时，从磁盘读一下参考数据的版本
    dataMeta ??= await readFile(join(dataDir, 'meta.json'), 'utf8').then(JSON.parse, () => null)
    const sessionId = ctx?.sessionId ?? null
    const live = sessionId ? liveRun(sessionId) : null
    return {
      sessionId,
      data: dataMeta,
      live: live ? view(live) : null,
      history: sessionId ? (all[sessionId] ?? []) : [],
    }
  }

  return { start, wait, cancel, snapshot, runs, pump }
}

export function activate(enso) {
  const app = createFingerprint(enso)
  for (const name of ['start', 'wait', 'cancel', 'snapshot']) enso.renderer.handle(name, app[name])
}
