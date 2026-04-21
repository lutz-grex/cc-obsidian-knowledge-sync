import { describe, test, expect } from "bun:test";
import { extractWikilinks, extractMarkdownLinks, extractAllLinkTargets, rewriteLinks, noteNameFromPath, resolveTarget } from "../wikilinks.js";
import type { Vault } from "../vault.js";

test("extractWikilinks handles simple, aliases, and anchors", () => {
  const links = extractWikilinks("[[Note]] and [[Note|alias]] and [[Note#h2]]");
  expect(links).toHaveLength(3);
  expect(links[0].target).toBe("Note");
  expect(links[1].alias).toBe("alias");
  expect(links[2].target).toBe("Note#h2");
});

test("extractMarkdownLinks finds .md links, ignores others", () => {
  const links = extractMarkdownLinks("[a](note.md) and [b](https://x.com)");
  expect(links).toHaveLength(1);
  expect(links[0].target).toBe("note.md");
});

test("extractAllLinkTargets deduplicates and strips anchors", () => {
  const targets = extractAllLinkTargets("[[Note]] [[Note#h2]] [[Other]]");
  expect(targets).toContain("Note");
  expect(targets).toContain("Other");
  expect(targets).not.toContain("Note#h2");
});

test("rewriteLinks handles basename, path-based, and multi-link", () => {
  expect(rewriteLinks("[[Old]]", "Old", "New")).toBe("[[New]]");
  expect(rewriteLinks("[[Old|alias]]", "Old", "New")).toBe("[[New|alias]]");
  expect(rewriteLinks("[[f/Old]]", "Old", "New", "f/Old", "g/New")).toBe("[[g/New]]");
  expect(rewriteLinks("[t](f/Old.md)", "Old", "New", "f/Old", "g/New")).toBe("[t](g/New.md)");
});

test("noteNameFromPath strips folder and .md", () => {
  expect(noteNameFromPath("a/b/Note.md")).toBe("Note");
  expect(noteNameFromPath("Note")).toBe("Note");
});

// ─── resolveTarget ───────────────────────────────────────────────────────────

function mockVault(files: string[]): Vault {
  return {
    async exists(p: string) { return files.includes(p); },
    async listAllMarkdownFiles() { return files.map((f) => ({ path: f, size: 0, mtime: new Date() })); },
  } as unknown as Vault;
}

describe("resolveTarget", () => {
  test("resolves vault-root and source-relative", async () => {
    const v = mockVault(["Notes/Docker.md", "Projects/web/README.md"]);
    expect((await resolveTarget(v, "Notes/Docker")).path).toBe("Notes/Docker.md");
    expect((await resolveTarget(v, "README", "Projects/web")).path).toBe("Projects/web/README.md");
  });

  test("resolves by basename, returns missing for unknown", async () => {
    const v = mockVault(["deep/UniqueNote.md"]);
    expect((await resolveTarget(v, "UniqueNote")).path).toBe("deep/UniqueNote.md");
    expect((await resolveTarget(v, "Nope")).status).toBe("missing");
  });

  test("returns ambiguous for duplicate basenames", async () => {
    const v = mockVault(["a/Note.md", "b/Note.md"]);
    const r = await resolveTarget(v, "Note");
    expect(r.status).toBe("ambiguous");
    expect(r.candidates).toHaveLength(2);
  });

  test("path-suffix resolves before basename ambiguity", async () => {
    const v = mockVault(["a/sub/Note.md", "b/Note.md"]);
    expect((await resolveTarget(v, "sub/Note")).path).toBe("a/sub/Note.md");
  });

  test("prefers source-relative over vault-root", async () => {
    const v = mockVault(["README.md", "Projects/README.md"]);
    expect((await resolveTarget(v, "README", "Projects")).path).toBe("Projects/README.md");
  });
});
