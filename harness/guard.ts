// Scripted spend guard, ported from the x402-probe v1 mitigations to
// GalaChain terms. One rule per attack class; each is a few lines.

export interface SignedEntry {
  origin: string;
  to: string;
  amountAtomic: bigint;
  uniqueKey: string;
  dtoExpiresAt: number;
  delivered: boolean;
}

export interface GuardConfig {
  /** Pay-to addresses per origin, configured out of band. Unknown origins refused. */
  payTo: Record<string, string[]>;
  /** Cap on the seller-chosen validity window, in seconds. */
  maxTimeoutSeconds: number;
  /** Cumulative cap on signed exposure (atomic units of the payment asset). */
  budgetAtomic: bigint;
}

export type Decision = { pay: true } | { pay: false; reason: string };

export interface Terms {
  origin: string;
  path: string;
  payTo: string;
  amountAtomic: bigint;
  maxTimeoutSeconds: number;
}

export function guarded(cfg: GuardConfig) {
  const pinned = new Map<string, bigint>();
  return (terms: Terms, ledger: readonly SignedEntry[]): Decision => {
    const allowed = cfg.payTo[terms.origin];
    if (!allowed) return { pay: false, reason: `no pay-to configured for ${terms.origin}` };
    if (!allowed.some(a => a.toLowerCase() === terms.payTo.toLowerCase())) {
      return { pay: false, reason: `pay-to ${terms.payTo} not allowed for ${terms.origin}` };
    }

    if (terms.maxTimeoutSeconds > cfg.maxTimeoutSeconds) {
      return { pay: false, reason: `validity window ${terms.maxTimeoutSeconds}s exceeds ${cfg.maxTimeoutSeconds}s` };
    }

    const now = Date.now();
    const open = ledger.find(e => e.origin === terms.origin && !e.delivered && e.dtoExpiresAt > now);
    if (open) {
      return { pay: false, reason: `unresolved authorization ${open.uniqueKey.slice(0, 13)}; reconcile before paying again` };
    }

    const key = terms.origin + terms.path;
    const pin = pinned.get(key);
    if (pin === undefined) pinned.set(key, terms.amountAtomic);
    else if (terms.amountAtomic > pin) {
      return { pay: false, reason: `price ${terms.amountAtomic} above pinned ${pin} for ${terms.path}` };
    }

    const exposure = ledger.reduce((sum, e) => sum + e.amountAtomic, 0n);
    if (exposure + terms.amountAtomic > cfg.budgetAtomic) {
      return { pay: false, reason: `budget: ${exposure} signed + ${terms.amountAtomic} > ${cfg.budgetAtomic}` };
    }

    return { pay: true };
  };
}
