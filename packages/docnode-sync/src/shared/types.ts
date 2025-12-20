import { type Server } from "socket.io";
import type { Operations } from "docnode";
import { type Socket } from "socket.io-client";

type OpsPayload = { docId: string; ops: Operations };

type SerializedDocPayload = { serializedDoc: unknown };

type ClientToServerEvents = {
  operations: (
    operations: OpsPayload[],
    cb: (res: OpsPayload[] | Error) => void,
  ) => void;
  jsonDoc: (
    jsonDoc: SerializedDocPayload, // should be an array of jsonDocs?
    cb: (res: SerializedDocPayload | Error) => void,
  ) => void;
};

type ServerToClientEvents = Record<string, never>;

export type ServerSocket = Server<ClientToServerEvents, ServerToClientEvents>;

export type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
