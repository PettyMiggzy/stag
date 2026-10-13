'use client';
import Link from 'next/link';
import { clsx } from 'clsx';
import type { Launch, TokenStats } from '@/lib/data';
import { CONFIG } from '@/lib/config';
import { fmtUsd, fmtPct, shortAddr, timeAgo } from '@/lib/format';
import { TokenIcon } from '@/components/TokenIcon';

export function TokenCard({ launch, stats, taxBps }: { launch: Launch; stats?: TokenStats; taxBps?: { buy: number; sell: number } }) {
  const up = (stats?.change24hPct ?? 0) >= 0;
  return (
    <Link href={`/token/${launch.token}`} className="panel block min-w-0 p-4 transition hover:border-brand/60 hover:shadow-glow">
      <div className="flex items-start gap-3">
        <TokenIcon seed={launch.token} symbol={launch.symbol} className="h-12 w-12 shrink-0 rounded-xl bg-panel2" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-semibold">{launch.name}</span>
            <span className="text-xs text-muted">${launch.symbol}</span>
          </div>
          <div className="mt-0.5 text-xs text-dim">by {shortAddr(launch.creator)} · {timeAgo(launch.createdAt)} ago</div>
        </div>
        <span className={clsx('text-sm font-medium', up ? 'text-up' : 'text-down')}>{fmtPct(stats?.change24hPct)}</span>
      </div>
      <div className={clsx('mt-4 grid gap-2 text-xs', CONFIG.indexerUrl ? 'grid-cols-3' : 'grid-cols-2')}>
        <Stat label="MCap" value={fmtUsd(stats?.marketCapUsd, { compact: true })} />
        {<Stat label="24h Vol" value={fmtUsd(stats?.volume24hUsd, { compact: true })} />}
        {CONFIG.indexerUrl && <Stat label="Holders" value={stats?.holders !== undefined ? String(stats.holders) : '—'} />}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <span className="chip">LP locked</span>
        {taxBps && <span className="chip">tax {taxBps.buy / 100}% / {taxBps.sell / 100}%</span>}
      </div>
    </Link>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-panel2 px-2 py-1.5">
      <div className="text-dim">{label}</div>
      <div className="font-medium text-text">{value}</div>
    </div>
  );
}
