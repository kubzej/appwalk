import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Project-provided run inputs that the agent may upload to the target application. */
export const DEFAULT_UPLOAD_INPUT_ROOT = resolve(PACKAGE_ROOT, "agent-inputs", "uploads");
export const DEFAULT_UPLOAD_INPUT_BASE = PACKAGE_ROOT;
const MAX_UPLOAD_FILES = 10;

export interface UploadInputPolicyOptions {
  /** Root containing approved upload inputs. Defaults to `<package>/agent-inputs/uploads`. */
  root?: string;
  /** Directory against which the agent-supplied relative paths are resolved. */
  baseDir?: string;
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function assertNoSymlink(path: string, baseDir: string): void {
  const relativePath = relative(baseDir, path);
  let current = baseDir;
  for (const part of relativePath.split(sep).filter(Boolean)) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error("uploadFile: symbolic links are not allowed in agent input paths.");
    }
  }
}

export class UploadInputPolicy {
  readonly root: string;
  readonly baseDir: string;

  constructor(options: UploadInputPolicyOptions = {}) {
    this.root = resolve(options.root ?? DEFAULT_UPLOAD_INPUT_ROOT);
    this.baseDir = resolve(options.baseDir ?? DEFAULT_UPLOAD_INPUT_BASE);
  }

  resolvePaths(filePaths: readonly unknown[]): string[] {
    if (!Array.isArray(filePaths) || filePaths.length === 0) {
      throw new Error("uploadFile: filePaths must contain at least one approved agent input path.");
    }
    if (filePaths.length > MAX_UPLOAD_FILES) {
      throw new Error(`uploadFile: no more than ${MAX_UPLOAD_FILES} agent input files may be uploaded at once.`);
    }

    let realRoot: string;
    try {
      realRoot = realpathSync(this.root);
    } catch {
      throw new Error(`uploadFile: approved upload input directory is missing: ${relative(this.baseDir, this.root)}`);
    }

    return filePaths.map((filePath, index) => {
      if (typeof filePath !== "string" || filePath.trim().length === 0) {
        throw new Error(`uploadFile: filePaths[${index}] must be a non-empty relative agent input path.`);
      }
      const relativePath = filePath.trim();
      if (relativePath.includes("\0") || isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes("..")) {
        throw new Error(`uploadFile: filePaths[${index}] must be a relative path without traversal and inside the upload input directory.`);
      }

      const candidate = resolve(this.baseDir, relativePath);
      if (!isInside(this.root, candidate)) {
        throw new Error(`uploadFile: filePaths[${index}] must be inside ${relative(this.baseDir, this.root)}.`);
      }
      try {
        assertNoSymlink(candidate, this.baseDir);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("uploadFile:")) throw error;
        throw new Error(`uploadFile: agent input path does not exist: ${relative(this.baseDir, candidate)}`);
      }

      let realCandidate: string;
      try {
        realCandidate = realpathSync(candidate);
      } catch {
        throw new Error(`uploadFile: agent input path does not exist: ${relative(this.baseDir, candidate)}`);
      }
      if (!isInside(realRoot, realCandidate)) {
        throw new Error(`uploadFile: agent input path resolves outside the upload input directory.`);
      }

      let stat;
      try {
        stat = lstatSync(candidate);
      } catch {
        throw new Error(`uploadFile: agent input path does not exist: ${relative(this.baseDir, candidate)}`);
      }
      if (!stat.isFile()) {
        throw new Error(`uploadFile: agent input path is not a regular file: ${relative(this.baseDir, candidate)}`);
      }
      return realCandidate;
    });
  }
}

export const defaultUploadInputPolicy = new UploadInputPolicy();
