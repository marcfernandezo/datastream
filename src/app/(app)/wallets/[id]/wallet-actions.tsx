"use client";

import { useActionState, useState, useTransition } from "react";
import { Archive, ArchiveRestore, MoreHorizontal, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  deleteWalletAction,
  renameWalletAction,
  setArchivedAction,
  syncWalletAction,
  type WalletFormState,
} from "../actions";

export function WalletActions({
  id,
  label,
  archived,
  syncing,
}: {
  id: string;
  label: string;
  archived: boolean;
  syncing: boolean;
}) {
  const [dialog, setDialog] = useState<"rename" | "delete" | null>(null);
  const [pending, start] = useTransition();
  const [renameState, renameAction, renaming] = useActionState(
    async (prev: WalletFormState, formData: FormData) => {
      const result = await renameWalletAction(id, prev, formData);
      if (result?.ok) {
        setDialog(null);
        toast.success("Wallet renamed");
      }
      return result;
    },
    undefined,
  );

  return (
    <>
      <Button
        variant="outline"
        disabled={syncing || pending || archived}
        onClick={() => start(() => syncWalletAction(id))}
      >
        <RefreshCw className={syncing ? "size-4 animate-spin" : "size-4"} />
        {syncing ? "Syncing" : "Sync now"}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="outline" size="icon" aria-label="More actions" />}
        >
          <MoreHorizontal className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => setDialog("rename")}>
            <Pencil className="size-4" /> Rename
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => start(() => setArchivedAction(id, !archived))}>
            {archived ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
            {archived ? "Unarchive" : "Archive"}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={() => setDialog("delete")}>
            <Trash2 className="size-4" /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={dialog === "rename"} onOpenChange={(o) => setDialog(o ? "rename" : null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename wallet</DialogTitle>
          </DialogHeader>
          <form action={renameAction} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="rename-label">Label</Label>
              <Input
                id="rename-label"
                name="label"
                defaultValue={label}
                maxLength={60}
                required
                autoFocus
              />
            </div>
            {renameState?.error && (
              <Alert variant="destructive">
                <AlertDescription>{renameState.error}</AlertDescription>
              </Alert>
            )}
            <DialogFooter>
              <Button type="submit" disabled={renaming}>
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === "delete"} onOpenChange={(o) => setDialog(o ? "delete" : null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete “{label}”?</DialogTitle>
            <DialogDescription>
              This removes the wallet and its stored history from Datastream. Nothing happens
              on-chain. Archive it instead if you only want to hide it.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() => start(() => deleteWalletAction(id))}
            >
              Delete wallet
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
