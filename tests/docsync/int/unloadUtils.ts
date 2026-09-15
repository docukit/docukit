import type { ClientProvider } from "@docukit/docsync/client";
import { expect, vi } from "vitest";
import { testWrapper } from "./utils.js";

export const withClosingDocument = async (
  callback: Parameters<typeof testWrapper>[0],
) => {
  await testWrapper(async (clients) => {
    clients.otherTab.disconnect();
    clients.otherDevice.disconnect();
    await clients.reference.loadDoc();
    await expect
      .poll(
        () =>
          clients.reference.client["_docsCache"].get(clients.docId)?.queryResult
            .fetchStatus,
      )
      .toBe("idle");
    clients.reference.client["_singleClientMaxDebounce"] = 5000;
    clients.reference.client["_collabMaxDebounce"] = 5000;
    await callback(clients);
  });
};

/** Delay one transaction, then let the real IndexedDB provider execute it. */
export function holdNextWrite<S extends object, O extends object>(
  provider: ClientProvider<S, O>,
) {
  let resume!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const writing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const transaction = provider.transaction.bind(provider);
  let held = false;
  const spy = vi
    .spyOn(provider, "transaction")
    .mockImplementation(async (mode, callback) => {
      if (mode === "readwrite" && !held) {
        held = true;
        entered();
        await gate;
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
