import { motion } from 'motion/react';

import { HoverFill } from '@/components/hover-fill';
import { TextSwap } from '@/components/text-swap';
import { CATEGORY_LABELS, type Category } from '@/lib/market';
import { spring } from '@/lib/motion';
import { cn } from '@/lib/utils';

/** 分类胶囊；只列索引里有插件的分类，计数随搜索与来源筛选变化 */
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
  const tabs: (Category | '')[] = ['', ...items];
  return (
    <HoverFill
      role="tablist"
      aria-label="分类"
      className="-mx-1 flex items-center gap-1 overflow-x-auto px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      fillClassName="rounded-full bg-foreground/[0.04]"
    >
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
              'relative flex h-7 shrink-0 items-center gap-1.5 rounded-full px-3 text-sm whitespace-nowrap outline-none transition-colors duration-200 focus-visible:ring-[3px] focus-visible:ring-ring/50',
              active ? 'font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {active && <motion.span layoutId="category-indicator" transition={spring} className="absolute inset-0 -z-10 rounded-full border bg-background shadow-xs dark:bg-input/40" />}
            {tab ? CATEGORY_LABELS[tab] : '全部分类'}
            <TextSwap value={counts[tab]} className="text-xs text-muted-foreground" />
          </button>
        );
      })}
    </HoverFill>
  );
}
