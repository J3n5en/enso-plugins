import type { Transition } from 'motion/react';

/** ease-out-expo：所有非弹簧过渡都用它，不用 ease-in-out */
export const easeOut = [0.16, 1, 0.3, 1] as const;

/** 指示器、弹层：stiffness 260 / damping 26，几乎不过冲 */
export const spring: Transition = { type: 'spring', stiffness: 260, damping: 26 };

/** 跟随鼠标的 hover 背景要更跟手 */
export const snappy: Transition = { type: 'spring', stiffness: 520, damping: 42 };

export const fast: Transition = { duration: 0.2, ease: easeOut };
