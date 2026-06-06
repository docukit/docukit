import type { QueryClient } from "@tanstack/query-core";
import type { DocBinding } from "../shared/types.js";
import { notImplemented } from "../shared/notImplemented.js";

export type DocSync2ClientConfig<
  D extends object = object,
  S = unknown,
  O = unknown,
> = { queryClient: QueryClient; docBinding?: DocBinding<D, S, O> };

export class DocSync2Client<
  D extends object = object,
  S = unknown,
  O = unknown,
> {
  constructor(public readonly config: DocSync2ClientConfig<D, S, O>) {}

  connect(): never {
    throw notImplemented();
  }

  disconnect(): never {
    throw notImplemented();
  }
}
