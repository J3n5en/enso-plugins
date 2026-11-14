// 渲染模块：Enso 以 blob URL 加载，不能 import。

const STEPS = [
  '阅读代码和文件',
  '想清楚高手会多做什么',
  '找到最原始的材料',
  '选定方法和工具',
  '确定什么能证明结果正确',
  '写出改进后的提示词',
]

const STYLE = `
.ensobetter-wrap { display: inline-flex; align-items: center; gap: 4px; min-width: 0; }
.ensobetter-control { position: relative; display: inline-flex; }
.ensobetter-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 25px; height: 25px; padding: 0; border: none;
  border-radius: var(--radius-md, 6px);
  background: var(--secondary, var(--muted, rgba(15, 23, 42, 0.05)));
  color: var(--muted-foreground); cursor: pointer;
  transition: background-color .12s cubic-bezier(.16,1,.3,1), color .12s cubic-bezier(.16,1,.3,1);
}
.ensobetter-btn:hover { background: var(--accent, rgba(15, 23, 42, 0.08)); color: var(--foreground); }
.ensobetter-btn:hover:active { transform: scale(.96); }
.ensobetter-btn[data-busy='true'] { color: #0d9488; }
.ensobetter-icon { width: 13px; height: 13px; display: block; }
.ensobetter-ring {
  position: absolute; inset: 0; box-sizing: border-box; padding: 1.5px;
  border-radius: var(--radius-md, 6px); pointer-events: none; opacity: 0;
}
@property --ensobetter-from { syntax: '<angle>'; inherits: false; initial-value: 0deg; }
@keyframes ensobetter-from { to { --ensobetter-from: 360deg; } }
.ensobetter-wrap[data-busy='true'] .ensobetter-ring {
  opacity: .75; animation: ensobetter-from 1.6s linear infinite;
  background: conic-gradient(from var(--ensobetter-from, 0deg) at 50% 50%,
    transparent 0deg, rgba(20,184,166,0) 210deg, rgba(20,184,166,.4) 260deg,
    rgba(79,70,229,.55) 310deg, transparent 360deg);
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  mask-composite: exclude;
}
.ensobetter-status {
  min-width: 0; max-width: 180px; font-size: 11px; line-height: 1.2;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  color: var(--muted-foreground, #8b8b8b);
}
.ensobetter-status[data-level='busy'] { color: #0d9488; }
.ensobetter-status[data-level='error'] { color: var(--destructive, #e5484d); }
.ensobetter-status[data-level='ok'] { color: var(--success, #30a46c); }
.ensobetter-link {
  height: 25px; padding: 0 6px; border: none; border-radius: var(--radius-md, 6px);
  background: transparent; color: var(--muted-foreground); font-size: 11px; cursor: pointer;
}
.ensobetter-link:hover { background: var(--accent, rgba(15, 23, 42, 0.08)); color: var(--foreground); }
@media (prefers-reduced-motion: reduce) {
  .ensobetter-wrap[data-busy='true'] .ensobetter-ring { animation: none; opacity: .45; }
}
`

const codeOf = (error) => (error && typeof error.code === 'string' ? error.code : '')

export function errorText(error) {
  switch (codeOf(error)) {
    case 'NO_SESSION':
      return '请先打开一个会话'
    case 'PERMISSION_DENIED':
      return '插件没有 agent.run 权限，请在设置里重新授权'
    case 'UNSUPPORTED':
      return '需要 Enso 0.3.8 或更新版本'
    case 'RATE_LIMITED':
      return '同时进行的改写太多，稍后再试'
    case 'DRAFT_BUSY':
      return '输入框正在组字或已锁定，结果在侧栏里'
    case 'TOO_LARGE':
      return '结果超过输入框 32KB 上限，请在侧栏复制'
    default:
      return (error && error.message) || '改写失败'
  }
}

/** 写回时保留用户在等待期间新输入的内容，放在提示词下方 */
export function mergeDraft(prompt, original, current) {
  const typed = current.trim()
  return typed && typed !== original.trim() ? `${prompt}\n\n${typed}` : prompt
}

const sessions = new Map()
const listeners = new Set()
let version = 0
const subscribe = (listener) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
const getVersion = () => version
const patch = (sessionId, next) => {
  sessions.set(sessionId, { ...(sessions.get(sessionId) ?? {}), ...next })
  version += 1
  for (const listener of listeners) listener()
}

function icon(h) {
  return h(
    'svg',
    {
      className: 'ensobetter-icon',
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: '2',
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': true,
    },
    h('path', { d: 'M4 6h16M6 11h12M8 16h8' }),
    h('path', { d: 'M12 18.5v3M10.5 20l1.5 1.5 1.5-1.5' })
  )
}

