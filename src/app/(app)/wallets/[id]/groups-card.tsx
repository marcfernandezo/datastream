import { Check, Plus } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { setMembershipAction } from "../actions";

/** Toggle chips: each is a tiny form, so it works without client JS. */
export function GroupsCard({
  walletId,
  groups,
  memberOf,
}: {
  walletId: string;
  groups: { id: string; name: string }[];
  memberOf: string[];
}) {
  if (groups.length === 0) return null;
  const member = new Set(memberOf);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Groups</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        {groups.map((g) => {
          const on = member.has(g.id);
          return (
            <form key={g.id} action={setMembershipAction.bind(null, walletId, g.id, !on)}>
              <button
                type="submit"
                aria-pressed={on}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                  on
                    ? "border-transparent bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted",
                )}
              >
                {on ? <Check className="size-3" /> : <Plus className="size-3" />}
                {g.name}
              </button>
            </form>
          );
        })}
      </CardContent>
    </Card>
  );
}
