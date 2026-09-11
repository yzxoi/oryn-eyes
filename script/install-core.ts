import {
  mkdir,
  mkdtemp,
  rm,
  cp,
  readdir,
  writeFile,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { command } from "../src/process";

const root = path.resolve(import.meta.dir, "..");
const pin = (await Bun.file(path.join(root, "config/core.json")).json()) as {
  repository: string;
  commit: string;
  packages: string[];
};
if (!/^[0-9a-f]{40}$/.test(pin.commit))
  throw new Error("Core must be pinned to a full commit");
const runtime = path.join(root, ".runtime");
await mkdir(runtime, { recursive: true });
const temp = await mkdtemp(path.join(tmpdir(), "oryn-eyes-core-build-"));
try {
  const source = path.join(temp, "source");
  await mkdir(source);
  const localIndex = process.argv.indexOf("--source");
  let gitRoot =
    localIndex >= 0
      ? path.resolve(process.argv[localIndex + 1]!)
      : path.join(temp, "git");
  if (localIndex < 0) {
    await command(["git", "init", gitRoot]);
    await command(
      ["git", "-C", gitRoot, "fetch", "--depth=1", pin.repository, pin.commit],
      { timeoutMs: 300_000 },
    );
  }
  const actual = await command([
    "git",
    "-C",
    gitRoot,
    "rev-parse",
    `${pin.commit}^{commit}`,
  ]);
  if (actual !== pin.commit) throw new Error("Core commit mismatch");
  const archive = path.join(temp, "source.tar");
  await command([
    "git",
    "-C",
    gitRoot,
    "archive",
    "--format=tar",
    `--output=${archive}`,
    pin.commit,
    "package.json",
    "script",
    "LICENSE",
    ...pin.packages,
    "packages/testing/fixtures/models-api.json",
  ]);
  await command(["tar", "-xf", archive, "-C", source]);
  const manifest = await Bun.file(path.join(source, "package.json")).json();
  const upstreamCatalog = manifest.workspaces.catalog;
  const usedCatalogKeys = new Set(["typescript", "@types/bun", "@types/node"]);
  for (const directory of pin.packages) {
    const file = path.join(source, directory, "package.json");
    const pkg = await Bun.file(file).json();
    pkg.devDependencies = Object.fromEntries(
      Object.entries(pkg.devDependencies ?? {}).filter(
        ([, version]) =>
          typeof version === "string" && !version.startsWith("workspace:"),
      ),
    );
    for (const [name, version] of Object.entries({
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.optionalDependencies,
    }))
      if (typeof version === "string" && version.startsWith("catalog:"))
        usedCatalogKeys.add(name);
    await writeFile(file, JSON.stringify(pkg, null, 2));
  }
  const catalog = Object.fromEntries(
    [...usedCatalogKeys].map((name) => [name, upstreamCatalog[name]]),
  );
  await writeFile(
    path.join(source, "package.json"),
    JSON.stringify(
      {
        name: "oryn-eyes-core-build",
        private: true,
        type: "module",
        workspaces: { packages: pin.packages, catalog },
        devDependencies: {
          typescript: catalog.typescript,
          "@types/bun": catalog["@types/bun"],
          "@types/node": catalog["@types/node"],
        },
      },
      null,
      2,
    ),
  );
  const lock = path.join(root, "config/core-bun.lock");
  const frozen = await Bun.file(lock).exists();
  if (frozen) await cp(lock, path.join(source, "bun.lock"));
  console.log("Installing the four-package core build closure...");
  await command(
    [
      "bun",
      "install",
      "--ignore-scripts",
      ...(frozen ? ["--frozen-lockfile"] : []),
    ],
    { cwd: source, timeoutMs: 300_000 },
  );
  if (!frozen) await cp(path.join(source, "bun.lock"), lock);
  if (process.platform === "linux") {
    const helperRoot = path.join(
      source,
      "packages/runtime-local/src/sandbox/helper-linux",
    );
    await command(["cargo", "build", "--release", "--locked"], {
      cwd: helperRoot,
      timeoutMs: 300_000,
    });
    const destination = path.join(
      source,
      "packages/runtime-local/sandbox-assets",
      `linux-${process.arch}`,
    );
    await mkdir(destination, { recursive: true });
    await cp(
      path.join(helperRoot, "target/release/synergy-sandbox-linux"),
      path.join(destination, "synergy-sandbox-linux"),
    );
  }
  const archivePath = `packages/${pin.commit}/${process.platform}-${process.arch}`;
  const archives = path.join(runtime, archivePath);
  await mkdir(archives, { recursive: true });
  console.log("Packing core through Synergy's public package builder...");
  await command(
    ["bun", "script/pack-workspace.ts", "packages/runtime-local", archives],
    { cwd: source, timeoutMs: 300_000 },
  );
  const dependencies: Record<string, string> = {};
  for (const directory of pin.packages) {
    const pkg = await Bun.file(
      path.join(source, directory, "package.json"),
    ).json();
    dependencies[pkg.name] =
      `file:./${archivePath}/${pkg.name.replace(/^@/, "").replaceAll("/", "-")}-${pkg.version}.tgz`;
  }
  await writeFile(
    path.join(runtime, "package.json"),
    JSON.stringify(
      {
        name: "oryn-eyes-core-runtime",
        private: true,
        type: "module",
        dependencies,
        overrides: dependencies,
      },
      null,
      2,
    ),
  );
  await command(["bun", "install", "--ignore-scripts"], {
    cwd: runtime,
    timeoutMs: 300_000,
  });
  const installed = await readdir(
    path.join(runtime, "node_modules/@ericsanchezok"),
  );
  const allowed = new Set([
    "synergy-harness",
    "synergy-runtime-local",
    "synergy-util",
    "synergy-link-protocol",
  ]);
  if (installed.some((name) => !allowed.has(name)))
    throw new Error("Unexpected Synergy product package installed");
  const build = await Bun.build({
    entrypoints: [path.join(root, "src/worker.ts")],
    outdir: runtime,
    target: "bun",
    external: ["@ericsanchezok/*"],
    naming: "worker.js",
  });
  if (!build.success)
    throw new AggregateError(build.logs, "Worker build failed");
  await cp(path.join(source, "LICENSE"), path.join(runtime, "SYNERGY-LICENSE"));
  await writeFile(
    path.join(runtime, "receipt.json"),
    JSON.stringify(
      {
        commit: pin.commit,
        platform: process.platform,
        arch: process.arch,
        bun: Bun.version,
        packages: installed,
      },
      null,
      2,
    ),
  );
  console.log(
    `Core installed: ${pin.commit.slice(0, 12)}; ${installed.join(", ")}`,
  );
} finally {
  await rm(temp, { recursive: true, force: true });
}
