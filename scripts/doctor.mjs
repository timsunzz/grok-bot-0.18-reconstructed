import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { archivedDmg, repoRoot } from "./lib/config.mjs";
import { bootstrapCanExtractDmg, bootstrapUnsupportedPlatformMessage } from "./lib/bootstrap-platform.mjs";

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function isLfsPointer(target) {
  try {
    const metadata = await stat(target);
    if (!metadata.isFile() || metadata.size > 1_024) return false;
    const head = await readFile(target, "utf8");
    return head.startsWith("version https://git-lfs.github.com/spec/v1");
  } catch {
    return false;
  }
}

const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
const nodeModules = await exists(path.join(repoRoot, "node_modules"));
const cachedRuntime = await exists(path.join(repoRoot, ".cache", "runtime", "Grok Bot.app"));
const lfsPointer = await isLfsPointer(archivedDmg);
const canExtract = bootstrapCanExtractDmg(process.platform, {
  configuredApp: process.env.GROK_BOT_018_APP ?? "",
  hasCachedRuntime: cachedRuntime,
});

const report = {
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  engines: packageJson.engines?.node ?? null,
  dependenciesInstalled: nodeModules,
  archivedInstaller: lfsPointer ? "lfs-pointer" : await exists(archivedDmg) ? "present" : "missing",
  cachedRuntime,
  canRunToolchain: nodeModules,
  canBootstrapRuntime: canExtract,
  canPackageMacApp: process.platform === "darwin",
  notes: [
    nodeModules ? "npm dependencies are installed." : "Run npm ci before tests or typecheck.",
    canExtract ? "Bootstrap can reuse a cached or configured runtime." : bootstrapUnsupportedPlatformMessage(),
    process.platform === "darwin"
      ? "Full macOS packaging is available on this host."
      : "The reconstructed desktop app is macOS-only; Linux can run the toolchain and router tests.",
    lfsPointer ? "Preserved installers are Git LFS pointers. Run git lfs pull for checksum fixtures." : "Installer archive metadata looks usable.",
  ],
};

console.log(JSON.stringify(report, null, 2));
if (!nodeModules) process.exitCode = 1;
