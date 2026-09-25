import fs from "node:fs";
import path from "node:path";

import type { LoopTool } from "../llm/loop.js";
import { assertRealPathInside, resolveInside } from "../util/paths.js";

/** Files above this size are not worth putting in the conversation. */
const MAX_READ_BYTES = 128 * 1024;

export interface ChatToolsOptions {
  /** Directory the tools may read and write. */
  root: string;
  onNote?: (message: string) => void;
}

function listDirectory(root: string, relative: string): string {
  const dir = relative.trim() === "" ? root : resolveInside(root, relative);
  if (!fs.existsSync(dir)) {
    throw new Error(`no such directory: ${relative}`);
  }
  if (!fs.statSync(dir).isDirectory()) {
    throw new Error(`not a directory: ${relative}`);
  }

  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => !e.name.startsWith(".git"))
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .sort();

  return entries.length > 0 ? entries.join("\n") : "(empty directory)";
}

function readFile(root: string, relative: string): string {
  const target = resolveInside(root, relative);
  const stat = fs.statSync(target, { throwIfNoEntry: false });
  if (!stat) throw new Error(`no such file: ${relative}`);
  if (stat.isDirectory()) throw new Error(`that is a directory, not a file: ${relative}`);
  if (stat.size > MAX_READ_BYTES) {
    throw new Error(
      `file is too large to read (${stat.size} bytes, limit ${MAX_READ_BYTES})`,
    );
  }
  return fs.readFileSync(target, "utf8");
}

function writeFile(root: string, relative: string, content: string): string {
  const target = resolveInside(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  assertRealPathInside(root, target);
  fs.writeFileSync(target, content, "utf8");
  return `wrote ${relative} (${content.length} chars)`;
}

/**
 * The file tools offered in chat.
 *
 * Paths come from the model and are therefore untrusted: every one goes through
 * `resolveInside`, and writes are re-checked against symlinks before touching
 * the filesystem.
 */
export function createChatTools(options: ChatToolsOptions): LoopTool[] {
  const root = path.resolve(options.root);

  return [
    {
      name: "list_files",
      description:
        "List the entries in a directory. Use \".\" for the current directory.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path relative to the working root." },
        },
      },
      run: (input) => {
        const relative = String(input.path ?? ".");
        options.onNote?.(`list ${relative}`);
        return listDirectory(root, relative === "." ? "" : relative);
      },
    },
    {
      name: "read_file",
      description: "Read a UTF-8 text file from the working root.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to the working root." },
        },
        required: ["path"],
      },
      run: (input) => {
        const relative = String(input.path ?? "");
        options.onNote?.(`read ${relative}`);
        return readFile(root, relative);
      },
    },
    {
      name: "write_file",
      description:
        "Write a UTF-8 text file, creating parent directories as needed. Overwrites an existing file.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to the working root." },
          content: { type: "string", description: "Full file content." },
        },
        required: ["path", "content"],
      },
      run: (input) => {
        const relative = String(input.path ?? "");
        const content = String(input.content ?? "");
        options.onNote?.(`write ${relative}`);
        return writeFile(root, relative, content);
      },
    },
  ];
}
