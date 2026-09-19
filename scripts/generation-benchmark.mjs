// Small operator-driven development harness. The active agent owns planning;
// this script measures wall time and existing tools, never supplies a layout.
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import {
  readBoundedWorkspaceBytes,
  writeCanonicalWorkspaceJson,
  writePrivateWorkspaceText,
} from "@basalt/artifact-store";
import { contentHash, stableJson } from "@basalt/contracts";
import { WORLD_BUILD_SCHEMA, worldBuildDiagnostics } from "@basalt/world-compiler";
import { assertRuntimeBuildCurrent } from "./runtime-build-manifest.mjs";

const execFile = promisify(execFileCallback);
const root = resolve(".");
const option = (flag) => {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing ${flag} value`);
  return value;
};
const output = option("--output") ?? ".basalt/evals/generation-latency";
const suitePath = option("--suite") ?? "test/fixtures/generation-briefs.json";
const bytes = (path) => readBoundedWorkspaceBytes(root, path, 64 * 1024 * 1024);
const json = async (path) => JSON.parse((await bytes(path)).toString());
const hash = async (path) => contentHash(await bytes(path));
export async function optionalArtifactHash(workspace, path) {
  try {
    await lstat(resolve(workspace, path));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
  return contentHash(await readBoundedWorkspaceBytes(workspace, path, 64 * 1024 * 1024));
}
async function write(path, value, previous) {
  return writeCanonicalWorkspaceJson(root, path, value, {
    maxBytes: 64 * 1024 * 1024,
    ...(previous === undefined ? {} : { expectedExistingHash: previous }),
  });
}
const runPath = (id) => `${output}/${id}/run.json`;

export function summarizeRun(run, targetSeconds = 300) {
  const accepted = run.reviews.find((review) => review.status === "eligible");
  const captures = run.events.filter((event) => event.action === "capture" && event.ok);
  return {
    id: run.id,
    status: run.status,
    attempts: run.events.filter((event) => event.action === "compile").length,
    firstPreviewSeconds: captures[0]?.elapsedSeconds ?? null,
    agentAcceptedSeconds: accepted?.elapsedSeconds ?? null,
    withinTarget:
      run.status === "eligible" && accepted ? accepted.elapsedSeconds <= targetSeconds : false,
    recordedCommandCount: run.events.length,
    modelCallCount: null,
    totalAgentToolCallCount: null,
    compileSeconds: run.events
      .filter((e) => e.action === "compile")
      .reduce((s, e) => s + e.seconds, 0),
    captureSeconds: run.events
      .filter((e) => e.action === "capture")
      .reduce((s, e) => s + e.seconds, 0),
    totalElapsedSeconds: run.finishedAt ? (run.finishedAt - run.startedAt) / 1000 : null,
    creatorAccepted: null,
    engineVerified: false,
    review: run.reviews.at(-1) ?? null,
    events: run.events,
  };
}

export function validateReview(review, brief, capture) {
  if (!capture || !capture.ok) throw new Error("Review requires a successful captured world");
  if (review.worldBuildHash !== capture.worldBuildHash)
    throw new Error("Review belongs to a different world");
  if (!["eligible", "incomplete", "rejected"].includes(review.status))
    throw new Error("Invalid review status");
  if (review.authority !== "delegated_ai" || review.independent !== false)
    throw new Error("This pilot only admits explicitly non-independent delegated AI review");
  if (!Array.isArray(review.checks) || review.checks.length !== brief.checks.length)
    throw new Error("Every predeclared visual check needs a verdict");
  for (const [index, check] of review.checks.entries()) {
    if (
      check.check !== brief.checks[index] ||
      !["pass", "fail", "uncertain"].includes(check.verdict) ||
      typeof check.note !== "string" ||
      !check.note.trim()
    )
      throw new Error("Invalid visual check or missing observation");
  }
  if (review.status === "eligible" && review.checks.some((check) => check.verdict !== "pass"))
    throw new Error("Failed or uncertain visual checks cannot be accepted");
  if (typeof review.note !== "string" || !review.note.trim())
    throw new Error("Review needs a summary");
}

async function snapshot() {
  const { stdout } = await execFile(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      "packages",
      "scripts",
      "registry/semantics",
      "package.json",
      "package-lock.json",
    ],
    { cwd: root },
  );
  const catalog = await json("registry/catalog.json");
  const measurements = catalog.retainedEvidence.find(
    (entry) => entry.kind === "CatalogMeasurementSet",
  );
  const paths = [
    ...new Set([
      ...stdout.split("\0").filter(Boolean),
      suitePath,
      "scripts/generation-benchmark.mjs",
      "scripts/world-preview-views.mjs",
      "registry/catalog.json",
      measurements.relativePath,
      ".basalt/evals/harvest-valley/spatial-plan.json",
      "test/helpers/harvest-valley-fixture.ts",
      "test/helpers/catalog-first-use-fixture.ts",
    ]),
  ].sort();
  const authoringTools = `${output}/authoring-tools.mjs`;
  if (await optionalArtifactHash(root, authoringTools)) paths.push(authoringTools);
  const files = [];
  for (const path of paths) files.push({ path, hash: await hash(path) });
  return { files, hash: contentHash(stableJson(files)) };
}
async function verifyFrozen(frozen) {
  for (const file of frozen.files)
    if ((await hash(file.path)) !== file.hash)
      throw new Error(`Frozen input changed: ${file.path}`);
}

async function main() {
  const [action, id] = process.argv.slice(2);
  const suite = await json(suitePath);
  if (action === "init") {
    await assertRuntimeBuildCurrent();
    const frozen = await snapshot();
    const { stdout: commit } = await execFile("git", ["rev-parse", "HEAD"], { cwd: root });
    await write(`${output}/baseline.json`, {
      createdAt: new Date().toISOString(),
      commit: commit.trim(),
      frozen,
      suite,
      scope: suite.scope,
      timing:
        "Wall time starts before plan authoring and includes all reasoning, tool overhead, review and retries until the final decision. Tool phase durations use a monotonic clock. Setup is excluded; sequential same-context runs are not independent.",
      limitations: [
        "Agent API usage and complete tool traces are unavailable in this desktop run and are null, not zero.",
        "All briefs and reviews are authored by the same agent; no holdout or creator acceptance is claimed.",
        "Prepared catalog only; asset admission and Studio import are excluded.",
      ],
    });
    const plan = await json(".basalt/evals/harvest-valley/spatial-plan.json");
    await write(`${output}/reference-plan.json`, plan);
    console.log(
      JSON.stringify({ output, baselineHash: frozen.hash, cases: suite.cases.map((c) => c.id) }),
    );
    return;
  }
  const baseline = await json(`${output}/baseline.json`);
  if (action === "report") {
    const runs = [];
    for (const brief of baseline.suite.cases) {
      if ((await optionalArtifactHash(root, runPath(brief.id))) === undefined) {
        runs.push({ id: brief.id, status: "not_started" });
      } else {
        const run = await json(runPath(brief.id));
        const summary = summarizeRun(run, baseline.suite.targetSeconds);
        const lastCompile = run.events
          .filter((e) => e.action === "compile" && e.worldBuildHash)
          .at(-1);
        if (lastCompile) {
          const world = WORLD_BUILD_SCHEMA.parse(
            await json(`${output}/${brief.id}/attempts/${lastCompile.attempt}/world-build.json`),
          );
          if (world.worldBuildHash !== lastCompile.worldBuildHash)
            throw new Error("Reported world changed");
          summary.lastCompilerDiagnostics = worldBuildDiagnostics(world);
        }
        runs.push(summary);
      }
    }
    const report = {
      baselineHash: baseline.frozen.hash,
      scope: baseline.scope,
      targetSeconds: baseline.suite.targetSeconds,
      limitations: baseline.limitations,
      runs,
      creatorAcceptanceStatus: "incomplete",
      engineVerified: false,
    };
    const path = `${output}/report.json`;
    const previous = await optionalArtifactHash(root, path);
    await write(path, report, previous);
    const htmlPath = `${output}/index.html`;
    const htmlHash = await optionalArtifactHash(root, htmlPath);
    await writePrivateWorkspaceText(root, htmlPath, renderReport(report), {
      maxBytes: 8 * 1024 * 1024,
      ...(htmlHash === undefined ? {} : { expectedExistingHash: htmlHash }),
    });
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const brief = baseline.suite.cases.find((entry) => entry.id === id);
  if (!brief) throw new Error("Unknown predeclared brief");
  const folder = `${output}/${id}`;
  if (action === "start") {
    await verifyFrozen(baseline.frozen);
    await write(runPath(id), {
      id,
      brief,
      baselineHash: baseline.frozen.hash,
      startedAt: Date.now(),
      status: "running",
      events: [],
      reviews: [],
    });
    console.log(
      JSON.stringify({
        brief,
        folder,
        budgetSeconds: suite.targetSeconds,
        stopSeconds: suite.stopSeconds,
      }),
    );
    return;
  }
  const previous = await hash(runPath(id));
  const run = await json(runPath(id));
  if (run.status !== "running")
    throw new Error("Case is already finished; prior failures cannot be overwritten");
  const elapsed = () => (Date.now() - run.startedAt) / 1000;
  const started = performance.now();
  const event = { action, startedAt: Date.now(), ok: false };
  try {
    await verifyFrozen(baseline.frozen);
    if (action !== "review" && elapsed() >= suite.stopSeconds)
      throw new Error("Hard case budget exhausted");
    if (action === "compile") {
      const attempt = run.events.filter((entry) => entry.action === "compile").length + 1;
      if (attempt > suite.maximumAttempts) throw new Error("Compile attempt budget exhausted");
      const plan = await json(`${folder}/spatial-plan.json`);
      await write(`${folder}/attempts/${attempt}/spatial-plan.json`, plan);
      event.attempt = attempt;
      event.planBytesHash = await hash(`${folder}/spatial-plan.json`);
      const result = await execFile(
        process.execPath,
        [
          "bin/basalt.js",
          "world",
          "compile",
          `${folder}/attempts/${attempt}/spatial-plan.json`,
          "--catalog",
          "registry/catalog.json",
          "--output",
          `${folder}/attempts/${attempt}/world-build.json`,
        ],
        {
          cwd: root,
          timeout: Math.max(1, Math.min(180_000, (suite.stopSeconds - elapsed()) * 1000)),
          maxBuffer: 2 * 1024 * 1024,
        },
      );
      event.stdout = result.stdout;
      const world = WORLD_BUILD_SCHEMA.parse(
        await json(`${folder}/attempts/${attempt}/world-build.json`),
      );
      event.worldBuildHash = world.worldBuildHash;
      event.compilerStatus = world.status;
      event.instances = world.instances.length;
      event.models = new Set(world.instances.map((entry) => entry.assetHash)).size;
      event.diagnostics = worldBuildDiagnostics(world);
      event.ok =
        world.status === "eligible" &&
        event.instances >= suite.minimumInstances &&
        event.models >= suite.minimumModels;
      if (!event.ok) event.failure = "Compilation or predeclared population floor failed";
    } else if (action === "capture") {
      const compile = run.events.filter((entry) => entry.action === "compile").at(-1);
      if (!compile?.ok) throw new Error("Capture requires the latest compile to pass");
      event.attempt = compile.attempt;
      event.worldBuildHash = compile.worldBuildHash;
      const camerasPath = `${folder}/cameras.json`;
      const camerasHash = await optionalArtifactHash(root, camerasPath);
      const viewsPath = `${folder}/views.json`;
      const viewsHash = await optionalArtifactHash(root, viewsPath);
      let viewOptions = [];
      if (camerasHash !== undefined || viewsHash !== undefined) {
        const attemptViewsPath = `${folder}/attempts/${compile.attempt}/views.json`;
        await write(
          attemptViewsPath,
          camerasHash !== undefined
            ? {
                worldBuildHash: compile.worldBuildHash,
                cameras: await json(camerasPath),
              }
            : await json(viewsPath),
        );
        viewOptions = ["--views", attemptViewsPath];
        event.viewsBytesHash = await hash(attemptViewsPath);
      }
      const result = await execFile(
        process.execPath,
        [
          "scripts/preview-world.mjs",
          "--world",
          `${folder}/attempts/${compile.attempt}/world-build.json`,
          ...viewOptions,
          "--capture",
          `${folder}/attempts/${compile.attempt}/preview`,
        ],
        {
          cwd: root,
          timeout: Math.max(1, Math.min(180_000, (suite.stopSeconds - elapsed()) * 1000)),
          maxBuffer: 2 * 1024 * 1024,
        },
      );
      event.stdout = result.stdout;
      event.stderr = result.stderr;
      event.images = [];
      const receipt = await json(`${folder}/attempts/${compile.attempt}/preview/capture.json`);
      if (receipt.worldBuildHash !== compile.worldBuildHash)
        throw new Error("Captured world differs from the compile");
      event.cameras = receipt.cameras;
      for (const view of receipt.images) {
        const path = `${folder}/attempts/${compile.attempt}/preview/${view.file}`;
        if ((await hash(path)) !== view.hash) throw new Error("Capture image changed");
        event.images.push({ path, hash: await hash(path) });
      }
      event.ok = !result.stderr.trim();
      if (!event.ok) event.failure = "Preview reported browser errors";
    } else if (action === "review") {
      const review = await json(`${folder}/review.json`);
      const capture = run.events.filter((entry) => entry.action === "capture").at(-1);
      const latestCompile = run.events.filter((entry) => entry.action === "compile").at(-1);
      if (!latestCompile?.ok || latestCompile.worldBuildHash !== capture?.worldBuildHash)
        throw new Error("Review cannot use a superseded capture");
      validateReview(review, brief, capture);
      for (const image of capture.images)
        if ((await hash(image.path)) !== image.hash)
          throw new Error("Reviewed preview bytes changed");
      run.reviews.push({ ...review, elapsedSeconds: elapsed(), images: capture.images });
      event.ok = true;
      if (review.continue !== true || review.status === "eligible") {
        run.status = review.status;
        run.finishedAt = Date.now();
      }
    } else if (action === "finish") {
      run.status = "incomplete";
      run.finishedAt = Date.now();
      event.ok = true;
    } else
      throw new Error(
        "Usage: generation-benchmark.mjs init|start|compile|capture|review|finish|report [case]",
      );
    await verifyFrozen(baseline.frozen);
  } catch (error) {
    event.failure = String(error.message ?? error).slice(0, 4000);
    if (error.stdout) event.stdout = String(error.stdout).slice(0, 8000);
    if (/Frozen input|budget exhausted/.test(event.failure)) {
      run.status = "rejected";
      run.finishedAt = Date.now();
    }
  }
  event.seconds = (performance.now() - started) / 1000;
  event.elapsedSeconds = elapsed();
  run.events.push(event);
  await write(runPath(id), run, previous);
  console.log(JSON.stringify(event, null, 2));
  if (!event.ok) process.exitCode = 1;
}

export function renderReport(report) {
  const escape = (value) =>
    String(value).replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );
  const seconds = (n) => (n == null ? "—" : `${n.toFixed(1)}s`);
  const rows = report.runs
    .map((run) => {
      const events = run.events ?? [];
      const previews = events
        .filter((e) => e.action === "capture" && e.ok)
        .map(
          (e) =>
            `<details ${e === events.filter((x) => x.action === "capture" && x.ok).at(-1) ? "open" : ""}><summary>Attempt ${escape(e.attempt)} · captured at ${seconds(e.elapsedSeconds)}</summary><div class="images">${e.images
              .map((i) => {
                const path = i.path.startsWith(`${output}/`) ? i.path.slice(output.length + 1) : "";
                return `<a href="${escape(path)}"><img loading="lazy" src="${escape(path)}" alt="${escape(path)}"></a>`;
              })
              .join("")}</div></details>`,
        )
        .join("");
      return `<section><h2>${escape(run.id)} — ${escape(run.status)}</h2><p>First preview ${seconds(run.firstPreviewSeconds)} · ${run.attempts ?? 0} attempts · total ${seconds(run.totalElapsedSeconds)} · accepted within target: ${run.withinTarget === true}</p><p>${escape(run.review?.note ?? "No accepted visual review; inspect the retained compile events.")}</p><ul>${(run.review?.checks ?? []).map((c) => `<li><strong>${escape(c.verdict)}</strong>: ${escape(c.check)} — ${escape(c.note)}</li>`).join("")}</ul>${previews}<pre>${escape((run.lastCompilerDiagnostics ?? []).join("\n"))}</pre><details><summary>All recorded events, including failures</summary><pre>${escape(JSON.stringify(events, null, 2))}</pre></details></section>`;
    })
    .join("");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Basalt generation development pilot</title><style>body{font:16px system-ui;max-width:1400px;margin:40px auto;padding:0 24px;background:#171c21;color:#e1e7ed}section{border-top:1px solid #596574;padding:24px 0}.images{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}img{width:100%}summary{cursor:pointer;margin:12px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere}li{margin:8px 0}a{color:#a2d4ef}</style><h1>Regional generation development pilot</h1><p>Target: ${escape(report.targetSeconds)} seconds to an agent-accepted preview. ${escape(report.scope)}</p><ul>${report.limitations.map((l) => `<li>${escape(l)}</li>`).join("")}</ul><p>These results are not creator acceptance or engine verification. Post-pilot tooling changes do not alter the recorded outcomes.</p>${rows}</html>`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
