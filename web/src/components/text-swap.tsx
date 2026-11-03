import { AnimatePresence, motion } from 'motion/react';

import { easeOut } from '@/lib/motion';
import { cn } from '@/lib/utils';

/** TextSwap：值变化时旧值上移淡出、新值自下而上，让非用户触发的变化被看见 */
export function TextSwap({ value, className }: { value: string | number; className?: string }) {
  return (
    <span className={cn('relative inline-flex overflow-hidden align-bottom tabular-nums', className)}>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={String(value)}
          initial={{ y: '60%', opacity: 0, filter: 'blur(2px)' }}
          animate={{ y: 0, opacity: 1, filter: 'blur(0px)' }}
          exit={{ y: '-60%', opacity: 0, filter: 'blur(2px)' }}
          transition={{ duration: 0.32, ease: easeOut }}
        >
          {value}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}
