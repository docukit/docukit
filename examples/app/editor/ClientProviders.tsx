"use client";

import { lexicalDocNodeConfig } from "@docnode/lexical";
import { createMultiClients } from "../utils/createMultiClients";
import type { DocConfig } from "docnode";

// Create clients with lexicalDocNodeConfig
const {
  useReferenceDoc,
  useReferencePresence,
  referenceClient,
  useOtherTabDoc,
  useOtherTabPresence,
  otherTabClient,
  useOtherDeviceDoc,
  useOtherDevicePresence,
  otherDeviceClient,
} = createMultiClients([lexicalDocNodeConfig] as DocConfig[]);

export {
  useReferenceDoc,
  useReferencePresence,
  referenceClient,
  useOtherTabDoc,
  useOtherTabPresence,
  otherTabClient,
  useOtherDeviceDoc,
  useOtherDevicePresence,
  otherDeviceClient,
};
