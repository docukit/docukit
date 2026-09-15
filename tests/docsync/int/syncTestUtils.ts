import type { ClientProvider } from "@docukit/docsync/client";
import { vi } from "vitest";

export function pauseNextWrite<S extends object, O extends object>(
  provider: ClientProvider<S, O>,
) {
  let resume: () => void = () => undefined;
  let entered: () => void = () => undefined;
  const paused = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const writing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const transaction = provider.transaction.bind(provider);
  let first = true;
  const spy = vi
    .spyOn(provider, "transaction")
    .mockImplementation(async (mode, callback) => {
      if (mode === "readwrite" && first) {
        first = false;
        entered();
        await paused;
      }
      return transaction(mode, callback);
    });
  return {
    writing,
    resume,
    restore: () => {
      resume();
      spy.mockRestore();
    },
  };
}
