// Per-thread instruction and cycle counter on macOS (Apple Silicon) through node:ffi (experimental in Node 26).
// thread_selfcounts(1 = THSC_CPI, buf, 16) fills { instructions: u64, cycles: u64 } for the calling thread.
import ffi from "node:ffi";
const lib = ffi.dlopen("/usr/lib/system/libsystem_kernel.dylib", {
  thread_selfcounts: {
    arguments: ["int32", "buffer", "uint64"],
    return: "int32",
  },
} as any);
const buf = Buffer.alloc(16);
export const counts = () => {
  const rc = (lib.functions as any).thread_selfcounts(1, buf, 16n);
  if (rc !== 0) throw new Error("thread_selfcounts rc=" + rc);
  return { ins: buf.readBigUInt64LE(0), cyc: buf.readBigUInt64LE(8) };
};
