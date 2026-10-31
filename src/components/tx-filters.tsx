import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { cn } from "@/lib/utils";

/** Plain GET form: filters live in the URL, so they're shareable and work without JS. */
export function TxFilters({
  assets,
  values,
  extra,
}: {
  assets: { id: string; symbol: string }[];
  values: {
    direction?: string | undefined;
    asset?: string | undefined;
    q?: string | undefined;
    from?: string | undefined;
    to?: string | undefined;
  };
  extra?: React.ReactNode;
}) {
  return (
    <form method="get" className="flex flex-wrap items-end gap-2">
      <NativeSelect
        name="direction"
        defaultValue={values.direction ?? ""}
        aria-label="Type"
        className="w-32"
      >
        <option value="">All types</option>
        <option value="in">Received</option>
        <option value="out">Sent</option>
        <option value="swap">Swap</option>
        <option value="self">Internal</option>
      </NativeSelect>
      <NativeSelect
        name="asset"
        defaultValue={values.asset ?? ""}
        aria-label="Asset"
        className="w-32"
      >
        <option value="">All assets</option>
        {assets.map((a) => (
          <option key={a.id} value={a.id}>
            {a.symbol}
          </option>
        ))}
      </NativeSelect>
      <Input
        type="date"
        name="from"
        defaultValue={values.from}
        aria-label="From date"
        className="w-36"
      />
      <Input type="date" name="to" defaultValue={values.to} aria-label="To date" className="w-36" />
      <Input
        name="q"
        defaultValue={values.q}
        placeholder="Tx hash…"
        aria-label="Search by transaction hash"
        className="w-40 font-mono"
        spellCheck={false}
      />
      <Button type="submit" variant="secondary">
        Filter
      </Button>
      {extra}
    </form>
  );
}

export function Pagination({
  page,
  pages,
  total,
  hrefFor,
}: {
  page: number;
  pages: number;
  total: number;
  hrefFor: (page: number) => string;
}) {
  if (total === 0) return null;
  const linkClass = (disabled: boolean) =>
    cn(
      buttonVariants({ variant: "outline", size: "sm" }),
      disabled && "pointer-events-none opacity-50",
    );
  return (
    <nav className="flex items-center justify-between gap-2 pt-4" aria-label="Pagination">
      <span className="text-sm text-muted-foreground">
        {total.toLocaleString()} transaction{total === 1 ? "" : "s"} · page {page} of {pages}
      </span>
      <div className="flex gap-2">
        <Link href={hrefFor(page - 1)} className={linkClass(page <= 1)} aria-disabled={page <= 1}>
          <ChevronLeft className="size-4" /> Prev
        </Link>
        <Link
          href={hrefFor(page + 1)}
          className={linkClass(page >= pages)}
          aria-disabled={page >= pages}
        >
          Next <ChevronRight className="size-4" />
        </Link>
      </div>
    </nav>
  );
}
