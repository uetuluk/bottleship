// Virtual NIC handlers. The host loads a network provider (see src/net/net-link.ts), creates
// the shared ring buffer and sends it here; the worker attaches it to the guest's adapter.
// Everything above the ring — rooms, relays, peer connections — is the host's business.
import { getVirtualNic } from "../core/net/virtual-nic";
import { netReset } from "../modules/wsa-net";
import { Logger, LogCategory } from "../core/logger";

/** Handles net_* host messages. Returns true if the message was consumed. */
export function handleNetMessage(message: any): boolean {
  if (message?.type === "net_attach") {
    try {
      const buffer = message.buffer as SharedArrayBuffer | undefined;
      const nic = getVirtualNic();
      if (buffer) {
        nic.attach(buffer);
      } else {
        nic.detach();
      }
      // Sockets from the previous link are meaningless on a new one: their addresses,
      // ports and peers all belonged to a room this guest is no longer in.
      netReset();
      self.postMessage({ type: "net_attached", ok: true, attached: Boolean(buffer) });
    } catch (error) {
      Logger.warn(LogCategory.SYSTEM, `[net] attach failed: ${String(error)}`);
      self.postMessage({ type: "net_attached", ok: false, error: String(error) });
    }
    return true;
  }

  if (message?.type === "net_stats") {
    self.postMessage({ type: "net_stats_result", stats: getVirtualNic().stats() });
    return true;
  }

  return false;
}
