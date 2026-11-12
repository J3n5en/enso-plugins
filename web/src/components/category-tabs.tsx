import { motion } from 'motion/react';

import { HoverFill } from '@/components/hover-fill';
import { TextSwap } from '@/components/text-swap';
import { CATEGORY_LABELS, type Category } from '@/lib/market';
import { spring } from '@/lib/motion';
import { cn } from '@/lib/utils';

/** 与来源切换同款的分段控件，窄屏自动换行；计数为 0 的分类不显示（选中的除外） */
export function CategoryTabs({
  items,
  value,
  counts,
  onChange,
}: {
  items: Category[];
  value: Category | '';
  counts: Record<Category | '', number>;
  onChange: (category: Category | '') => void;
}) {
  const tabs: (Category | '')[] = ['', ...items.filter((c) => counts[c] > 0 || c === value)];
  return (
    <HoverFill role="tablist" aria-label="分类" className="flex flex-wrap items-center gap-0.5 rounded-lg bg-muted p-1" fillClassName="rounded-md bg-foreground/[0.04]">
      {tabs.map((tab) => {
        const active = tab === value;
        return (
          <button
            key={tab || 'all'}
            role="tab"
            aria-selected={active}
            data-fill
            onClick={() => onChange(tab)}
            className={cn(
              'relative flex h-7 items-center gap-1.5 rounded-md px-3 text-sm font-medium whitespace-nowrap outline-none transition-colors duration-200 focus-visible:ring-[3px] focus-visible:ring-ring/50',
              active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {active && <motion.span layoutId="category-indicator" transition={spring} className="absolute inset-0 -z-10 rounded-md bg-background shadow-sm dark:bg-input/40" />}
            {tab ? CATEGORY_LABELS[tab] : '全部分类'}
            <TextSwap value={counts[tab]} className="text-xs text-muted-foreground" />
          </button>
        );
      })}
    </HoverFill>
  );
}
