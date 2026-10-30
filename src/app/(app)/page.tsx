import { LayoutDashboard } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";

export default function OverviewPage() {
  return (
    <>
      <PageHeader title="Overview" />
      <EmptyState
        icon={LayoutDashboard}
        title="Nothing to show yet"
        description="Add a wallet to start tracking your portfolio."
      />
    </>
  );
}
