/**
 * Collector: git state → ops/data/git.json
 *
 * Truthfulness contract: every field is derived from `git` output on this machine.
 * If the repo is not a git repo yet, we still emit a valid document with `branch: "UNKNOWN"`
 * and empty arrays — we never fabricate commit data.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const run = promisify(execFile);
const REPO_ROOT = resolve(new URL("../..", import.meta.url).pathname);
const OUT = resolve(REPO_ROOT, "ops/data/git.json");

type Commit = { hash: string; subject: string; author: string; date: string };
type ChangedFile = { status: string; path: string };
type GitDoc = {
  schema_version: "1.0.0";
  generated_at: string;
  is_git_repo: boolean;
  branch: string;
  head: string | null;
  status_counts: { staged: number; unstaged: number; untracked: number };
  changed_files: ChangedFile[];
  recent_commits: Commit[];
};

async function safeGit(args: string[]): Promise<{ stdout: string; ok: boolean }> {
  try {
    const { stdout } = await run("git", args, { cwd: REPO_ROOT, maxBuffer: 1024 * 1024 * 4 });
    return { stdout, ok: true };
  } catch {
    return { stdout: "", ok: false };
  }
}

async function isGitRepo(): Promise<boolean> {
  const r = await safeGit(["rev-parse", "--is-inside-work-tree"]);
  return r.ok && r.stdout.trim() === "true";
}

async function currentBranch(): Promise<string> {
  const r = await safeGit(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!r.ok) return "UNKNOWN";
  const b = r.stdout.trim();
  return b.length ? b : "UNKNOWN";
}

async function head(): Promise<string | null> {
  const r = await safeGit(["rev-parse", "HEAD"]);
  return r.ok ? r.stdout.trim() || null : null;
}

async function statusPorcelain(): Promise<{ counts: GitDoc["status_counts"]; files: ChangedFile[] }> {
  const r = await safeGit(["status", "--porcelain=v1", "--untracked-files=normal"]);
  const counts = { staged: 0, unstaged: 0, untracked: 0 };
  const files: ChangedFile[] = [];
  if (!r.ok) return { counts, files };
  for (const raw of r.stdout.split("\n")) {
    if (!raw.trim()) continue;
    // porcelain v1: XY path (two-char prefix then space then path)
    const x = raw[0] ?? " ";
    const y = raw[1] ?? " ";
    const path = raw.slice(3);
    if (x === "?" && y === "?") counts.untracked++;
    else {
      if (x !== " ") counts.staged++;
      if (y !== " ") counts.unstaged++;
    }
    const status = x === "?" ? "??" : `${x}${y}`.trim() || "??";
    files.push({ status, path });
  }
  return { counts, files };
}

async function recentCommits(limit = 20): Promise<Commit[]> {
  const sep = "\x1f";
  const end = "\x1e";
  const r = await safeGit([
    "log",
    `-n${limit}`,
    `--pretty=format:%H${sep}%s${sep}%an${sep}%aI${end}`,
  ]);
  if (!r.ok) return [];
  const out: Commit[] = [];
  for (const chunk of r.stdout.split(end)) {
    const line = chunk.trim();
    if (!line) continue;
    const [hash, subject, author, date] = line.split(sep);
    if (!hash) continue;
    out.push({ hash, subject: subject ?? "", author: author ?? "", date: date ?? "" });
  }
  return out;
}

async function main() {
  const inRepo = await isGitRepo();

  const doc: GitDoc = {
    schema_version: "1.0.0",
    generated_at: new Date().toISOString(),
    is_git_repo: inRepo,
    branch: inRepo ? await currentBranch() : "UNKNOWN",
    head: inRepo ? await head() : null,
    status_counts: inRepo
      ? (await statusPorcelain()).counts
      : { staged: 0, unstaged: 0, untracked: 0 },
    changed_files: inRepo ? (await statusPorcelain()).files : [],
    recent_commits: inRepo ? await recentCommits(20) : [],
  };

  // Re-run statusPorcelain once — the pattern above would call it twice, so consolidate:
  if (inRepo) {
    const s = await statusPorcelain();
    doc.status_counts = s.counts;
    doc.changed_files = s.files;
  }

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(doc, null, 2) + "\n", "utf8");
  // eslint-disable-next-line no-console
  console.log(`[collect:git] wrote ${OUT}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[collect:git] failed:", err);
  process.exit(1);
});
