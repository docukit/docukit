"use client";

import { lexicalDocNodeConfig } from "@docnode/lexical";
import { createMultiClients } from "../utils/createMultiClients";
import type { DocConfig } from "docnode";

// Create clients with lexicalDocNodeConfig
const {
  useReferenceDoc,
  referenceClient,
  useOtherTabDoc,
  otherTabClient,
  useOtherDeviceDoc,
  otherDeviceClient,
} = createMultiClients([lexicalDocNodeConfig] as DocConfig[]);

export {
  useReferenceDoc,
  referenceClient,
  useOtherTabDoc,
  otherTabClient,
  useOtherDeviceDoc,
  otherDeviceClient,
};
