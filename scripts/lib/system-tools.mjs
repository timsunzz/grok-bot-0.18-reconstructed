export const SYSTEM_TOOLS = Object.freeze({
  cp: "/bin/cp",
  lsof: "/usr/sbin/lsof",
  ps: "/bin/ps",
  codesign: "/usr/bin/codesign",
  ditto: "/usr/bin/ditto",
  hdiutil: "/usr/bin/hdiutil",
  plutil: "/usr/bin/plutil",
  xattr: "/usr/bin/xattr",
});

/**
 * Every path above exists only on macOS, and `run` surfaces a missing one as
 * `spawn /usr/bin/hdiutil ENOENT` — which reads like a broken toolchain rather than an
 * unsupported host, several minutes into a build. Scripts that shell out to these state the
 * precondition up front instead.
 */
export function assertMacOsHost(task) {
  if (process.platform === "darwin") return;
  throw new Error(
    `${task} requires macOS. It runs ${Object.keys(SYSTEM_TOOLS).join(", ")}, which ship only with macOS; this host is ${process.platform}.`,
  );
}
