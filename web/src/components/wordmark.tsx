import { motion } from 'motion/react';
import * as React from 'react';

import { easeOut } from '@/lib/motion';
import { cn } from '@/lib/utils';

/**
 * 圆相（ensō）：一笔画成、在右上留一道缺口的圆。
 * 入场时用 pathLength 一笔“画”出来，第二层细笔模拟枯笔的飞白。
 */
export function EnsoMark({ className }: { className?: string }) {
  const id = React.useId();
  return (
    <svg viewBox="0 0 100 100" aria-hidden className={cn('shrink-0 overflow-visible', className)}>
      <defs>
        <linearGradient id={`${id}-g`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--wordmark-from)" />
          <stop offset="1" stopColor="var(--wordmark-to)" />
        </linearGradient>
        <filter id={`${id}-brush`} x="-10%" y="-10%" width="120%" height="120%">
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="3" />
          <feDisplacementMap in="SourceGraphic" scale="2.2" />
        </filter>
      </defs>
      <g filter={`url(#${id}-brush)`} fill="none" stroke={`url(#${id}-g)`} strokeLinecap="round">
        <motion.path
          d="M74.43 20.89 A38 38 0 1 1 50 12"
          strokeWidth="10"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 1.1, ease: easeOut, delay: 0.1 }}
        />
        <motion.path
          d="M76 24 A36 36 0 1 1 54 13.5"
          strokeWidth="2.5"
          strokeOpacity="0.45"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 1.25, ease: easeOut, delay: 0.18 }}
        />
      </g>
    </svg>
  );
}

/** 标题字标：圆相 + 渐变的 EnsoCode（hover 时一道光泽缓慢扫过）+ 常规字重的“插件市场” */
export function Wordmark({ className }: { className?: string }) {
  return (
    <h1 className={cn('group flex items-center gap-3 font-semibold tracking-tight sm:gap-4', className)}>
      <EnsoMark className="size-[1.15em]" />
      <motion.span
        initial={{ opacity: 0, x: -6 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.5, ease: easeOut, delay: 0.25 }}
        className="flex flex-wrap items-baseline gap-x-[0.3em]"
      >
        <span className="wordmark-text">EnsoCode</span>
        <span className="font-normal text-foreground/75">插件市场</span>
      </motion.span>
    </h1>
  );
}
