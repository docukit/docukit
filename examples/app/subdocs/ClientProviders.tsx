"use client";

import type { DocConfig } from "@docukit/docnode";
import {
  IndexNode,
  createIndexNode,
  indexDocConfig,
} from "../../shared-config";
import { createMultiClients } from "../utils/createMultiClients";

// Re-export for IndexDoc component
export { IndexNode, createIndexNode };

// Create clients with indexDocConfig
const {
  useReferenceDoc,
  referenceClient,
  useOtherTabDoc,
  otherTabClient,
  useOtherDeviceDoc,
  otherDeviceClient,
} = createMultiClients([indexDocConfig] as DocConfig[]);

export {
  useReferenceDoc,
  referenceClient,
  useOtherTabDoc,
  otherTabClient,
  useOtherDeviceDoc,
  otherDeviceClient,
};
