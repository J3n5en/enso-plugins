import * as React from 'react';
import { motion } from 'motion/react';

import { fast, snappy } from '@/lib/motion';
import { cn } from '@/lib/utils';

type Box = { x: number; y: number; w: number; h: number; ox: number; oy: number; fresh: boolean };

/**
 * HoverFill（“跳跃”）：容器内带 data-fill 的元素共享同一块 hover 背景。
 * 首次移入时从鼠标方位由 0.92 轻微放大；在相邻元素间移动时背景平移过去，而不是消失再出现。
 */
export function HoverFill({
  className,
  fillClassName,
  resetKey,
  children,
  ...props
}: React.ComponentProps<'div'> & { fillClassName?: string; resetKey?: unknown }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [box, setBox] = React.useState<Box | null>(null);
  const [on, setOn] = React.useState(false);
  const current = React.useRef<Element | null>(null);
  const clearTimer = React.useRef(0);

  // 列表重排后旧坐标失效，直接收起
  React.useEffect(() => {
    current.current = null;
    setOn(false);
    setBox(null);
  }, [resetKey]);

  const place = (target: Element, clientX?: number, clientY?: number) => {
    const host = ref.current;
    if (!host) return;
    const hr = host.getBoundingClientRect();
    const r = target.getBoundingClientRect();
    const fresh = current.current === null;
    current.current = target;
    setBox({
      x: r.left - hr.left,
      y: r.top - hr.top,
      w: r.width,
      h: r.height,
      ox: clientX === undefined ? 0.5 : (clientX - r.left) / r.width,
      oy: clientY === undefined ? 0.5 : (clientY - r.top) / r.height,
      fresh,
    });
    setOn(true);
  };

  const find = (node: EventTarget | null) => {
    const el = (node as Element | null)?.closest?.('[data-fill]');
    return el && ref.current?.contains(el) ? el : null;
  };

  return (
    <div
      ref={ref}
      className={cn('relative isolate', className)}
      onPointerOver={(e) => {
        const el = find(e.target);
        if (!el || el === current.current) return;
        window.clearTimeout(clearTimer.current);
        place(el, e.clientX, e.clientY);
      }}
      onFocus={(e) => {
        const el = find(e.target);
        if (el && (e.target as Element).matches(':focus-visible')) place(el);
      }}
      onPointerLeave={() => {
        setOn(false);
        clearTimer.current = window.setTimeout(() => (current.current = null), 200);
      }}
      {...props}
    >
      {box && (
        <motion.div
          aria-hidden
          className={cn('pointer-events-none absolute top-0 left-0 -z-10 rounded-md bg-accent', fillClassName)}
          initial={false}
          animate={{ x: box.x, y: box.y, width: box.w, height: box.h, opacity: on ? 1 : 0, scale: on ? 1 : 0.92 }}
          style={{ originX: box.ox, originY: box.oy }}
          transition={{ default: box.fresh ? { duration: 0 } : snappy, opacity: fast, scale: fast }}
        />
      )}
      {children}
    </div>
  );
}
