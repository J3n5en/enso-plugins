import { BadgeCheck, Check, Copy, ExternalLink, ShieldCheck, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import * as React from 'react';
import { toast } from 'sonner';

import { HoverFill } from '@/components/hover-fill';
import { PluginIcon } from '@/components/plugin-icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { CATEGORY_LABELS, categoryOf, formatSize, installLink, latestVersion, PERMISSION_LABELS, readmeUrl, timeAgo, type Plugin } from '@/lib/market';
import { easeOut, spring } from '@/lib/motion';

const PluginReadme = React.lazy(() => import('@/components/plugin-readme'));

export type Origin = { x: number; y: number };

const WIDTH = 560;
const TOP_VH = 0.1;

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = React.useState(false);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          onClick={() =>
            navigator.clipboard.writeText(text).then(() => {
              setDone(true);
              toast.success(`已复制 ${text}`);
              window.setTimeout(() => setDone(false), 1500);
            })
          }
        >
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={done ? 'done' : 'copy'}
              initial={{ opacity: 0, scale: 0.6 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.6 }}
              transition={{ duration: 0.2, ease: easeOut }}
            >
              {done ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
            </motion.span>
          </AnimatePresence>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2.5">
      <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</h3>
      {children}
    </section>
  );
}

/**
 * 详情弹层（“发芽”）：从被点击的卡片位置由 0.8 放大出现，关闭时原路收回（空间一致）。
 * 背景遮罩轻微模糊，暗示下层暂不可操作。
 */
export function PluginDialog({ plugin, origin, onClose }: { plugin: Plugin | null; origin: Origin | null; onClose: () => void }) {
  const left = typeof window === 'undefined' ? 0 : (window.innerWidth - Math.min(WIDTH, window.innerWidth - 32)) / 2;
  const top = typeof window === 'undefined' ? 0 : window.innerHeight * TOP_VH;
  const transformOrigin = origin ? `${origin.x - left}px ${origin.y - top}px` : '50% 0%';

  return (
    <DialogPrimitive.Root open={plugin !== null} onOpenChange={(open) => !open && onClose()}>
      <AnimatePresence>
        {plugin && (
          <DialogPrimitive.Portal forceMount>
            <DialogPrimitive.Overlay asChild forceMount>
              <motion.div
                className="fixed inset-0 z-50 bg-black/30 backdrop-blur-[2px]"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0, transition: { duration: 0.15 } }}
                transition={{ duration: 0.2, ease: easeOut }}
              />
            </DialogPrimitive.Overlay>
            <DialogPrimitive.Content
              asChild
              forceMount
              aria-describedby={undefined}
              // 焦点落在弹层本身，避免首个按钮的 tooltip 一打开就盖住标题
              onOpenAutoFocus={(e) => {
                e.preventDefault();
                (e.currentTarget as HTMLElement).focus();
              }}
            >
              <motion.div
                className="fixed inset-x-0 z-50 mx-auto flex max-h-[80vh] w-[min(560px,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border bg-popover text-popover-foreground shadow-2xl outline-none"
                style={{ top: `${TOP_VH * 100}vh`, transformOrigin }}
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1, transition: { scale: spring, opacity: { duration: 0.2, ease: easeOut } } }}
                exit={{ opacity: 0, scale: 0.8, transition: { duration: 0.18, ease: easeOut } }}
              >
                <DialogBody plugin={plugin} />
              </motion.div>
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        )}
      </AnimatePresence>
    </DialogPrimitive.Root>
  );
}

