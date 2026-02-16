/**
 * Get or create a unique device ID stored in localStorage.
 * This ID is shared across all tabs/windows on the same device.
 */
export function getDeviceId(): string {
  const key = "docsync:deviceId";
  let deviceId = localStorage.getItem(key);
  if (!deviceId) {
    deviceId = crypto.randomUUID();
    localStorage.setItem(key, deviceId);
  }
  return deviceId;
}
