import { ArrowUpRight, BadgeCheck, ShieldCheck } from 'lucide-react';
import { motion } from 'motion/react';

import { PluginIcon } from '@/components/plugin-icon';
import { Badge } from '@/components/ui/badge';
import { latestVersion, type Plugin } from '@/lib/market';
import { easeOut, spring } from '@/lib/motion';

/**
 * 轻量卡片：本身没有底色，hover 背景由外层 HoverFill 共享并在卡片间平移。
 * 添加时位移先行、透明度后到；删除时透明度先走，避免重叠。
 */
export function PluginCard({ plugin, index, onOpen }: { plugin: Plugin; index: number; onOpen: (plugin: Plugin, el: HTMLElement) => void }) {
  const perms = latestVersion(plugin)?.permissions ?? [];
  return (
    <motion.button
      layout="position"
      data-fill
      type="button"
      onClick={(e) => onOpen(plugin, e.currentTarget)}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0, transition: { y: { ...spring, delay: Math.min(index, 12) * 0.03 }, opacity: { duration: 0.3, ease: easeOut, delay: Math.min(index, 12) * 0.03 + 0.08 } } }}
      exit={{ opacity: 0, transition: { duration: 0.15, ease: easeOut } }}
      transition={{ layout: spring }}
      className="group flex h-full w-full flex-col gap-3 rounded-xl p-5 text-left outline-none hover:active:scale-[0.985] focus-visible:ring-[3px] focus-visible:ring-ring/50 [transition:scale_200ms_cubic-bezier(0.16,1,0.3,1)]"
    >
      <div className="flex items-start gap-3.5">
        <PluginIcon plugin={plugin} className="transition-transform duration-300 ease-out-expo group-hover:scale-105" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-semibold tracking-tight">{plugin.name || plugin.id}</span>
            {plugin.tier === 'official' && <BadgeCheck aria-label="官方" className="size-4 shrink-0 text-brand" />}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
            <span className="truncate">{plugin.id}</span>
            <span className="opacity-40">·</span>
            <span>v{plugin.latest}</span>
          </div>
        </div>
        <ArrowUpRight className="size-4 shrink-0 -translate-x-1 translate-y-1 text-muted-foreground opacity-0 transition-all duration-300 ease-out-expo group-hover:translate-x-0 group-hover:translate-y-0 group-hover:opacity-100" />
      </div>
      <p className="line-clamp-2 flex-1 text-sm leading-relaxed text-muted-foreground">{plugin.description}</p>
      <div className="flex flex-wrap items-center gap-1.5">
        {plugin.tags.slice(0, 3).map((tag) => (
          <Badge key={tag} variant="outline" className="font-normal">
            {tag}
          </Badge>
        ))}
        {perms.length > 0 && (
          <span className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground">
            <ShieldCheck className="size-3.5" />
            {perms.length} 项权限
          </span>
        )}
      </div>
    </motion.button>
  );
}
