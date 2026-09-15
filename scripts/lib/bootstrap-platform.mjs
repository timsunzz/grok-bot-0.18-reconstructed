export function bootstrapCanExtractDmg(platform = process.platform, { configuredApp = "", hasCachedRuntime = false } = {}) {
  if (configuredApp.trim().length > 0 || hasCachedRuntime) return true;
  return platform === "darwin";
}

export function bootstrapUnsupportedPlatformMessage(platform = process.platform) {
  return `Bootstrap extracts the pinned macOS DMG with hdiutil, which is not available on ${platform}. Set GROK_BOT_018_APP to an existing app copy, reuse a cached runtime under .cache/runtime, or run bootstrap on macOS.`;
}
