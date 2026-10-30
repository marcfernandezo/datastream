import { Wallet } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";

export default function WalletsPage() {
  return (
    <>
      <PageHeader title="Wallets" />
      <EmptyState icon={Wallet} title="No wallets yet" />
    </>
  );
}
