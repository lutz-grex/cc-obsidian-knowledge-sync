import { describe, test, expect } from "bun:test";
import { escapeRegex, escapeReplacement, localDate, localTime, formatDate, validateAuthor, slugify } from "../utils.js";

test("escapeRegex produces valid pattern", () => {
  const input = "price is $100.00 (USD)";
  expect(new RegExp(escapeRegex(input)).test(input)).toBe(true);
  expect(new RegExp(escapeRegex(input)).test("price is $100X00")).toBe(false);
});

test("escapeReplacement neutralizes $ sequences", () => {
  expect("hello".replace(/hello/, escapeReplacement("$& world"))).toBe("$& world");
});

test("localDate returns padded YYYY-MM-DD", () => {
  expect(localDate(new Date(2024, 0, 5))).toBe("2024-01-05");
});

test("localTime returns padded HH:MM", () => {
  expect(localTime(new Date(2024, 0, 1, 9, 5))).toBe("09:05");
});

test("formatDate substitutes tokens", () => {
  const d = new Date(2024, 5, 15);
  expect(formatDate(d, "YYYY-MM-DD")).toBe("2024-06-15");
  expect(formatDate(d, "DD/MM/YYYY")).toBe("15/06/2024");
});

test("validateAuthor rejects invalid, accepts valid", () => {
  expect(validateAuthor("")).not.toBeNull();
  expect(validateAuthor("user\x00name")).not.toBeNull();
  expect(validateAuthor("user<script>")).not.toBeNull();
  expect(validateAuthor("Alice Bob")).toBeNull();
});

test("slugify trims multi-dash and respects maxLen", () => {
  expect(slugify("---test---")).toBe("test");
  expect(slugify("a".repeat(100), 50).length).toBe(50);
  expect(slugify("a   b---c")).toBe("a-b-c");
});
