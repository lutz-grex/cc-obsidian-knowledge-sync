import * as fs from "node:fs/promises";
import * as path from "node:path";
import { existsSync, realpathSync } from "node:fs";
import type { ResolvedConfig } from "./config.js";

const MAX_TREE_DEPTH = 50;

export class Vault {
  readonly root: string;
  private readonly realRoot: string;
  readonly config: ResolvedConfig;
  /** Monotonically increasing counter; bumped on every write/delete. Used by vault-index cache. */
  writeGeneration = 0;

  constructor(config: ResolvedConfig) {
    this.root = config.vaultPath;
    this.realRoot = realpathSync(config.vaultPath);
    this.config = config;
  }

  /** Resolve a relative path to absolute, ensuring it stays within the vault.
   *  Rejects symlinks that escape the vault boundary. */
  resolve(relativePath: string): string {
    const resolved = path.resolve(this.root, relativePath);
    if (!resolved.startsWith(this.root + path.sep) && resolved !== this.root) {
      throw new Error(`Path traversal denied: ${relativePath}`);
    }
    // Verify the nearest existing ancestor resolves within the vault.
    // realpathSync resolves all symlinks in the chain, so one check suffices.
    let checkPath = resolved;
    while (checkPath !== this.root && checkPath !== path.dirname(checkPath)) {
      if (existsSync(checkPath)) {
        const real = realpathSync(checkPath);
        if (!real.startsWith(this.realRoot + path.sep) && real !== this.realRoot) {
          throw new Error(`Symlink escapes vault boundary: ${relativePath}`);
        }
        break;
      }
      checkPath = path.dirname(checkPath);
    }
    return resolved;
  }

  /** Get a path relative to vault root. */
  relative(absolutePath: string): string {
    return path.relative(this.root, absolutePath);
  }

  /** Check if a file exists in the vault. */
  async exists(relativePath: string): Promise<boolean> {
    const abs = this.resolve(relativePath);
    return existsSync(abs);
  }

  /** Read a file from the vault. */
  async readFile(relativePath: string): Promise<string> {
    const abs = this.resolve(relativePath);
    return fs.readFile(abs, "utf-8");
  }

  /** Write a file to the vault, creating parent directories. */
  async writeFile(relativePath: string, content: string): Promise<string> {
    const abs = this.resolve(relativePath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf-8");
    this.writeGeneration++;
    return abs;
  }

  /** Delete a file (soft-delete to trash or hard delete). */
  async deleteFile(relativePath: string, trash: boolean): Promise<void> {
    const abs = this.resolve(relativePath);
    if (trash) {
      const trashPath = this.resolve(
        path.join(this.config.trashFolder, relativePath)
      );
      await fs.mkdir(path.dirname(trashPath), { recursive: true });
      await fs.rename(abs, trashPath);
    } else {
      await fs.unlink(abs);
    }
    this.writeGeneration++;
  }

  /** Move/rename a file within the vault. */
  async moveFile(oldRelPath: string, newRelPath: string): Promise<void> {
    const oldAbs = this.resolve(oldRelPath);
    const newAbs = this.resolve(newRelPath);
    await fs.mkdir(path.dirname(newAbs), { recursive: true });
    await fs.rename(oldAbs, newAbs);
    this.writeGeneration++;
  }

  /** Recursively list all markdown files with no cap. Use for full-vault operations. */
  async listAllMarkdownFiles(
    folder: string = "",
    recursive: boolean = true
  ): Promise<Array<{ path: string; size: number; mtime: Date }>> {
    return this.listMarkdownFiles(folder, recursive, Infinity);
  }

  /** Recursively list markdown files, excluding configured folders. */
  async listMarkdownFiles(
    folder: string = "",
    recursive: boolean = true,
    limit: number = 500
  ): Promise<Array<{ path: string; size: number; mtime: Date }>> {
    const results: Array<{ path: string; size: number; mtime: Date }> = [];
    const startDir = this.resolve(folder);

    const walk = async (dir: string): Promise<void> => {
      if (results.length >= limit) return;

      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (err: unknown) {
        const code = (err as { code?: string }).code;
        if (code !== "ENOENT") {
          process.stderr.write(`[vault] readdir skipped ${dir}: ${code ?? err}\n`);
        }
        return;
      }

      const mdFiles: { fullPath: string; relPath: string }[] = [];
      for (const entry of entries) {
        if (results.length + mdFiles.length >= limit) break;
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          if (this.config.excludeFolders.includes(entry.name)) continue;
          if (recursive) await walk(fullPath);
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
          mdFiles.push({ fullPath, relPath: this.relative(fullPath) });
        }
      }

      // Batch stat calls for all markdown files in this directory
      const STAT_BATCH = 50;
      for (let s = 0; s < mdFiles.length; s += STAT_BATCH) {
        if (results.length >= limit) break;
        const batch = mdFiles.slice(s, s + STAT_BATCH);
        const stats = await Promise.all(batch.map((f) => fs.stat(f.fullPath)));
        for (let j = 0; j < batch.length && results.length < limit; j++) {
          results.push({ path: batch[j].relPath, size: stats[j].size, mtime: stats[j].mtime });
        }
      }
    };

    await walk(startDir);
    results.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    return results.slice(0, limit);
  }

