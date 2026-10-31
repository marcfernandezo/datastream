"use client";

import { useActionState, useState, useTransition } from "react";
import { Tags, Trash2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { createGroupAction, deleteGroupAction, type WalletFormState } from "./actions";

export function GroupsDialog({
  groups,
}: {
  groups: { id: string; name: string; wallets: number }[];
}) {
  const [name, setName] = useState("");
  const [pending, start] = useTransition();
  const [state, action, creating] = useActionState(async (prev: WalletFormState, fd: FormData) => {
    const result = await createGroupAction(prev, fd);
    if (result?.ok) setName("");
    return result;
  }, undefined);

  return (
    <Dialog>
      <DialogTrigger render={<Button variant="outline" />}>
        <Tags className="size-4" /> Groups
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Groups</DialogTitle>
          <DialogDescription>
            Group wallets (e.g. “Cold storage”, “Trading”) to filter, export and scope alerts.
            Assign wallets from each wallet’s page.
          </DialogDescription>
        </DialogHeader>
        <form action={action} className="flex gap-2">
          <Input
            name="name"
            placeholder="New group name"
            maxLength={40}
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="New group name"
          />
          <Button type="submit" disabled={creating}>
            Create
          </Button>
        </form>
        {state?.error && (
          <Alert variant="destructive">
            <AlertDescription>{state.error}</AlertDescription>
          </Alert>
        )}
        {groups.length > 0 && (
          <ul className="divide-y rounded-lg border">
            {groups.map((g) => (
              <li key={g.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                <span>
                  {g.name}
                  <span className="ml-2 text-xs text-muted-foreground">
                    {g.wallets} wallet{g.wallets === 1 ? "" : "s"}
                  </span>
                </span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={pending}
                  aria-label={`Delete group ${g.name}`}
                  onClick={() => start(() => deleteGroupAction(g.id))}
                >
                  <Trash2 className="size-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