export function onLoad(enso) {
  const { React } = enso
  const h = React.createElement.bind(React)
  const style = document.createElement('style')
  style.dataset.plugin = 'enso.better'
  style.textContent = STYLE
  document.head.appendChild(style)
  const call = (method, args) => enso.dispatch('plugin.call', { method, args })
  let activeSession = null

  const apply = async (sessionId) => {
    const state = sessions.get(sessionId)
    if (!state || state.status !== 'ready' || state.applying) return
    patch(sessionId, { applying: true })
    try {
      for (let attempt = 0; ; attempt++) {
        const current = await enso.composer.readDraft()
        const text = mergeDraft(state.prompt, state.original, current.text)
        try {
          if (current.hasReferences) {
            await enso.composer.insertText({ text: state.prompt })
            patch(sessionId, { status: 'done', applied: null, level: 'ok', message: '草稿含引用，提示词已插入到光标处' })
            return
          }
          await enso.composer.replaceDraft({ text, expect: { generation: current.generation, rev: current.rev } })
          const kept = text !== state.prompt
          patch(sessionId, {
            status: 'done',
            applied: text,
            level: 'ok',
            message: kept ? '已放进输入框，你刚输入的内容在下方' : '已放进输入框，编辑后按回车发送',
          })
          return
        } catch (error) {
          if (codeOf(error) !== 'DRAFT_CHANGED' || attempt >= 2) throw error
        }
      }
    } catch (error) {
      patch(sessionId, { status: 'error', level: 'error', message: errorText(error) })
    } finally {
      patch(sessionId, { applying: false })
    }
  }

  const start = async (sessionId, draft) => {
    patch(sessionId, { status: 'running', step: 0, original: draft, applied: null, level: 'busy', message: STEPS[0] })
    let runId
    try {
      runId = (await call('start', { text: draft })).runId
    } catch (error) {
      patch(sessionId, { status: 'error', level: 'error', message: errorText(error) })
      return
    }
    patch(sessionId, { runId })
    let step = -1
    for (;;) {
      let result
      try {
        result = await call('wait', { runId, step })
      } catch (error) {
        if (codeOf(error) === 'TIMEOUT') continue
        patch(sessionId, { status: 'error', level: 'error', message: errorText(error) })
        return
      }
      if (result.status === 'running') {
        step = result.step
        patch(sessionId, { step, message: STEPS[step] ?? STEPS[0] })
        continue
      }
      if (result.status === 'done') {
        patch(sessionId, { status: 'ready', prompt: result.prompt })
        if (activeSession === sessionId) await apply(sessionId)
      } else if (result.status === 'cancelled') {
        patch(sessionId, { status: 'idle', level: 'idle', message: '' })
      } else {
        patch(sessionId, { status: 'error', level: 'error', message: result.error || '改写失败' })
      }
      return
    }
  }

  function BetterButton({ sessionId, draft }) {
    React.useSyncExternalStore(subscribe, getVersion, getVersion)
    const state = (sessionId && sessions.get(sessionId)) || { status: 'idle' }
    const text = typeof draft === 'string' ? draft : ''
    activeSession = sessionId

    React.useEffect(() => {
      if (sessionId && state.status === 'ready') void apply(sessionId)
    }, [sessionId, state.status])

    React.useEffect(() => {
      if (state.level !== 'ok' && state.level !== 'error') return undefined
      const timer = window.setTimeout(() => patch(sessionId, { level: 'idle', message: '' }), 8000)
      return () => window.clearTimeout(timer)
    }, [sessionId, state.level, state.message])

    const busy = state.status === 'running' || state.status === 'ready'
    const title = busy
      ? `${state.message || STEPS[0]}，点击取消`
      : text.trim()
        ? '用 Depth 提示改写：先读代码和对话，再替换输入框'
        : '输入框是空的：改写当前进行中的任务'

    const onClick = () => {
      if (!sessionId) return
      if (state.status === 'running') {
        if (state.runId) void call('cancel', { runId: state.runId })
        return
      }
      if (busy) return
      void start(sessionId, text)
    }

    const onRestore = async () => {
      try {
        await enso.composer.replaceDraft({ text: state.original })
        patch(sessionId, { applied: null, level: 'idle', message: '' })
      } catch (error) {
        patch(sessionId, { level: 'error', message: errorText(error) })
      }
    }

    const canRestore = !busy && state.applied != null && state.applied === text
    const message = state.message || ''
    return h(
      'span',
      { className: 'ensobetter-wrap', 'data-busy': busy ? 'true' : 'false' },
      h(
        'span',
        { className: 'ensobetter-control' },
        h('span', { className: 'ensobetter-ring', 'aria-hidden': true }),
        h(
          'button',
          {
            type: 'button',
            className: 'ensobetter-btn',
            'data-busy': busy ? 'true' : 'false',
            title,
            'aria-label': title,
            'aria-busy': busy,
            disabled: !sessionId,
            onMouseDown: (event) => event.preventDefault(),
            onClick,
          },
          icon(h)
        )
      ),
      message
        ? h('span', { className: 'ensobetter-status', 'data-level': state.level || 'idle', title: message }, message)
        : null,
      canRestore
        ? h(
            'button',
            {
              type: 'button',
              className: 'ensobetter-link',
              onMouseDown: (event) => event.preventDefault(),
              onClick: () => void onRestore(),
            },
            '还原'
          )
        : null
    )
  }

  enso.slots.register({ slot: 'composer.left', component: BetterButton })
  return () => style.remove()
}
