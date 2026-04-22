import { test, expect } from "bun:test";
import { isNoiseUser, isToolOnlyAssistant, type ConversationTurn } from "../tools/import.js";

test("isNoiseUser: rejects commands, accepts real slash-commands", () => {
  // These should be filtered out
  expect(isNoiseUser("")).toBe(true);
  expect(isNoiseUser('<command-name>/clear</command-name>')).toBe(true);
  expect(isNoiseUser("/clear")).toBe(true);
  expect(isNoiseUser("/resume abc")).toBe(true);

  // These should pass through — real user invocations
  expect(isNoiseUser("/obsidian save")).toBe(false);
  expect(isNoiseUser("Fix the login bug")).toBe(false);
});

test("isToolOnlyAssistant: filters tool-only, keeps substantive", () => {
  expect(isToolOnlyAssistant({ role: "assistant", text: "", tools: ["Bash(`ls`)"] })).toBe(true);
  expect(isToolOnlyAssistant({ role: "assistant", text: "Let me check.", tools: ["Read(`f`)"] })).toBe(true);
  expect(isToolOnlyAssistant({
    role: "assistant",
    text: "Here is a detailed explanation of the issue and how to fix it properly.",
    tools: ["Bash(`ls`)"],
  } as ConversationTurn)).toBe(false);
  expect(isToolOnlyAssistant({ role: "assistant", text: "Short" } as ConversationTurn)).toBe(false);
});