  /** Get directory tree as indented text. */
  async getTree(folder: string = "", depth: number = 3): Promise<string> {
    const effectiveDepth = Math.min(depth, MAX_TREE_DEPTH);
    const lines: string[] = [];
    const startDir = this.resolve(folder);

    const walk = async (dir: string, indent: number, currentDepth: number): Promise<void> => {
      if (currentDepth > effectiveDepth) return;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (err: unknown) {
        const code = (err as { code?: string }).code;
        if (code !== "ENOENT") {
          process.stderr.write(`[vault] tree readdir skipped ${dir}: ${code ?? err}\n`);
        }
        return;
      }

      entries.sort((a, b) => a.name.localeCompare(b.name));

      for (const entry of entries) {
        if (entry.isDirectory() && this.config.excludeFolders.includes(entry.name)) continue;
        const prefix = "  ".repeat(indent);
        if (entry.isDirectory()) {
          lines.push(`${prefix}${entry.name}/`);
          await walk(path.join(dir, entry.name), indent + 1, currentDepth + 1);
        } else if (entry.name.endsWith(".md")) {
          lines.push(`${prefix}${entry.name}`);
        }
      }
    };

    await walk(startDir, 0, 1);
    return lines.join("\n");
  }

  /** Get vault statistics. */
  async getStats(): Promise<{
    noteCount: number;
    totalSizeBytes: number;
    folders: number;
    recentlyModified: Array<{ path: string; mtime: string }>;
  }> {
    let noteCount = 0;
    let totalSizeBytes = 0;
    let folders = 0;
    const recent: Array<{ path: string; mtime: Date }> = [];

    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (err: unknown) {
        const code = (err as { code?: string }).code;
        if (code !== "ENOENT") {
          process.stderr.write(`[vault] stats readdir skipped ${dir}: ${code ?? err}\n`);
        }
        return;
      }

      const mdFiles: { fullPath: string; relPath: string }[] = [];
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (this.config.excludeFolders.includes(entry.name)) continue;
          folders++;
          await walk(fullPath);
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
          mdFiles.push({ fullPath, relPath: this.relative(fullPath) });
        }
      }

      // Batch stat calls
      const STAT_BATCH = 50;
      for (let s = 0; s < mdFiles.length; s += STAT_BATCH) {
        const batch = mdFiles.slice(s, s + STAT_BATCH);
        const stats = await Promise.all(batch.map((f) => fs.stat(f.fullPath)));
        for (let j = 0; j < batch.length; j++) {
          noteCount++;
          totalSizeBytes += stats[j].size;
          recent.push({ path: batch[j].relPath, mtime: stats[j].mtime });
        }
      }
    };

    await walk(this.root);
    recent.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

    return {
      noteCount,
      totalSizeBytes,
      folders,
      recentlyModified: recent.slice(0, 10).map((r) => ({
        path: r.path,
        mtime: r.mtime.toISOString(),
      })),
    };
  }
}
