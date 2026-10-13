// The CLI half of auto-effort: shows the server half's `changed` events as toasts.
import { Plugin } from "@opencode/plugin/tui";
import { AutoEffortRpc, type ChangedEvent } from "./rpc.ts";

export default Plugin.define({
  id: "auto-effort.tui",
  setup(context) {
    const rpc = context.client.rpc(AutoEffortRpc);
    const stop = rpc.events.on("changed", (event) => {
      const data = event.data as unknown as ChangedEvent;
      context.ui.toast.show({ message: data.message, variant: data.warning ? "warning" : "info", sessionID: data.sessionID });
    });
    return () => stop();
  },
});
