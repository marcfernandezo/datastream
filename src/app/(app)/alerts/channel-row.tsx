"use client";

import { useTransition } from "react";
import { Send, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { deleteChannelAction, testChannelAction, toggleChannelAction } from "./actions";

export interface ChannelView {
  id: string;
  name: string;
  kind: "ntfy" | "telegram";
  enabled: boolean;
  target: string;
  scopeLabel: string;
  minEur: number;
  hideAmounts: boolean;
}

export function ChannelRow({ channel }: { channel: ChannelView }) {
  const [pending, start] = useTransition();
  return (
    <li className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{channel.name}</span>
          <Badge variant="secondary">{channel.kind === "ntfy" ? "ntfy" : "Telegram"}</Badge>
          {!channel.enabled && <Badge variant="outline">Paused</Badge>}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {channel.target} · {channel.scopeLabel}
          {channel.minEur > 0 && ` · ≥ €${channel.minEur}`}
          {channel.hideAmounts && " · amounts hidden"}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Switch
            checked={channel.enabled}
            disabled={pending}
            onCheckedChange={(v) => start(() => toggleChannelAction(channel.id, v))}
            aria-label={`${channel.enabled ? "Pause" : "Enable"} ${channel.name}`}
          />
          Enabled
        </label>
        <Button
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const res = await testChannelAction(channel.id);
              if (res.ok) toast.success("Test notification sent");
              else toast.error(res.error ?? "Delivery failed");
            })
          }
        >
          <Send className="size-3.5" /> Test
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Delete ${channel.name}`}
          disabled={pending}
          onClick={() => {
            if (confirm(`Delete the “${channel.name}” channel?`))
              start(() => deleteChannelAction(channel.id));
          }}
        >
          <Trash2 className="size-4" />
        </Button>
      </div>
    </li>
  );
}
