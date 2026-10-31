/** Client-safe display metadata per network. */
export const NETWORK_META: Record<string, { label: string; symbol: string; className: string }> = {
  btc: {
    label: "Bitcoin",
    symbol: "BTC",
    className: "bg-orange-500/15 text-orange-600 dark:text-orange-400",
  },
  eth: {
    label: "Ethereum",
    symbol: "ETH",
    className: "bg-indigo-500/15 text-indigo-600 dark:text-indigo-300",
  },
  sol: {
    label: "Solana",
    symbol: "SOL",
    className: "bg-fuchsia-500/15 text-fuchsia-600 dark:text-fuchsia-300",
  },
  zec: {
    label: "Zcash",
    symbol: "ZEC",
    className: "bg-yellow-500/15 text-yellow-700 dark:text-yellow-300",
  },
};

export function networkMeta(id: string) {
  return (
    NETWORK_META[id] ?? { label: id.toUpperCase(), symbol: id.toUpperCase(), className: "bg-muted" }
  );
}
