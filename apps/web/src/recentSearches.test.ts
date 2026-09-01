import { describe, expect, it } from "vitest";
import type { GeocodeResult } from "@osm3d/contracts";
import {
  loadRecentSearches,
  recentSearchesLimit,
  recentSearchesStorageKey,
  rememberRecentSearch,
  type RecentSearchesStorage,
} from "./recentSearches.js";

function memoryStorage(): RecentSearchesStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

function result(index: number): GeocodeResult {
  return {
    displayName: `${index} Market Street, Philadelphia`,
    longitude: -75.16 + index / 10_000,
    latitude: 39.95 + index / 10_000,
  };
}

describe("recent searches", () => {
  it("persists selected addresses in most-recent-first order", () => {
    const storage = memoryStorage();
    const recent = rememberRecentSearch(result(1), [], storage);
    rememberRecentSearch(result(2), recent, storage);

    expect(loadRecentSearches(storage).map((item) => item.displayName)).toEqual(
      [result(2).displayName, result(1).displayName],
    );
  });

  it("deduplicates addresses and retains only the last ten", () => {
    const storage = memoryStorage();
    let recent: GeocodeResult[] = [];
    for (let index = 0; index < recentSearchesLimit + 2; index += 1) {
      recent = rememberRecentSearch(result(index), recent, storage);
    }
    recent = rememberRecentSearch(
      { ...result(5), displayName: result(5).displayName.toUpperCase() },
      recent,
      storage,
    );

    expect(recent).toHaveLength(recentSearchesLimit);
    expect(recent[0]?.displayName).toBe(result(5).displayName.toUpperCase());
    expect(
      recent.filter(
        (item) =>
          item.displayName.toLocaleLowerCase() ===
          result(5).displayName.toLocaleLowerCase(),
      ),
    ).toHaveLength(1);
  });

  it("ignores malformed cached data", () => {
    const storage = memoryStorage();
    storage.setItem(recentSearchesStorageKey, "not json");
    expect(loadRecentSearches(storage)).toEqual([]);
  });
});
