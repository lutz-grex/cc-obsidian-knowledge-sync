import { describe, test, expect } from "bun:test";
import { appendUnderHeading } from "../sections.js";

describe("appendUnderHeading trailingSeparator", () => {
  test("branch 1: respects custom separator before next heading", () => {
    const body = "# Title\n\n## Log\n\nOld entry\n\n## Notes\n\nSome notes";
    const result = appendUnderHeading(body, "Log", "New entry", "\n");
    expect(result).toContain("New entry\n## Notes");
    expect(result).not.toContain("New entry\n\n## Notes");
  });

  test("branch 2: respects custom separator at EOF", () => {
    const body = "# Title\n\n## Log\n\nOld entry";
    const result = appendUnderHeading(body, "Log", "New entry", "\n");
    expect(result).toContain("Old entry\nNew entry\n");
    expect(result).not.toContain("Old entry\n\nNew entry");
  });
});
