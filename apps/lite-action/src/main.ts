/**
 * Entry point for the GitHub Action. Reads inputs from env (as actions do), writes
 * office-state.json next to the static office page in the output directory.
 */
import { mkdir, writeFile, readFile, cp } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { collect } from "@repofloor/collect";

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

  const state = await collect({ owner, repo, token, hours });

  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "office-state.json"), JSON.stringify(state, null, 2));

  // copy the prebuilt static office page (dist/site) next to the json
  const here = dirname(fileURLToPath(import.meta.url));
  const site = join(here, "site");
  try {
    await cp(site, outDir, { recursive: true });
    await retitle(join(outDir, "index.html"), repoFull);
  } catch {
    console.warn("repofloor: static site bundle not found at", site, "- only office-state.json written");
  }

  const online = state.actors.filter((a) => a.status !== "offline").length;
  console.log(`repofloor: ${state.actors.length} actors (${online} active), ${state.pullRequests.length} open PRs, CI=${state.defaultBranchCi ?? "n/a"} → ${outDir}/`);

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
