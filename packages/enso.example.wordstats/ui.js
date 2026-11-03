// 主界面渲染模块：工具结果卡片 + ```enso.example.wordstats:bars 代码块
// 运行在宿主的 React 里，样式只能内联，颜色取宿主的 shadcn token

const EASE = 'cubic-bezier(0.16, 1, 0.3, 1)';

const box = {
  border: '1px solid var(--border)',
  borderRadius: 10,
  padding: '10px 12px',
  margin: '4px 0',
  fontSize: 12,
  background: 'var(--card, transparent)',
  boxShadow: '0 1px 2px 0 rgb(0 0 0 / 0.05)',
};

/** "label: 数值" 每行一条 */
function parsePairs(text) {
  const rows = [];
  for (const line of String(text ?? '').split('\n')) {
    const match = /^\s*(.+?)\s*:\s*(-?\d+(?:\.\d+)?)\s*$/.exec(line);
    if (match) rows.push({ label: match[1], value: Number(match[2]) });
  }
  return rows;
}

export function onLoad(enso) {
  const { createElement: h, useEffect, useState } = enso.React;
  const reduced = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  function Bars({ rows }) {
    const max = Math.max(1, ...rows.map((r) => Math.abs(r.value)));
    // 首帧宽度为 0，下一帧再展开，条形从左侧依次长出
    const [shown, setShown] = useState(reduced());
    useEffect(() => {
      const id = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(id);
    }, []);
    return h(
      'div',
      {
        style: {
          display: 'grid',
          gridTemplateColumns: 'max-content 1fr max-content',
          gap: '6px 10px',
          alignItems: 'center',
        },
      },
      ...rows.flatMap((row, i) => [
        h(
          'span',
          {
            key: `${row.label}-l`,
            style: { color: 'var(--muted-foreground)', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
          },
          row.label
        ),
        h(
          'div',
          {
            key: `${row.label}-b`,
            style: { height: 6, borderRadius: 999, background: 'var(--muted)', overflow: 'hidden' },
          },
          h('div', {
            style: {
              width: shown ? `${(Math.abs(row.value) / max) * 100}%` : '0%',
              height: '100%',
              borderRadius: 999,
              background: 'var(--brand, var(--primary))',
              transition: `width 600ms ${EASE} ${Math.min(i, 12) * 30}ms`,
            },
          })
        ),
        h(
          'span',
          {
            key: `${row.label}-v`,
            style: { fontVariantNumeric: 'tabular-nums', fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11, textAlign: 'right' },
          },
          String(row.value)
        ),
      ])
    );
  }

  enso.slots.register({
    slot: 'tool.card',
    toolName: 'count_words',
    component: ({ output, state }) => {
      if (state !== 'ok' || !output) return null;
      const [summary, ...rest] = String(output).split('\n');
      const rows = parsePairs(rest.join('\n'));
      return h(
        'div',
        { style: box },
        h('div', { style: { fontWeight: 500, marginBottom: rows.length ? 10 : 0 } }, summary),
        rows.length ? h(Bars, { rows }) : null
      );
    },
  });

  enso.slots.register({
    slot: 'block',
    language: 'bars',
    component: ({ source }) => {
      const rows = parsePairs(source);
      if (rows.length === 0) return h('pre', { style: box }, source);
      return h('div', { style: box }, h(Bars, { rows }));
    },
  });
}
