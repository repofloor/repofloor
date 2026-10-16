/**
 * Entry point for the GitHub Action. Reads inputs from env (as actions do), writes
 * office-state.json next to the static office page in the output directory.
 */
import { mkdir, writeFile, readFile, cp } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { collectWithEvents } from "@repofloor/collect";

function input(name: string, fallback?: string): string {
  const v = process.env[`INPUT_${name.toUpperCase().replace(/-/g, "_")}`] ?? fallback;
  if (v === undefined) throw new Error(`Missing input: ${name}`);
  return v;
}

/**
 * The bundled page is the demo build, so its <title> says "Repofloor Demo".
 * Every published office belongs to one repository — name it, for the browser tab
 * and for link previews, which never run the page's JavaScript.
 */
async function retitle(indexPath: string, repoFull: string): Promise<void> {
  const html = await readFile(indexPath, "utf8");
  await writeFile(indexPath, html.replace(/<title>[^<]*<\/title>/, `<title>${repoFull} · Repofloor office</title>`));
}

async function main() {
  const repoFull = input("repository", process.env["GITHUB_REPOSITORY"]);
  const [owner, repo] = repoFull.split("/");
  if (!owner || !repo) throw new Error(`Bad repository: ${repoFull}`);
  const token = input("token", process.env["GITHUB_TOKEN"]);
  const hours = Number(input("hours", "48"));
  const outDir = input("output-dir", "repofloor-site");

  const { state, events } = await collectWithEvents({ owner, repo, token, hours });

  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "office-state.json"), JSON.stringify(state, null, 2));

  // The events that produced the snapshot, so the page can show the office at any
  // moment inside the look-back window rather than only at the end of it (ADR 0003).
  //
  // Written as its own file rather than folded into the snapshot: a page that only
  // wants "now" should not download the history to get it, and office-state.json is
  // already the contract every existing Lite page fetches.
  await writeFile(
    join(outDir, "office-events.json"),
    JSON.stringify({ officeId: state.office.id, hours, generatedAt: state.generatedAt, events }, null, 2),
  );

  // Copy the prebuilt static office page (dist/site) next to the json.
  //
  // This used to warn and carry on. That is the wrong failure: the step stays green,
  // Pages publishes a directory with no index.html, and the first anyone knows is a
  // 404 on their own office. Nothing in the run says why. A missing bundle means the
  // action was published wrong, which is ours to fix and theirs to be told about
  // immediately — so it throws.
  const here = dirname(fileURLToPath(import.meta.url));
  const site = join(here, "site");
  try {
    await cp(site, outDir, { recursive: true });
  } catch (err) {
    throw new Error(
      `repofloor: the static office page is missing from this action (looked in ${site}). ` +
        `The snapshot was built, but publishing ${outDir} would give you a page that 404s. ` +
        `This is a packaging fault in the action, not something wrong with your repository — ` +
        `please open an issue at https://github.com/repofloor/repofloor/issues. ` +
        `Cause: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  await retitle(join(outDir, "index.html"), repoFull);

  const online = state.actors.filter((a) => a.status !== "offline").length;
  console.log(`repofloor: ${state.actors.length} actors (${online} active), ${state.pullRequests.length} open PRs, ${events.length} events over ${hours}h, CI=${state.defaultBranchCi ?? "n/a"} → ${outDir}/`);

  if (process.env["GITHUB_OUTPUT"]) {
    await writeFile(process.env["GITHUB_OUTPUT"], `output-dir=${outDir}\nactors=${state.actors.length}\n`, { flag: "a" });
  }
  if (process.env["GITHUB_STEP_SUMMARY"]) {
    const md = [
      `### 🏢 Repofloor snapshot for \`${repoFull}\``,
      "",
      `| | |`,
      `|---|---|`,
      `| Actors | ${state.actors.length} (${online} active) |`,
      `| Open PRs | ${state.pullRequests.length} |`,
      `| Open issues | ${state.issues.length} |`,
      `| CI (${state.office.defaultBranch}) | ${state.defaultBranchCi ?? "n/a"} |`,
      "",
    ].join("\n");
    await writeFile(process.env["GITHUB_STEP_SUMMARY"], md, { flag: "a" });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
