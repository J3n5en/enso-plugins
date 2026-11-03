import { motion } from 'motion/react';

import { HoverFill } from '@/components/hover-fill';
import { TextSwap } from '@/components/text-swap';
import { spring } from '@/lib/motion';
import { cn } from '@/lib/utils';

export type Tier = '' | 'official' | 'community';

const TABS: { value: Tier; label: string }[] = [
  { value: '', label: '全部' },
  { value: 'official', label: '官方' },
  { value: 'community', label: '社区' },
];

/** 选中态 indicator 与 hover 背景都在同一组内平移，整组像一个整体 */
export function TierTabs({ value, counts, onChange }: { value: Tier; counts: Record<Tier, number>; onChange: (tier: Tier) => void }) {
  return (
    <HoverFill role="tablist" aria-label="来源" className="inline-flex h-9 shrink-0 items-center rounded-lg bg-muted p-1" fillClassName="rounded-md bg-foreground/[0.04]">
      {TABS.map((tab) => {
        const active = tab.value === value;
        return (
          <button
            key={tab.value}
            role="tab"
            aria-selected={active}
            data-fill
            onClick={() => onChange(tab.value)}
            className={cn(
              'relative flex h-7 items-center gap-1.5 rounded-md px-3 text-sm font-medium outline-none transition-colors duration-200 focus-visible:ring-[3px] focus-visible:ring-ring/50',
              active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {active && (
              <motion.span
                layoutId="tier-indicator"
                transition={spring}
                className="absolute inset-0 -z-10 rounded-md bg-background shadow-sm dark:bg-input/40"
              />
            )}
            {tab.label}
            <TextSwap value={counts[tab.value]} className="text-xs text-muted-foreground" />
          </button>
        );
      })}
    </HoverFill>
  );
}
