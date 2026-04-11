"use client";

import { createMultiClientsYjs } from "../utils/createMultiClientsYjs";

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
} = createMultiClientsYjs();

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
