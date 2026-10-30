"use client";

import { useActionState, useState } from "react";
import { Plus, ShieldCheck } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { detectSourceKind, isAmbiguousXpub } from "@/lib/source-kind";
import { addWallet } from "./actions";

export interface NetworkOption {
  id: string;
  label: string;
  placeholder: string;
  hint: string;
  scriptTypes: { value: string; label: string }[];
}

const KIND_LABEL = {
  address: "Address",
  xpub: "Extended public key",
  ufvk: "Viewing key",
} as const;

export function AddWalletDialog({ networks }: { networks: NetworkOption[] }) {
  const [open, setOpen] = useState(false);
  const [network, setNetwork] = useState(networks[0]?.id ?? "btc");
  const [input, setInput] = useState("");
  // Controlled so values survive React's post-action form reset when there's an error.
  const [label, setLabel] = useState("");
  const [scriptType, setScriptType] = useState("auto");
  const [state, action, pending] = useActionState(addWallet, undefined);
  const current = networks.find((n) => n.id === network) ?? networks[0]!;
  const kind = input.trim() ? detectSourceKind(network, input) : null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button />}>
        <Plus className="size-4" /> Add wallet
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a wallet</DialogTitle>
          <DialogDescription className="flex items-start gap-2">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden />
            Public addresses and public keys only. Never paste a seed phrase or private key.
          </DialogDescription>
        </DialogHeader>
        <form action={action} className="flex flex-col gap-4" autoComplete="off">
          <div className="flex flex-col gap-2">
            <Label htmlFor="network">Network</Label>
            <NativeSelect
              id="network"
              name="network"
              value={network}
              onChange={(e) => setNetwork(e.target.value)}
            >
              {networks.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.label}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="input">Address or public key</Label>
              {kind && (
                <span className="text-xs text-muted-foreground">Detected: {KIND_LABEL[kind]}</span>
              )}
            </div>
            <Textarea
              id="input"
              name="input"
              required
              rows={3}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              data-1p-ignore
              className="font-mono text-xs break-all"
              placeholder={current.placeholder}
              value={input}
              onChange={(e) => setInput(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">{current.hint}</p>
          </div>
          {isAmbiguousXpub(network, input) && current.scriptTypes.length > 0 && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="scriptType">Address type</Label>
              <NativeSelect
                id="scriptType"
                name="scriptType"
                value={scriptType}
                onChange={(e) => setScriptType(e.target.value)}
              >
                {current.scriptTypes.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </NativeSelect>
              <p className="text-xs text-muted-foreground">
                Ledger Live and some wallets export every account type as <code>xpub</code>.
                Auto-detect checks which type has history.
              </p>
            </div>
          )}
          <div className="flex flex-col gap-2">
            <Label htmlFor="label">Label</Label>
            <Input
              id="label"
              name="label"
              required
              maxLength={60}
              placeholder="e.g. Ledger savings"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>
          {state?.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Adding…" : "Add wallet"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
