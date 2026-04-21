import { describe, test, expect } from "bun:test";
import { parseNote, serializeNote, mergeFrontmatter } from "../frontmatter.js";

describe("parseNote", () => {
  test("parses frontmatter + body", () => {
    const result = parseNote("---\ntitle: Test\ntags:\n  - one\n---\n# Hello\n\nBody");
    expect(result.frontmatter).toEqual({ title: "Test", tags: ["one"] });
    expect(result.body).toBe("# Hello\n\nBody");
  });

  test("returns null when no frontmatter", () => {
    const result = parseNote("# Just text");
    expect(result.frontmatter).toBeNull();
  });

  test("handles CRLF and trailing spaces on delimiters", () => {
    expect(parseNote("---\r\ntitle: A\r\n---\r\nB").frontmatter).toEqual({ title: "A" });
    expect(parseNote("---   \ntitle: A\n---  \nB").frontmatter).toEqual({ title: "A" });
  });
});

describe("serializeNote", () => {
  test("roundtrips through parse → serialize", () => {
    const original = "---\ntitle: Test\ntags:\n  - one\n---\n# Content\n";
    const { frontmatter, body } = parseNote(original);
    const reparsed = parseNote(serializeNote(frontmatter, body));
    expect(reparsed.frontmatter).toEqual(frontmatter);
    expect(reparsed.body).toBe(body);
  });

  test("returns body only when no frontmatter", () => {
    expect(serializeNote(null, "Body")).toBe("Body");
    expect(serializeNote({}, "Body")).toBe("Body");
  });
});

describe("mergeFrontmatter", () => {
  test("flat merge, deep merge, array replace", () => {
    expect(mergeFrontmatter({ a: 1, b: 2 }, { b: 3, c: 4 })).toEqual({ a: 1, b: 3, c: 4 });
    expect(mergeFrontmatter({ m: { x: 1, y: 2 } }, { m: { y: 3 } })).toEqual({ m: { x: 1, y: 3 } });
    expect(mergeFrontmatter({ tags: ["a"] }, { tags: ["b"] })).toEqual({ tags: ["b"] });
  });
});
