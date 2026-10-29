// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
// Runs CI's fast checks for this branch's changes: format and lint of the
// changed files, knip, generated GraphQL operations, typecheck of the affected
// packages and their dependents, the test files beside the changed files, and
// the cross-file checks those miss (agent context budget, React Compiler
// coverage of the changed client files).
// A dependency change also gets the unused-patch install check below. CI still
// runs the full test suites and the jobs listed in the summary.
//
//   vp run check:changed          compare against the merge base with origin/main
//   vp run check:changed <ref>    compare against the merge base with <ref>
//
// Uncommitted and untracked files count. Affected packages come from
// .github/scripts/ci-changes.cjs, the same mapping CI uses to gate its jobs.
// The steps run side by side, as many at once as the machine's cores and
// available memory allow (CHECK_CHANGED_CONCURRENCY overrides; 1 runs them one
// by one), and each prints its output when it finishes. A step running past
// CHECK_CHANGED_TIMEOUT seconds (default 900) is killed with its process tree
// and reported as TIMEOUT. A rerun on exactly the files of the last passing run
// prints that run's summary.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { decide, readWorkspace } from "../.github/scripts/ci-changes.cjs";
import {
  awaitStep,
  createLimiter,
  defaultConcurrency,
  positiveInteger,
  type StepOutcome,
} from "./lib/check-changed-steps.ts";

const root = NodePath.resolve(import.meta.dirname, "..");
const CODE = /\.[cm]?[jt]sx?$/;

