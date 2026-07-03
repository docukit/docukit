/**
 * Get or create a unique device ID stored in localStorage.
 * This ID is shared across all tabs/windows on the same device.
 */
export const getDeviceId = () => {
  const storageKey = "docsync:deviceId";
  const localStorage = globalThis.localStorage;
  const stored = localStorage?.getItem(storageKey);
  if (stored) return stored;

  const deviceId = crypto.randomUUID();
  localStorage?.setItem(storageKey, deviceId);
  return deviceId;
};
