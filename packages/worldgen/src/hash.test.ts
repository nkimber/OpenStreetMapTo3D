import { expect, it } from "vitest";
import { deterministicHash } from "./hash.js";

it("preserves the original 64-bit FNV hash for large and Unicode inputs", () => {
  for (const value of [
    null,
    "",
    "terrain 🏔️",
    Array.from({ length: 10000 }, (_, i) => i / 7),
  ]) {
    let expected = 14695981039346656037n;
    for (const char of JSON.stringify(value).split("")) {
      expected ^= BigInt(char.charCodeAt(0));
      expected = BigInt.asUintN(64, expected * 1099511628211n);
    }
    expect(deterministicHash(value)).toBe(
      expected.toString(16).padStart(16, "0"),
    );
  }
  expect(deterministicHash({ b: [2, 3], a: 1 })).toBe(
    deterministicHash({ a: 1, b: [2, 3] }),
  );
});
