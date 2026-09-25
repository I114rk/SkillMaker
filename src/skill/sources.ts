import fs from "node:fs";
import path from "node:path";

/** Files that carry no signal for skill authoring, or are simply too heavy. */
const SKIP_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  ".next",
  "coverage",
  ".idea",
  ".vscode",
]);

/** Extensions we are willing to read as text. */
const TEXT_EXTENSIONS = new Set([
  ".md", ".mdx", ".txt", ".rst", ".adoc",
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".jsonc",
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".kts", ".scala",
  ".c", ".h", ".cpp", ".hpp", ".cc", ".cs", ".swift", ".php",
  ".sh", ".bash", ".zsh", ".fish", ".ps1",
  ".yml", ".yaml", ".toml", ".ini", ".cfg", ".conf", ".env.example",
  ".sql", ".graphql", ".proto", ".tf", ".hcl",
  ".html", ".css", ".scss", ".sass", ".less", ".vue", ".svelte",
  ".xml", ".csv", ".tsv", ".lua", ".r", ".jl", ".ex", ".exs",
]);

/** A single file larger than this is unlikely to be worth the context. */
const MAX_FILE_BYTES = 256 * 1024;
/** Total budget for everything the model may read from a source tree. */
export const DEFAULT_SOURCE_BUDGET_BYTES = 4 * 1024 * 1024;
/** Files offered to the model in the listing, sorted by likely usefulness. */
const MAX_LISTED_FILES = 400;

export interface SourceFile {
  /** Path relative to the source root, always POSIX-separated. */
  path: string;
  bytes: number;
}

export interface SourceTree {
  root: string;
  files: SourceFile[];
  /** Total bytes available within budget. */
  bytes: number;
  skipped: number;
}

function isProbablyText(file: string, sample: Buffer): boolean {
  const ext = path.extname(file).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return true;
  if (ext === "") {
    // Extensionless files (Makefile, Dockerfile, LICENSE): decide by content.
    return !sample.includes(0);
  }
  return false;
}

function rank(file: SourceFile): number {
  const name = path.basename(file.path).toLowerCase();
  const ext = path.extname(file.path).toLowerCase();
  const depth = file.path.split("/").length;

  let score = 0;
  if (name === "readme.md" || name === "readme") score -= 100;
  if (name.startsWith("readme")) score -= 60;
  if (name === "skill.md") score -= 90;
  if (name === "index.md") score -= 40;
  if (name === "package.json" || name === "pyproject.toml") score -= 30;
  if ([".md", ".mdx", ".rst", ".txt"].includes(ext)) score -= 20;
  score += depth * 5;
  score += Math.min(file.bytes / 4096, 30);
  return score;
}

/**
 * Walk a source directory and describe the text files inside it.
 *
 * The tree is not read into the prompt wholesale - a large repository would
 * exhaust the context window long before the model wrote anything. Instead the
 * model gets this listing (capped, ranked so the files most likely to matter
 * come first) and pulls individual files in via `read_source_file`.
 */
export function scanSourceTree(root: string, budgetBytes = DEFAULT_SOURCE_BUDGET_BYTES): SourceTree {
  const absoluteRoot = path.resolve(root);
  if (!fs.existsSync(absoluteRoot)) {
    throw new Error(`source directory does not exist: ${absoluteRoot}`);
  }
  if (!fs.statSync(absoluteRoot).isDirectory()) {
    throw new Error(`source path is not a directory: ${absoluteRoot}`);
  }

  const files: SourceFile[] = [];
  let bytes = 0;
  let skipped = 0;

  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      skipped++;
      return;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) {
          skipped++;
          continue;
        }
        walk(full);
        continue;
      }
      if (!entry.isFile()) {
        // Symlinks and sockets are not worth following here.
        skipped++;
        continue;
      }

      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        skipped++;
        continue;
      }
      if (stat.size === 0 || stat.size > MAX_FILE_BYTES) {
        skipped++;
        continue;
      }

      let head: Buffer;
      try {
        const fd = fs.openSync(full, "r");
        head = Buffer.alloc(Math.min(1024, stat.size));
        fs.readSync(fd, head, 0, head.length, 0);
        fs.closeSync(fd);
      } catch {
        skipped++;
        continue;
      }

      if (!isProbablyText(full, head)) {
        skipped++;
        continue;
      }
      if (bytes + stat.size > budgetBytes) {
        skipped++;
        continue;
      }

      bytes += stat.size;
      files.push({
        path: path.relative(absoluteRoot, full).split(path.sep).join("/"),
        bytes: stat.size,
      });
    }
  };

  walk(absoluteRoot);

  files.sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path));

  return {
    root: absoluteRoot,
    files: files.slice(0, MAX_LISTED_FILES),
    bytes,
    skipped,
  };
}

/** Render the listing the model sees, with sizes so it can budget its reads. */
export function renderSourceListing(tree: SourceTree): string {
  if (tree.files.length === 0) {
    return "The source directory contains no readable text files.";
  }
  const lines = tree.files.map((f) => `${f.path} (${f.bytes} bytes)`);
  const note =
    tree.skipped > 0
      ? `\n\n${tree.skipped} file(s) skipped (binary, empty, oversized, or over budget).`
      : "";
  return `${lines.length} file(s):\n${lines.join("\n")}${note}`;
}

/**
 * Read one file from the tree.
 *
 * The path is model-supplied, so it is resolved against the tree root and
 * anything escaping it is refused - and only files the scan already accepted
 * may be read, which keeps the model from reaching into a skipped binary.
 */
export function readSourceFile(tree: SourceTree, relative: string): string {
  const normalized = relative.replace(/^\.\//, "").split(path.sep).join("/");
  const known = tree.files.find((f) => f.path === normalized);
  if (!known) {
    const candidates = tree.files
      .filter((f) => f.path.includes(normalized))
      .slice(0, 10)
      .map((f) => f.path);
    throw new Error(
      candidates.length > 0
        ? `no exact match for "${relative}". Did you mean: ${candidates.join(", ")}?`
        : `no such readable file: ${relative}`,
    );
  }

  const full = path.join(tree.root, normalized);
  const resolved = path.resolve(full);
  if (!resolved.startsWith(tree.root + path.sep)) {
    throw new Error(`path escapes the source directory: ${relative}`);
  }

  return fs.readFileSync(resolved, "utf8");
}
