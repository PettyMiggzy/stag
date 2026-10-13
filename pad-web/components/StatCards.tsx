import { BarChart3, Droplets, Users, TrendingUp } from 'lucide-react';
import type { TokenStats } from '@/lib/data';
import { fmtUsd } from '@/lib/format';
import { CONFIG } from '@/lib/config';

export function StatCards({ stats, marketCapUsd }: { stats?: TokenStats; marketCapUsd?: number }) {
  const indexed = !!CONFIG.indexerUrl;
  const all = [
    ['Market Cap', fmtUsd(marketCapUsd ?? stats?.marketCapUsd, { compact: true }), TrendingUp, true],
    ['24h Volume', fmtUsd(stats?.volume24hUsd, { compact: true }), BarChart3, true],
    ['Liquidity', fmtUsd(stats?.liquidityUsd, { compact: true }), Droplets, true],
    ['Holders', stats?.holders !== undefined ? String(stats.holders) : '—', Users, indexed],
  ] as const;
  const items = all.filter((x) => x[3]);
  return (
    <div className={`grid grid-cols-2 gap-3 ${indexed ? 'lg:grid-cols-4' : 'lg:grid-cols-3'}`}>
      {items.map(([label, value, Icon]) => (
        <div key={label} className="panel flex items-center justify-between px-5 py-4">
          <div><div className="text-sm text-muted">{label}</div><div className="mt-1 text-2xl font-black">{value}</div></div>
          <Icon className="h-8 w-8 text-brand-hi/70" />
        </div>
      ))}
    </div>
  );
}
