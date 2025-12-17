import { type Server } from "socket.io";
import type { JsonDoc, Operations } from "docnode";
import { type Socket } from "socket.io-client";

export type OpsPayload = { docId: string; ops: Operations };

// Later I can decide if adding docId is worthwhile, although it's included in jsonDoc[0],
// so in the best-case scenario it could be a micro-optimization.
export type JsonDocPayload = { jsonDoc: JsonDoc };

type ClientToServerEvents = {
  operations: (
    operations: OpsPayload[],
    cb: (res: OpsPayload[] | Error) => void,
  ) => void;
  jsonDoc: (
    jsonDoc: JsonDocPayload, // should be an array of jsonDocs?
    cb: (res: JsonDocPayload | Error) => void,
  ) => void;
};

type ServerToClientEvents = Record<string, never>;

export type ServerSocket = Server<ClientToServerEvents, ServerToClientEvents>;

export type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
