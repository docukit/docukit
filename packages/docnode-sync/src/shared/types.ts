import { type Server } from "socket.io";
import { type Socket } from "socket.io-client";

export type OpsPayload<O> = { docId: string; operations: O };

export type SerializedDocPayload<S> = { serializedDoc: S };

type ClientToServerEvents<S, O> = {
  operations: (
    operations: OpsPayload<O>[],
    cb: (res: OpsPayload<O>[] | Error) => void,
  ) => void;
  jsonDoc: (
    jsonDoc: SerializedDocPayload<S>, // should be an array of jsonDocs?
    cb: (res: SerializedDocPayload<S> | Error) => void,
  ) => void;
};

type ServerToClientEvents = Record<string, never>;

export type ServerSocket<S, O> = Server<
  ClientToServerEvents<S, O>,
  ServerToClientEvents
>;

export type ClientSocket<S, O> = Socket<
  ServerToClientEvents,
  ClientToServerEvents<S, O>
>;
