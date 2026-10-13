'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAccount, usePublicClient, useWriteContract } from 'wagmi';
import { parseAbi, type Address } from 'viem';
import { KeyRound } from 'lucide-react';
import { CONFIG, explorerTx } from '@/lib/config';
import { robinhood } from '@/lib/chain';
import { explainTxError } from '@/lib/txError';
import { shortAddr } from '@/lib/format';
import { useEnsureChain } from '@/lib/ensureChain';
import { ConnectButton } from './ConnectButton';

const abi = parseAbi([
  'function owner() view returns (address)',
  'function pendingOwner() view returns (address)',
  'function acceptOwnership()',
]);

/** Shows only while the factory has an owner change waiting; the waiting owner can accept it here. */
export function OwnershipPanel() {
  const { address, isConnected } = useAccount();
  const pc = usePublicClient({ chainId: robinhood.id });
  const { writeContractAsync } = useWriteContract();
  const ensureChain = useEnsureChain();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tx, setTx] = useState<string | null>(null);

  const state = useQuery({
    queryKey: ['factory-ownership'], enabled: !!pc, refetchInterval: 15_000,
    queryFn: async () => {
      const [owner, pending] = await Promise.all([
        pc!.readContract({ address: CONFIG.factory, abi, functionName: 'owner' }),
        pc!.readContract({ address: CONFIG.factory, abi, functionName: 'pendingOwner' }),
      ]);
      return { owner: owner as Address, pending: pending as Address };
    },
  });
  const pending = state.data?.pending;
  if (!pending || /^0x0{40}$/i.test(pending)) return null;
  const mine = !!address && address.toLowerCase() === pending.toLowerCase();

  async function accept() {
    if (!pc) return;
    setErr(null); setBusy(true);
    try {
      await ensureChain();
      await pc.simulateContract({ address: CONFIG.factory, abi, functionName: 'acceptOwnership', account: address });
      const h = await writeContractAsync({ chainId: robinhood.id, address: CONFIG.factory, abi, functionName: 'acceptOwnership' });
      setTx(h);
      const r = await pc.waitForTransactionReceipt({ hash: h });
      if (r.status !== 'success') throw new Error('The transaction failed on-chain');
      await state.refetch();
    } catch (e) { setErr(explainTxError(e)); } finally { setBusy(false); }
  }

  return (
    <section className="panel p-5">
      <h2 className="flex items-center gap-2 text-lg font-bold"><KeyRound className="h-5 w-5 text-brand-hi" /> Factory ownership</h2>
      <p className="mt-2 text-sm text-muted">
        The pad factory is waiting to be handed to <span className="font-mono text-text">{shortAddr(pending)}</span>. Currently owned by{' '}
        <span className="font-mono text-text">{state.data ? shortAddr(state.data.owner) : '…'}</span>.
      </p>
      {!isConnected ? (
        <div className="mt-4"><ConnectButton /></div>
      ) : !mine ? (
        <p className="mt-4 text-sm text-dim">Connect the wallet {shortAddr(pending)} to accept.</p>
      ) : (
        <button className="btn-brand mt-4 w-full py-3" disabled={busy} onClick={accept}>{busy ? 'Waiting…' : 'Accept ownership'}</button>
      )}
      {tx && <a className="mt-2 block truncate text-xs text-brand-hi" href={explorerTx(tx) || undefined} target="_blank" rel="noreferrer">tx {tx}</a>}
      {err && <div className="mt-2 rounded-xl border border-down/40 bg-down/5 p-2 text-xs text-down">{err}</div>}
    </section>
  );
}
