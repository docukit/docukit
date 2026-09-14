import { inject } from "vitest";

export type ComparisonResult = {
  workerEntryMs: number;
  localReadyMs: number;
  syncReadyMs: number;
  syncRequests: number;
};

export const measureWorker = async (token: string, docId: string) => {
  const startedAt = performance.timeOrigin + performance.now();
  const worker = new Worker(
    new URL("./comparison.worker.ts", import.meta.url),
    { type: "module" },
  );
  try {
    const result = new Promise<ComparisonResult>((resolve, reject) => {
      worker.onmessage = (
        event: MessageEvent<ComparisonResult | { error: string }>,
      ) => {
        if ("error" in event.data) reject(new Error(event.data.error));
        else resolve(event.data);
      };
      worker.onerror = (event) => reject(new Error(event.message));
    });
    worker.postMessage({
      token,
      docId,
      startedAt,
      serverUrl: `ws://localhost:${inject("testServerPort")}`,
    });
    return await result;
  } finally {
    worker.terminate();
  }
};

export const summarizeMeasurements = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    median:
      sorted.length % 2
        ? sorted[middle]
        : (sorted[middle - 1]! + sorted[middle]!) / 2,
    min: sorted[0],
    max: sorted.at(-1),
  };
};
