"use client";

import { lexicalDocNodeConfig } from "@docukit/docnode-lexical";
import { createMultiClients } from "../utils/createMultiClients";

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
} = createMultiClients([lexicalDocNodeConfig]);

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
