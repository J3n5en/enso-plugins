import * as React from 'react';

import { iconSrc, type Plugin } from '@/lib/market';
import { cn } from '@/lib/utils';

const HUES = [264, 200, 152, 28, 340, 300, 84];

/** 没有图标或加载失败时，用首字母 + 按 id 取色的渐变方块兜底，和官方图标同一套外形 */
export function PluginIcon({ plugin, className }: { plugin: Plugin; className?: string }) {
  const src = iconSrc(plugin);
  const [failed, setFailed] = React.useState(false);
  const shape = cn('size-11 shrink-0 rounded-[24%] shadow-[0_1px_2px_rgb(0_0_0/0.12),inset_0_0_0_1px_rgb(255_255_255/0.08)]', className);
  if (src && !failed) {
    return <img src={src} alt="" loading="lazy" decoding="async" className={cn(shape, 'bg-muted object-contain')} onError={() => setFailed(true)} />;
  }
  const hue = HUES[[...plugin.id].reduce((n, c) => n + c.charCodeAt(0), 0) % HUES.length];
  return (
    <span
      aria-hidden
      className={cn(shape, 'flex items-center justify-center font-semibold text-white')}
      style={{ background: `linear-gradient(to bottom, oklch(0.72 0.15 ${hue}), oklch(0.52 0.17 ${hue}))` }}
    >
      {(plugin.name || plugin.id).slice(0, 1).toUpperCase()}
    </span>
  );
}
