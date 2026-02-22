import { io } from "socket.io-client";
import type { DocSyncClient } from "../index.js";
import type { ClientConfig, ClientSocket } from "../types.js";

export function createSocket<D extends {}, S extends {}, O extends {}>(
  client: DocSyncClient<D, S, O>,
  config: ClientConfig<D, S, O>,
): ClientSocket<S, O> {
  // deviceId needs to be captured at construction, not in the auth callback,
  // to avoid race conditions.
  const deviceId = getDeviceId();

  return io(config.server.url, {
    auth: (cb) => {
      void config.server.auth.getToken().then((token) => {
        cb({ token, deviceId, clientId: client["_clientId"] });
      });
    },
    transports: ["websocket"], // Skip polling, go straight to WebSocket for performance
    ackTimeout: 5000,
  });
}

/**
 * Get or create a unique device ID stored in localStorage.
 * This ID is shared across all tabs/windows on the same device.
 */
function getDeviceId(): string {
  const key = "docsync:deviceId";
  let deviceId = localStorage.getItem(key);
  if (!deviceId) {
    deviceId = crypto.randomUUID();
    localStorage.setItem(key, deviceId);
  }
  return deviceId;
}
