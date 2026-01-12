import { type io } from "socket.io-client";

type TestSocket = ReturnType<typeof io>;

export const waitForConnect = (socket: TestSocket) =>
  new Promise<void>((resolve, reject) => {
    socket.on("connect", resolve);
    socket.on("connect_error", reject);
  });

export const waitForError = (socket: TestSocket) =>
  new Promise<Error>((resolve) => {
    socket.on("connect_error", resolve);
  });

/* eslint-disable @typescript-eslint/no-restricted-types -- API uses null */
type SyncPayload = {
  docId: string;
  operations: unknown[] | null;
  clock: number;
};
type SyncResponse = {
  docId: string;
  clock: number;
  operations: unknown[] | null;
};

export const syncOperations = (socket: TestSocket, payload: SyncPayload) =>
  new Promise<SyncResponse>((resolve) => {
    socket.emit("sync-operations", payload, resolve);
  });