function DialogBody({ plugin }: { plugin: Plugin }) {
  const latest = latestVersion(plugin);
  const perms = latest?.permissions ?? [];
  const versions = [...plugin.versions].reverse();
  const homepage = /^https:\/\//.test(plugin.homepage ?? '') ? plugin.homepage : null;
  const install = installLink(plugin);
  const readme = readmeUrl(plugin);

  return (
    <>
      <header className="flex items-start gap-4 border-b p-6">
        <PluginIcon plugin={plugin} className="size-14" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <DialogPrimitive.Title className="truncate text-lg font-semibold tracking-tight">{plugin.name || plugin.id}</DialogPrimitive.Title>
            {plugin.tier === 'official' ? (
              <Badge variant="brand">
                <BadgeCheck />
                官方
              </Badge>
            ) : (
              <Badge variant="outline">社区</Badge>
            )}
            <Badge variant="outline" className="font-normal text-muted-foreground">
              {CATEGORY_LABELS[categoryOf(plugin)]}
            </Badge>
          </div>
          <div className="mt-1 flex items-center gap-1 font-mono text-xs text-muted-foreground">
            <span className="truncate">{plugin.id}</span>
            <CopyButton text={plugin.id} label="复制插件 id" />
          </div>
        </div>
        <DialogPrimitive.Close asChild>
          <Button variant="ghost" size="icon-sm" aria-label="关闭" className="-mt-1 -mr-2 text-muted-foreground">
            <X />
          </Button>
        </DialogPrimitive.Close>
      </header>

      <div className="space-y-6 overflow-y-auto p-6">
        <p className="text-sm leading-relaxed">{plugin.description}</p>

        <Section title="安装">
          {install && (
            <Button asChild>
              <a href={install}>在 EnsoCode 中安装</a>
            </Button>
          )}
          <ol className="space-y-1.5 text-sm text-muted-foreground">
            <li>
              1. 在 EnsoCode 中打开 <span className="font-medium text-foreground">设置 → 插件 → 市场</span>
            </li>
            <li>
              2. 搜索 <span className="font-medium text-foreground">{plugin.name || plugin.id}</span>，点击安装
            </li>
            {latest?.engines?.enso && (
              <li>
                需要 EnsoCode <span className="font-mono text-foreground">{latest.engines.enso}</span>
              </li>
            )}
          </ol>
        </Section>

        {readme && (
          <Section title="使用说明">
            <React.Suspense fallback={null}>
              <PluginReadme url={readme} />
            </React.Suspense>
          </Section>
        )}

        {perms.length > 0 && (
          <Section title={`权限 · ${perms.length}`}>
            <ul className="grid gap-1.5 sm:grid-cols-2">
              {perms.map((perm) => (
                <li key={perm} className="flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm">
                  <ShieldCheck className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{PERMISSION_LABELS[perm] ?? perm}</span>
                  <code className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground">{perm}</code>
                </li>
              ))}
            </ul>
          </Section>
        )}

        <Section title={`版本 · ${versions.length}`}>
          <HoverFill className="-mx-2.5 flex flex-col">
            {versions.map((v) => (
              <div key={v.version} data-fill className="flex items-center gap-3 rounded-md px-2.5 py-2 text-sm">
                <span className="font-mono font-medium">v{v.version}</span>
                {v.version === plugin.latest && <Badge variant="success">最新</Badge>}
                <span className="ml-auto text-xs text-muted-foreground">{timeAgo(v.publishedAt)}</span>
                <span className="w-16 text-right font-mono text-xs text-muted-foreground">{formatSize(v.size)}</span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <code tabIndex={0} className="cursor-default rounded font-mono text-xs text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
                      {v.sha256.slice(0, 8)}
                    </code>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-none font-mono">sha256 {v.sha256}</TooltipContent>
                </Tooltip>
              </div>
            ))}
          </HoverFill>
        </Section>
      </div>

      {(homepage || plugin.tags.length > 0) && (
        <footer className="flex items-center gap-2 border-t bg-muted/40 px-6 py-3">
          <div className="flex flex-wrap gap-1.5">
            {plugin.tags.map((tag) => (
              <Badge key={tag} variant="outline" className="font-normal">
                {tag}
              </Badge>
            ))}
          </div>
          {homepage && (
            <Button asChild variant="outline" size="sm" className="ml-auto">
              <a href={homepage} target="_blank" rel="noopener noreferrer">
                主页
                <ExternalLink />
              </a>
            </Button>
          )}
        </footer>
      )}
    </>
  );
}
