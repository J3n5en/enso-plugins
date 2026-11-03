import { Github, RotateCw, Search, SearchX, ShieldCheck, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import * as React from 'react';
import { Toaster } from 'sonner';

import { HoverFill } from '@/components/hover-fill';
import { PluginCard } from '@/components/plugin-card';
import { PluginDialog, type Origin } from '@/components/plugin-dialog';
import { TextSwap } from '@/components/text-swap';
import { TierTabs, type Tier } from '@/components/tier-tabs';
import { Wordmark } from '@/components/wordmark';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Kbd } from '@/components/ui/kbd';
import { Skeleton } from '@/components/ui/skeleton';
import { TooltipProvider } from '@/components/ui/tooltip';
import { matches, useMarketIndex, type Plugin } from '@/lib/market';
import { easeOut } from '@/lib/motion';

const REPO = 'https://github.com/J3n5en/enso-plugins';

function CardSkeleton() {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-dashed p-5">
      <div className="flex items-center gap-3.5">
        <Skeleton className="size-11 rounded-[24%]" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-3 w-40" />
        </div>
      </div>
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-2/3" />
    </div>
  );
}

function Empty({ icon: Icon, title, children }: { icon: typeof SearchX; title: string; children?: React.ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.32, ease: easeOut }}
      className="col-span-full flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-16 text-center"
    >
      <span className="flex size-10 items-center justify-center rounded-lg border bg-card shadow-xs">
        <Icon className="size-5 text-muted-foreground" />
      </span>
      <p className="font-medium">{title}</p>
      {children}
    </motion.div>
  );
}

export default function App() {
  const state = useMarketIndex();
  const [query, setQuery] = React.useState('');
  const [tier, setTier] = React.useState<Tier>('');
  const [open, setOpen] = React.useState<{ plugin: Plugin; origin: Origin } | null>(null);
  const searchRef = React.useRef<HTMLInputElement>(null);

  // “/” 聚焦搜索，Esc 清空
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && document.activeElement?.tagName !== 'INPUT' && !open) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const plugins = state.status === 'ready' ? state.index.plugins : [];
  const q = query.trim().toLowerCase();
  const byQuery = plugins.filter((p) => matches(p, q));
  const counts: Record<Tier, number> = {
    '': byQuery.length,
    official: byQuery.filter((p) => p.tier === 'official').length,
    community: byQuery.filter((p) => p.tier === 'community').length,
  };
  const hits = byQuery.filter((p) => !tier || p.tier === tier);
  const listKey = `${q}|${tier}`;

  const openPlugin = (plugin: Plugin, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setOpen({ plugin, origin: { x: r.left + r.width / 2, y: r.top + r.height / 2 } });
  };

  return (
    <TooltipProvider>
      <div className="relative min-h-dvh overflow-x-clip">
        <div aria-hidden className="page-backdrop pointer-events-none absolute inset-x-0 top-0 -z-10 h-96" />

        <motion.div
          animate={{ scale: open ? 0.985 : 1 }}
          transition={{ duration: 0.32, ease: easeOut }}
          className="mx-auto max-w-5xl origin-top px-5 pt-12 pb-24 sm:px-8 sm:pt-16"
        >
          <header className="flex flex-col items-start gap-4">
            <a
              href={REPO}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-full border bg-background/70 px-3 py-1 text-xs text-muted-foreground shadow-xs backdrop-blur transition-colors hover:text-foreground"
            >
              <ShieldCheck className="size-3.5 text-success" />
              Ed25519 签名索引 · sha256 校验 · 不信任任何分发节点
            </a>
            <Wordmark className="text-[2rem] sm:text-[2.625rem]" />
            <p className="max-w-xl text-base leading-relaxed text-pretty text-muted-foreground">
              为 EnsoCode 扩展侧栏面板、会话工具与自动化能力。在 <span className="font-medium text-foreground">设置 → 插件 → 市场</span> 中一键安装。
            </p>
          </header>

          <div className="sticky top-0 z-20 -mx-5 mt-8 flex flex-col gap-3 bg-background/80 px-5 py-3 backdrop-blur-md sm:-mx-8 sm:flex-row sm:items-center sm:px-8">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={searchRef}
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
                placeholder="搜索插件名、描述、标签…"
                aria-label="搜索插件"
                className="h-9 bg-background pr-10 pl-9 [&::-webkit-search-cancel-button]:hidden"
              />
              <span className="absolute top-1/2 right-2 -translate-y-1/2">
                <AnimatePresence mode="popLayout" initial={false}>
                  {query ? (
                    <motion.span key="clear" initial={{ opacity: 0, scale: 0.6 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.6 }} transition={{ duration: 0.15 }}>
                      <Button variant="ghost" size="icon-sm" className="size-6" aria-label="清空搜索" onClick={() => (setQuery(''), searchRef.current?.focus())}>
                        <X className="size-3.5" />
                      </Button>
                    </motion.span>
                  ) : (
                    <motion.span key="kbd" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
                      <Kbd>/</Kbd>
                    </motion.span>
                  )}
                </AnimatePresence>
              </span>
            </div>
            <TierTabs value={tier} counts={counts} onChange={setTier} />
          </div>

          <HoverFill resetKey={listKey} className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3" fillClassName="rounded-xl border bg-card shadow-sm">
            {state.status === 'loading' && Array.from({ length: 6 }, (_, i) => <CardSkeleton key={i} />)}
            {state.status === 'error' && (
              <Empty icon={RotateCw} title="索引加载失败">
                <Button variant="outline" size="sm" onClick={() => location.reload()}>
                  <RotateCw />
                  重试
                </Button>
              </Empty>
            )}
            {state.status === 'ready' && (
              <AnimatePresence mode="popLayout" initial>
                {hits.map((plugin, i) => (
                  <PluginCard key={plugin.id} plugin={plugin} index={i} onOpen={openPlugin} />
                ))}
              </AnimatePresence>
            )}
            {state.status === 'ready' && hits.length === 0 && (
              <Empty icon={SearchX} title="没有匹配的插件">
                <Button variant="outline" size="sm" onClick={() => (setQuery(''), setTier(''))}>
                  清除筛选
                </Button>
              </Empty>
            )}
          </HoverFill>

          <section className="mt-16 flex flex-col gap-4 rounded-2xl border bg-card p-6 shadow-xs sm:flex-row sm:items-center sm:p-8">
            <div className="flex-1 space-y-1.5">
              <h2 className="font-semibold tracking-tight">发布你的插件</h2>
              <p className="text-sm leading-relaxed text-muted-foreground">
                在 <code className="font-mono text-xs">packages/&lt;id&gt;/</code> 放入带 <code className="font-mono text-xs">enso-plugin.json</code> 的目录并提交 Pull Request。合并后由 CI 打包、签名并发布。
              </p>
            </div>
            <Button asChild variant="default">
              <a href={REPO} target="_blank" rel="noopener noreferrer">
                <Github />
                提交 Pull Request
              </a>
            </Button>
          </section>

          {state.status === 'ready' && (
            <footer className="mt-10 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span>
                <TextSwap value={plugins.length} /> 个插件
              </span>
              <span>索引第 {state.index.sequence} 版</span>
              <span>更新于 {new Date(state.index.generatedAt).toLocaleString('zh-CN')}</span>
            </footer>
          )}
        </motion.div>

        <PluginDialog plugin={open?.plugin ?? null} origin={open?.origin ?? null} onClose={() => setOpen(null)} />
        <Toaster theme="system" position="bottom-center" toastOptions={{ className: 'font-sans' }} />
      </div>
    </TooltipProvider>
  );
}
