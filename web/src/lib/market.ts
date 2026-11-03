import { useEffect, useState } from 'react';

export type Version = {
  version: string;
  engines?: { enso: string };
  permissions: string[];
  path: string;
  sha256: string;
  size: number;
  publishedAt?: string;
};

export type Plugin = {
  id: string;
  name: string;
  description: string;
  tier: 'official' | 'community';
  tags: string[];
  homepage?: string;
  icon?: string;
  latest: string;
  versions: Version[];
};

export type MarketIndex = {
  schemaVersion: 1;
  generatedAt: string;
  sequence: number;
  plugins: Plugin[];
};

type State = { status: 'loading' } | { status: 'error' } | { status: 'ready'; index: MarketIndex };

export function useMarketIndex() {
  const [state, setState] = useState<State>({ status: 'loading' });
  useEffect(() => {
    let alive = true;
    fetch('/v1/index.json')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((index: MarketIndex) => {
        if (!alive) return;
        index.plugins = (index.plugins ?? []).filter((p) => !/^local\./.test(p.id));
        setState({ status: 'ready', index });
      })
      .catch(() => alive && setState({ status: 'error' }));
    return () => {
      alive = false;
    };
  }, []);
  return state;
}

export function latestVersion(plugin: Plugin): Version | undefined {
  return plugin.versions.find((v) => v.version === plugin.latest);
}

/** 远程图标统一经 Worker 代理，CSP 只放行同源图片 */
export function iconSrc(plugin: Plugin): string | null {
  return /^https:\/\//.test(plugin.icon ?? '') ? `/v1/icon?url=${encodeURIComponent(plugin.icon!)}` : null;
}

export function matches(plugin: Plugin, query: string): boolean {
  if (!query) return true;
  return [plugin.id, plugin.name, plugin.description, ...plugin.tags].join(' ').toLowerCase().includes(query);
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const rtf = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' });

export function timeAgo(iso?: string): string {
  if (!iso) return '';
  const diff = (new Date(iso).getTime() - Date.now()) / 1000;
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31536000],
    ['month', 2592000],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ];
  for (const [unit, seconds] of units) {
    if (Math.abs(diff) >= seconds) return rtf.format(Math.round(diff / seconds), unit);
  }
  return '刚刚';
}

export const PERMISSION_LABELS: Record<string, string> = {
  'ui.view': '在侧栏显示面板',
  'ui.slot': '在界面插槽中显示内容',
  'ui.notify': '弹出系统通知',
  'agent.tool': '向会话提供工具',
  'agent.inject': '向会话注入消息',
  'agent.observe': '观察会话执行过程',
  'composer.draft': '读写输入框草稿',
  'session.read': '读取会话内容',
  'session.focus': '切换当前会话',
  'session.create': '创建新会话',
  'fs.read': '读取项目文件',
  'process.background': '运行后台进程',
};