// quotePath=false keeps non-ASCII paths as real paths instead of quoted escapes.
const git = (...args: Array<string>) =>
  NodeChildProcess.execFileSync("git", ["-c", "core.quotePath=false", ...args], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\n")
    .filter(Boolean);

const ref = process.argv[2] ?? "origin/main";
const mergeBase = NodeChildProcess.spawnSync("git", ["merge-base", "HEAD", ref], {
  cwd: root,
  encoding: "utf8",
});
if (mergeBase.status !== 0) {
  console.error(
    `check:changed: no merge base with ${ref}. Run \`git fetch origin\` or pass a ref.`,
  );
  process.exit(1);
}
const base = mergeBase.stdout.trim();
// --no-renames lists a rename as its old and new path, as CI does.
const untracked = git("ls-files", "--others", "--exclude-standard");
const files = [
  ...new Set([...git("diff", "--name-only", "--no-renames", base, "--"), ...untracked]),
].sort();

if (files.length === 0) {
  console.log(`check:changed: no changes since ${base.slice(0, 12)}.`);
  process.exit(0);
}
console.log(`check:changed: ${files.length} files since ${base.slice(0, 12)}`);

// Ignored generated sources, declarations, env files, and install state affect check results.
// Include them in the key, but skip large ignored folders that no check reads.
// Recompute after a passing run so edits made during it are never cached as passing.
const inputKey = () => {
  const hash = NodeCrypto.createHash("sha256");
  // CI changes test behavior (vite.config.ts rejects .only under CI).
  hash.update(`${process.version}\0${base}\0${process.env.CI ?? ""}\0`);
  hash.update(
    NodeChildProcess.execFileSync(
      "git",
      ["diff", "--binary", "--no-renames", "--no-ext-diff", "--no-textconv", base, "--"],
      { cwd: root, maxBuffer: 1024 * 1024 * 1024 },
    ),
  );
  const ignored = git(
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
    "--",
    ":(glob)**/.generated/**",
    ":(glob)**/.astro/**",
    ":(glob)**/*.d.ts",
    ":(glob)**/.env*",
    ":(exclude,glob)**/node_modules/**",
  );
  for (const file of [
    // Raw bytes of changed files too: .gitattributes normalizes line endings in
    // the diff, but the formatter reads the file as it is on disk.
    ...git("diff", "--name-only", "--no-renames", base, "--"),
    ...git("ls-files", "--others", "--exclude-standard"),
    ...ignored,
    "node_modules/.modules.yaml",
    "node_modules/.pnpm/lock.yaml",
  ]) {
    hash.update(`\0${file}\0`);
    const path = NodePath.join(root, file);
    // Untracked nested repositories are listed as directories.
    if (NodeFS.statSync(path, { throwIfNoEntry: false })?.isFile()) {
      hash.update(NodeFS.readFileSync(path));
    }
  }
  return hash.digest("hex");
};
const key = inputKey();
const cachePath = NodePath.join(root, "node_modules/.cache/check-changed.json");
// A missing or unreadable cache is a miss, never a failure.
const readCache = () => {
  try {
    return JSON.parse(NodeFS.readFileSync(cachePath, "utf8")) as {
      key: string;
      summary: Array<string>;
    };
  } catch {
    return undefined;
  }
};
const cached = readCache();
if (cached?.key === key) {
  console.log("Nothing changed since the last passing run.\n");
  for (const line of cached.summary) console.log(line);
  process.exit(0);
}

const present = files.filter((file) => NodeFS.existsSync(NodePath.join(root, file)));
const code = present.filter((file) => CODE.test(file));
const packages = readWorkspace();
const { affected, outputs } = decide(files, packages, false);

// Changed test files, and the test files beside a changed source file
// (foo.ts -> foo.test.ts, foo.browser.test.tsx). Vitest's import-graph
// `related` reaches most of a package: one leaf server file pulled in 252 of
// 406 server test files and took 7 minutes. CI runs the rest.
const TEST = /\.test\.[cm]?[jt]sx?$/;
const tests = new Set(code.filter((file) => TEST.test(file)));
for (const file of code) {
  const dir = NodePath.dirname(file);
  const prefix = `${NodePath.basename(file).replace(CODE, "")}.`;
  for (const entry of NodeFS.readdirSync(NodePath.join(root, dir))) {
    if (entry.startsWith(prefix) && TEST.test(entry)) tests.add(NodePath.join(dir, entry));
  }
}
// It reads files other than the ones beside it, so no changed file selects it.
if (affected.includes("t3")) tests.add("apps/server/src/provider/AgentContextBudget.test.ts");

// React Compiler coverage compiles every client source file, so run only the
// changed files' cases, in one extra step: a -t filter in the main test step
// would drop every other test. An app is skipped when the main step already
// runs its coverage file unfiltered. File filters mirror each coverage test.
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const compilerApps = [
  {
    test: "apps/web/src/reactCompilerCoverage.test.ts",
    root: "apps/web/src/",
    // Test names keep the repo-relative path.
    name: (file: string) => file,
    compiled: (file: string) =>
      /\.tsx?$/.test(file) && !/\.(test|browser)\.tsx?$/.test(file) && !file.endsWith(".gen.ts"),
    // Web has only per-file cases.
    always: [],
  },
  {
    test: "apps/mobile/src/reactCompilerCoverage.test.ts",
    root: "apps/mobile/src/",
    name: (file: string) => file.slice("apps/mobile/".length),
    compiled: (file: string) => /\.tsx?$/.test(file) && !/\.(test\.tsx?|d\.ts)$/.test(file),
    // The Metro, cache, and stale-allowlist cases check more than one file, deletions included.
    always: ["^(?!.*compiles )"],
  },
].flatMap(({ test, root: appRoot, name, compiled, always }) => {
  const changed = files.filter((file) => file.startsWith(appRoot) && compiled(file));
  if (changed.length === 0 || tests.has(test)) return [];
  const names = changed
    .filter((file) => present.includes(file))
    .map((file) => `compiles ${escapeRegExp(name(file))}$`);
  const pattern = [...names, ...always];
  return pattern.length > 0 ? [{ test, names, pattern }] : [];
});
const compilerCoverage = compilerApps.length > 0 && {
  name: `react compiler (${compilerApps.reduce((count, app) => count + app.names.length, 0)} files)`,
  args: [
    "test",
    "run",
    ...compilerApps.map((app) => app.test),
    "-t",
    compilerApps.flatMap((app) => app.pattern).join("|"),
  ],
};

// knip:check cannot be scoped to a package. Any code change can leave a file,
// export, or dependency unused (removing the last import of a helper does), so
// it runs whenever code or a manifest changes.
const runKnip = files.some(
  (file) => CODE.test(file) || NodePath.basename(file) === "package.json" || file === "knip.jsonc",
);
// CI runs knip:check as one script of `knip ... && knip ...` passes. The passes
// do not depend on each other, so they run side by side here.
const knipCheck: string = JSON.parse(
  NodeFS.readFileSync(NodePath.join(root, "package.json"), "utf8"),
).scripts["knip:check"];
const knipPasses = knipCheck.split(" && ").map((command, index, all) => {
  const [bin, ...args] = command.trim().split(/\s+/);
  if (bin !== "knip" || /["'$\\|;&<>]/.test(command)) {
    throw new Error(`check:changed cannot split knip:check: ${command}`);
  }
  return { name: `knip ${index + 1}/${all.length}`, args: ["exec", "knip", ...args] };
});

// A version bump can leave a patch unused, causing pnpm to reject the install
// with ERR_PNPM_UNUSED_PATCH. Check it here as Release Smoke does in CI.
const runPatchCheck = files.some(
  (file) =>
    file === "pnpm-workspace.yaml" ||
    file === "pnpm-lock.yaml" ||
    file === ".pnpmfile.cjs" ||
    file.startsWith("patches/") ||
    file.startsWith("apps/mobile/deps/") ||
    NodePath.basename(file) === "package.json",
);

// Resolve without the lockfile in a temp copy to preserve the working tree and lockfile.
// Copy mobile modules too: they are file: dependencies, not workspace packages.
// Cached registry metadata limits this to patches stranded by local changes, not registry drift.
const checkPatches = (): boolean => {
  const temp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-patch-check-"));
  try {
    const copy = (relative: string) => {
      const dest = NodePath.join(temp, relative);
      NodeFS.mkdirSync(NodePath.dirname(dest), { recursive: true });
      NodeFS.cpSync(NodePath.join(root, relative), dest, { recursive: true });
    };
    copy("package.json");
    copy("pnpm-workspace.yaml");
    for (const pkg of packages) copy(`${pkg.dir}/package.json`);
    const modulesDir = NodePath.join(root, "apps/mobile/modules");
    if (NodeFS.existsSync(modulesDir)) {
      for (const entry of NodeFS.readdirSync(modulesDir)) {
        const manifest = `apps/mobile/modules/${entry}/package.json`;
        if (NodeFS.existsSync(NodePath.join(root, manifest))) copy(manifest);
      }
    }
    for (const extra of ["apps/mobile/deps", "patches", ".pnpmfile.cjs"]) {
      if (NodeFS.existsSync(NodePath.join(root, extra))) copy(extra);
    }
    const { status, stdout, stderr, error } = NodeChildProcess.spawnSync(
      "vp",
      ["install", "--lockfile-only", "--ignore-scripts"],
      { cwd: temp, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: timeoutSeconds * 1000 },
    );
    if (status === 0) return true;
    if (stdout) console.log(stdout);
    if (stderr) console.error(stderr);
    if (error) console.error(error.message);
    if (`${stdout ?? ""}${stderr ?? ""}`.includes("ERR_PNPM_UNUSED_PATCH")) {
      console.error(
        "Unused dependency patches: remove each patch named above from " +
          "patchedDependencies in pnpm-workspace.yaml and from patches/, " +
          "update it to the version the install resolves, " +
          "or pin the dependency that pulls it in to the patched version.",
      );
    }
    return false;
  } finally {
    NodeFS.rmSync(temp, { recursive: true, force: true });
  }
};

// CI's Lint job checks that generated GraphQL operations match their sources.
const graphql = ["apps/server", "packages/source-control-github"].filter((dir) =>
  files.some((file) => file.startsWith(`${dir}/`)),
);

// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone script has no Effect runtime.
const platform = process.platform;
// The typecheck step gets the same budget for its own package runs. macOS
// counts its file cache as used, so freemem() there would starve a large Mac.
const concurrency =
  positiveInteger(process.env.CHECK_CHANGED_CONCURRENCY) ??
  defaultConcurrency(
    NodeOS.availableParallelism(),
    platform === "darwin" ? NodeOS.totalmem() : NodeOS.freemem(),
  );
const timeoutSeconds = positiveInteger(process.env.CHECK_CHANGED_TIMEOUT) ?? 900;

const filters = (names: ReadonlyArray<string>) => names.flatMap((name) => ["--filter", name]);
const steps = [
  // Runs first; it takes about a second.
  runPatchCheck && { name: "unused patches", run: checkPatches },
  present.length > 0 && {
    name: "format",
    args: ["fmt", "--check", "--no-error-on-unmatched-pattern", ...present],
  },
  code.length > 0 && { name: "lint", args: ["lint", ...code] },
  ...(runKnip ? knipPasses : []),
  ...graphql.map((dir) => ({
    name: `graphql (${dir})`,
    args: ["run", "--filter", `./${dir}`, "generate", "--check"],
  })),
  affected.length > 0 && {
    name: `typecheck (${affected.length} packages)`,
    // `tsc --noEmit` writes nothing another package reads, so dependency order
    // only made dependents wait: --parallel cut a contracts change from 13 s to 9 s.
    args: [
      "run",
      "--cache",
      "--parallel",
      "--concurrency-limit",
      String(concurrency),
      ...filters(affected),
      "typecheck",
    ],
  },
  // From the repo root, the root vite.config.ts hands each file to its package's config.
  tests.size > 0 && {
    name: `test (${tests.size} files)`,
    args: ["test", "run", "--passWithNoTests", ...tests],
  },
  compilerCoverage,
].filter((step) => step !== false);

// Output is piped, so keep the colors a terminal would get.
const env = process.stdout.isTTY ? { ...process.env, FORCE_COLOR: "1" } : process.env;
// Each command leads its own process group so a timeout can kill the workers it
// started. That also hides Ctrl-C from them, so kill them on it. Windows has no
// process groups; taskkill /t walks the tree instead.
const windows = platform === "win32";
const running = new Set<NodeChildProcess.ChildProcess>();
const killTree = (child: NodeChildProcess.ChildProcess) => {
  if (child.pid === undefined) return;
  try {
    if (windows) {
      NodeChildProcess.spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"]);
    } else {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    // Already gone.
  }
};
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    for (const child of running) killTree(child);
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
}
const runStep = async (step: (typeof steps)[number]) => {
  const started = performance.now();
  const finish = (outcome: StepOutcome, output?: Buffer) => {
    const time =
      outcome === "TIMEOUT"
        ? `killed after ${timeoutSeconds}s`
        : `${((performance.now() - started) / 1000).toFixed(1)}s`;
    console.log(`\n> vp ${step.name}  ${outcome}  ${time}`);
    if (output) process.stdout.write(output);
    return { name: step.name, outcome, time };
  };
  // In-process steps print their own output. The patch check is first and
  // takes about a second, so the commands start right after it.
  if ("run" in step) return finish(step.run() ? "pass" : "FAIL");
  const child = NodeChildProcess.spawn("vp", step.args, { cwd: root, env, detached: !windows });
  running.add(child);
  const { outcome, output } = await awaitStep(child, timeoutSeconds * 1000, () => killTree(child));
  running.delete(child);
  return finish(outcome, output);
};

const limit = createLimiter(concurrency);

// Vitest runs started together race to rebuild node_modules/.vitest-cache after
// an install (ENOTEMPTY), so they run one after another.
let previousVitest: Promise<unknown> = Promise.resolve();
const results = await Promise.all(
  steps.map((step) => {
    if (!("args" in step) || step.args[0] !== "test") return limit(() => runStep(step));
    const result = previousVitest.then(() => limit(() => runStep(step)));
    previousVitest = result;
    return result;
  }),
);

const summary = ["check:changed summary"];
for (const result of results) {
  summary.push(`  ${result.outcome}  ${result.name}  ${result.time}`);
}
if (results.some((result) => result.outcome === "TIMEOUT")) {
  summary.push(
    `  TIMEOUT: ran past CHECK_CHANGED_TIMEOUT=${timeoutSeconds}s and was killed; this is not ` +
      "a check failure. Raise CHECK_CHANGED_TIMEOUT or lower CHECK_CHANGED_CONCURRENCY.",
  );
}
const ciOnly = Object.entries({
  "full test suites": outputs.test || outputs.test_web || outputs.test_server,
  build: outputs.build,
  rust: outputs.rust,
  "mobile native lint": outputs.mobile_native,
  "release smoke": outputs.release_smoke,
}).flatMap(([job, runs]) => (runs ? [job] : []));
if (ciOnly.length > 0) summary.push(`  CI also runs: ${ciOnly.join(", ")}`);
if (!runPatchCheck) summary.push("  unused patch check skipped: no dependency files changed");
if (!runKnip) summary.push("  knip skipped: no code or manifest changed");
console.log(`\n${summary.join("\n")}`);
// exitCode, not exit(): piped stdout is asynchronous on macOS, and exit()
// would cut off a failing step's output.
if (results.some((result) => result.outcome !== "pass")) {
  process.exitCode = 1;
} else if (inputKey() !== key) {
  console.log("  pass not cached: files changed during the run");
} else {
  try {
    // Write then rename, so a concurrent run never reads half a file.
    const temp = `${cachePath}.${process.pid}`;
    NodeFS.mkdirSync(NodePath.dirname(cachePath), { recursive: true });
    NodeFS.writeFileSync(temp, JSON.stringify({ key, summary }));
    NodeFS.renameSync(temp, cachePath);
  } catch (error) {
    console.warn(`  pass not cached: ${error instanceof Error ? error.message : String(error)}`);
  }
}
