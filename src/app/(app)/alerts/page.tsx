import { Bell } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";

export default function AlertsPage() {
  return (
    <>
      <PageHeader title="Alerts" />
      <EmptyState icon={Bell} title="No alert channels yet" />
    </>
  );
}
