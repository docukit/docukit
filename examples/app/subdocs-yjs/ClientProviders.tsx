"use client";

import { createMultiClientsYjs } from "../utils/createMultiClientsYjs";

const {
  useReferenceDoc,
  referenceClient,
  useOtherTabDoc,
  otherTabClient,
  useOtherDeviceDoc,
  otherDeviceClient,
} = createMultiClientsYjs();

export {
  useReferenceDoc,
  referenceClient,
  useOtherTabDoc,
  otherTabClient,
  useOtherDeviceDoc,
  otherDeviceClient,
};
