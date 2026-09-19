// Explicit live operator run. Offline tests never invoke the model transport.
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { lstat, readdir } from "node:fs/promises";
import {
  readBoundedWorkspaceBytes,
  writeCanonicalWorkspaceJson,
  writePrivateWorkspaceText,
} from "@basalt/artifact-store";
import { contentHash, stableJson } from "@basalt/contracts";
const execFile = promisify(execFileCallback),
  root = process.cwd();
const outputIndex = process.argv.indexOf("--output");
const output = outputIndex < 0 ? ".basalt/evals/prompt-region" : process.argv[outputIndex + 1];
if (!output || output.startsWith("--")) throw new Error("Missing pilot output directory");
const read = async (path) =>
  JSON.parse(
    Buffer.from(await readBoundedWorkspaceBytes(root, path, 128 * 1024 * 1024)).toString(),
  );
const write = (path, value) =>
  writeCanonicalWorkspaceJson(root, path, value, { maxBytes: 128 * 1024 * 1024 });
const readOptional = async (path) => {
  try {
    await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
  return read(path);
};
const suite = await read("test/fixtures/prompt-region-briefs.json");
const reasoningIndex = process.argv.indexOf("--reasoning-effort");
const reasoningEffort =
  reasoningIndex < 0 ? suite.reasoningEffort : process.argv[reasoningIndex + 1];
if (!["none", "low", "high"].includes(reasoningEffort))
  throw new Error("Invalid --reasoning-effort");
const action = process.argv[2];
if (action === "report") {
  const cases = [];
  for (const brief of suite.cases) {
    const report = await readOptional(`${output}/${brief.id}/report.json`);
    const baseline = await readOptional(`${output}/${brief.id}/baseline.json`);
    if (!report && !baseline) continue;
    const runs = [];
    for (const phase of ["generated", "edited"]) {
      const run = await readOptional(`${output}/${brief.id}/${phase}/report.json`);
      if (run) runs.push({ phase, ...run });
      else {
        const path = `${output}/${brief.id}/${phase}`;
        const request = await readOptional(`${path}/request.json`);
        if (!request) continue;
        let directories = [];
        try {
          directories = await readdir(`${path}/attempts`);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        const attempts = [];
        let modelCalls = 0;
        for (const directory of directories.sort((a, b) => Number(a) - Number(b))) {
          if (!/^\d+$/u.test(directory)) continue;
          const event = await readOptional(`${path}/attempts/${directory}/event.json`);
          attempts.push(
            event ?? {
              attempt: Number(directory),
              failure: "Interrupted before a completed attempt; unscored",
            },
          );
          for (const call of ["proposal", "review"])
            if (await readOptional(`${path}/attempts/${directory}/${call}-request.json`))
              modelCalls++;
        }
        runs.push({
          phase,
          status: "incomplete",
          elapsedSeconds: Math.max(0, ...attempts.map((a) => a.finishedSeconds ?? 0)),
          modelCalls,
          attempts,
          interrupted: true,
        });
      }
    }
    cases.push({
      ...(report ?? {
        ...baseline.brief,
        sourceHash: baseline.sourceHash,
        elapsedSeconds: runs.reduce((total, run) => total + run.elapsedSeconds, 0),
        failure: "Operator stopped the run; elapsed time includes completed attempts only",
      }),
      runs,
    });
  }
  const report = {
    scope: suite.scope,
    model: suite.model,
    cases,
    independentReview: false,
    creatorAccepted: false,
    engineVerified: false,
  };
  const replace = async (path, value, text = false) => {
    let previous;
    try {
      await lstat(path);
      previous = contentHash(
        Buffer.from(await readBoundedWorkspaceBytes(root, path, 128 * 1024 * 1024)).toString(),
      );
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    return (text ? writePrivateWorkspaceText : writeCanonicalWorkspaceJson)(root, path, value, {
      maxBytes: 128 * 1024 * 1024,
      ...(previous ? { expectedExistingHash: previous } : {}),
    });
  };
  await replace(`${output}/report.json`, report);
  const escape = (v) =>
    String(v).replace(
      /[&<>"']/gu,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );
  const html = `<!doctype html><meta charset="utf-8"><title>Basalt prompt and edit pilot</title><style>body{font:16px system-ui;max-width:1500px;margin:40px auto;padding:0 24px;background:#151d21;color:#edf1e9}section{border-top:1px solid #617376;padding:24px 0}img{width:100%}.images{display:grid;grid-template-columns:repeat(2,1fr);gap:16px}a{color:#aedbc7}pre{white-space:pre-wrap}</style><h1>Prompt → region → requested edit</h1><p>${escape(suite.scope)}</p><p>All attempts are retained. Model review does not establish creator acceptance or engine verification.</p>${cases.map((c) => `<section><h2>${escape(c.id)}</h2><p>${escape(c.prompt)}</p><p>Edit: ${escape(c.edit)}</p><p>Total ${c.elapsedSeconds.toFixed(1)}s · source ${escape(c.sourceHash.slice(0, 12))}</p>${c.failure ? `<pre>${escape(c.failure)}</pre>` : ""}${c.runs.map((r) => `<h3>${r.phase} · ${escape(r.status)} · ${r.elapsedSeconds.toFixed(1)}s · ${r.modelCalls} model calls</h3>${r.attempts.map((a) => `<details open><summary>Attempt ${a.attempt}: ${escape(a.failure ?? a.visualStatus ?? a.compilerStatus ?? "incomplete")}</summary><div class="images">${(a.capture?.images ?? []).map((i) => `<a href="${c.id}/${r.phase}/attempts/${a.attempt}/preview/${i.file}"><img src="${c.id}/${r.phase}/attempts/${a.attempt}/preview/${i.file}" alt="${escape(i.file)}"></a>`).join("")}</div></details>`).join("")}`).join("")}</section>`).join("")}`;
  await replace(`${output}/index.html`, html, true);
  console.log(
    JSON.stringify({
      output,
      cases: cases.map((c) => ({
        id: c.id,
        elapsedSeconds: c.elapsedSeconds,
        runs: c.runs.map((r) => ({
          phase: r.phase,
          status: r.status,
          elapsedSeconds: r.elapsedSeconds,
          modelCalls: r.modelCalls,
        })),
      })),
    }),
  );
} else {
  const brief = suite.cases.find((c) => c.id === action);
  if (!brief) throw new Error("Supply a predeclared case ID or report");
  const folder = `${output}/${brief.id}`;
  try {
    await lstat(folder);
    throw new Error("Case output already exists");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const { stdout } = await execFile("git", [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
    "packages",
    "scripts",
    "registry/semantics",
    "registry/world-authoring",
    "package.json",
    "package-lock.json",
  ]);
  const files = [];
  for (const path of [
    ...new Set([
      ...stdout.split("\0").filter(Boolean),
      "registry/catalog.json",
      "test/fixtures/prompt-region-briefs.json",
    ]),
  ].sort()) {
    const bytes = Buffer.from(await readBoundedWorkspaceBytes(root, path, 128 * 1024 * 1024));
    const hash = contentHash(bytes.toString());
    files.push({ path, hash });
    await writePrivateWorkspaceText(root, `${folder}/source/${path}`, bytes.toString(), {
      maxBytes: 128 * 1024 * 1024,
    });
  }
  const sourceHash = contentHash(stableJson(files));
  await write(`${folder}/baseline.json`, { sourceHash, files, brief, suite, reasoningEffort });
  const started = Date.now();
  let failure = null;
  try {
    const generated = await execFile(
      process.execPath,
      [
        "bin/basalt.js",
        "world",
        "generate",
        brief.prompt,
        "--model",
        suite.model,
        "--reasoning-effort",
        reasoningEffort,
        "--budget-seconds",
        String(suite.generationBudgetSeconds),
        "--output",
        `${folder}/generated`,
      ],
      { timeout: (suite.generationBudgetSeconds + 60) * 1000, maxBuffer: 4 * 1024 * 1024 },
    );
    await write(`${folder}/generate-command.json`, generated);
    const world = await readOptional(`${folder}/generated/world-build.json`);
    if (world?.status !== "eligible") throw new Error("No geometrically eligible world to edit");
    const edited = await execFile(
      process.execPath,
      [
        "bin/basalt.js",
        "world",
        "edit",
        brief.edit,
        "--from",
        `${folder}/generated`,
        "--model",
        suite.model,
        "--reasoning-effort",
        reasoningEffort,
        "--budget-seconds",
        String(suite.editBudgetSeconds),
        "--output",
        `${folder}/edited`,
      ],
      { timeout: (suite.editBudgetSeconds + 60) * 1000, maxBuffer: 4 * 1024 * 1024 },
    );
    await write(`${folder}/edit-command.json`, edited);
  } catch (error) {
    failure = String(error.message ?? error).slice(0, 8000);
    if (error.stdout || error.stderr)
      await write(`${folder}/failed-command.json`, {
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? "",
        failure,
      });
  }
  const changed = [];
  for (const file of files)
    if (
      contentHash(
        Buffer.from(await readBoundedWorkspaceBytes(root, file.path, 128 * 1024 * 1024)).toString(),
      ) !== file.hash
    )
      changed.push(file.path);
  const report = {
    id: brief.id,
    prompt: brief.prompt,
    edit: brief.edit,
    sourceHash,
    reasoningEffort,
    elapsedSeconds: (Date.now() - started) / 1000,
    failure,
    changedSources: changed,
    independentReview: false,
    engineVerified: false,
  };
  await write(`${folder}/report.json`, report);
  console.log(JSON.stringify(report));
}
