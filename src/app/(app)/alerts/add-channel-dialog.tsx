"use client";

import { useActionState, useState } from "react";
import { Plus } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { addChannelAction, type ChannelFormState } from "./actions";

interface Option {
  id: string;
  label: string;
}

export function AddChannelDialog({ wallets, groups }: { wallets: Option[]; groups: Option[] }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<"ntfy" | "telegram">("ntfy");
  const [scopeMode, setScopeMode] = useState<"all" | "custom">("all");
  // Controlled so values survive React's post-action form reset on errors.
  const [fields, setFields] = useState({
    name: "",
    url: "",
    token: "",
    botToken: "",
    chatId: "",
    minEur: "0",
  });
  const set = (k: keyof typeof fields) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setFields((f) => ({ ...f, [k]: e.target.value }));

  const [state, action, pending] = useActionState(async (prev: ChannelFormState, fd: FormData) => {
    const result = await addChannelAction(prev, fd);
    if (result?.ok) {
      setOpen(false);
      setFields({ name: "", url: "", token: "", botToken: "", chatId: "", minEur: "0" });
    }
    return result;
  }, undefined);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button />}>
        <Plus className="size-4" /> Add channel
      </DialogTrigger>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add alert channel</DialogTitle>
          <DialogDescription>
            Notifications include the wallet label, direction and amount, but never addresses or
            transaction ids.
          </DialogDescription>
        </DialogHeader>
        <form action={action} className="flex flex-col gap-4" autoComplete="off">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="kind">Service</Label>
              <NativeSelect
                id="kind"
                name="kind"
                value={kind}
                onChange={(e) => setKind(e.target.value as "ntfy" | "telegram")}
              >
                <option value="ntfy">ntfy</option>
                <option value="telegram">Telegram</option>
              </NativeSelect>
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                name="name"
                required
                maxLength={60}
                placeholder="My phone"
                value={fields.name}
                onChange={set("name")}
              />
            </div>
          </div>

          {kind === "ntfy" ? (
            <>
              <div className="flex flex-col gap-2">
                <Label htmlFor="url">Topic URL</Label>
                <Input
                  id="url"
                  name="url"
                  type="url"
                  required
                  placeholder="https://ntfy.sh/a-long-random-topic"
                  className="font-mono text-xs"
                  value={fields.url}
                  onChange={set("url")}
                />
                <p className="text-xs text-muted-foreground">
                  On public ntfy.sh anyone who knows the topic can read it: use a long random name
                  or your own server.
                </p>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="token">Access token (optional)</Label>
                <Input
                  id="token"
                  name="token"
                  type="password"
                  placeholder="tk_…"
                  value={fields.token}
                  onChange={set("token")}
                />
              </div>
            </>
          ) : (
            <>
              <div className="flex flex-col gap-2">
                <Label htmlFor="botToken">Bot token</Label>
                <Input
                  id="botToken"
                  name="botToken"
                  type="password"
                  required
                  placeholder="123456789:AA…"
                  value={fields.botToken}
                  onChange={set("botToken")}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="chatId">Chat id</Label>
                <Input
                  id="chatId"
                  name="chatId"
                  required
                  placeholder="123456789"
                  value={fields.chatId}
                  onChange={set("chatId")}
                />
                <p className="text-xs text-muted-foreground">
                  Message your bot once, then read the id from{" "}
                  <code>api.telegram.org/bot&lt;token&gt;/getUpdates</code>.
                </p>
              </div>
            </>
          )}

          <div className="flex flex-col gap-2">
            <Label htmlFor="scopeMode">Wallets</Label>
            <NativeSelect
              id="scopeMode"
              name="scopeMode"
              value={scopeMode}
              onChange={(e) => setScopeMode(e.target.value as "all" | "custom")}
            >
              <option value="all">All wallets</option>
              <option value="custom">Selected wallets and groups</option>
            </NativeSelect>
            {scopeMode === "custom" && (
              <div className="grid max-h-48 gap-1.5 overflow-y-auto rounded-lg border p-3 text-sm">
                {groups.map((g) => (
                  <label key={g.id} className="flex items-center gap-2">
                    <Checkbox name="groupIds" value={g.id} /> <span>Group: {g.label}</span>
                  </label>
                ))}
                {wallets.map((w) => (
                  <label key={w.id} className="flex items-center gap-2">
                    <Checkbox name="walletIds" value={w.id} /> <span>{w.label}</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="minEur">Minimum value (EUR)</Label>
              <Input
                id="minEur"
                name="minEur"
                type="number"
                min={0}
                step="any"
                value={fields.minEur}
                onChange={set("minEur")}
              />
            </div>
            <label className="flex items-center gap-2 self-end pb-1.5 text-sm">
              <Checkbox name="hideAmounts" /> Hide amounts in notifications
            </label>
          </div>

          {state?.error && (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save channel"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
