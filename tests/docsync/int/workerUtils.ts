import { inject } from "vitest";

export const runWorkerClient = async (input: {
  token: string;
  docId: string;
  offline?: boolean;
  edit?: string;
}) => {
  const worker = new Worker(new URL("./client.worker.ts", import.meta.url), {
    type: "module",
  });
  try {
    const result = new Promise<unknown>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<unknown>) => resolve(event.data);
      worker.onerror = (event) => reject(new Error(event.message));
    });
    worker.postMessage({
      ...input,
      serverUrl: `ws://localhost:${inject("testServerPort")}`,
    });
    return await result;
  } finally {
    worker.terminate();
  }
};
