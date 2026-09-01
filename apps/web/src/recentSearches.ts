import type { GeocodeResult } from "@osm3d/contracts";

export const recentSearchesStorageKey = "osm3d.recent-searches.v1";
export const recentSearchesLimit = 10;

export interface RecentSearchesStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function localBrowserStorage(): RecentSearchesStorage | undefined {
  if (typeof window === "undefined") return;
  try {
    return window.localStorage;
  } catch {
    return;
  }
}

function asRecentSearch(value: unknown): GeocodeResult | undefined {
  if (!value || typeof value !== "object") return;
  const candidate = value as Record<string, unknown>;
  const displayName =
    typeof candidate.displayName === "string"
      ? candidate.displayName.trim()
      : "";
  const longitude = candidate.longitude;
  const latitude = candidate.latitude;
  if (
    !displayName ||
    typeof longitude !== "number" ||
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180 ||
    typeof latitude !== "number" ||
    !Number.isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90
  )
    return;
  return {
    displayName,
    longitude,
    latitude,
    ...(typeof candidate.type === "string" ? { type: candidate.type } : {}),
  };
}

export function loadRecentSearches(
  storage: RecentSearchesStorage | undefined = localBrowserStorage(),
): GeocodeResult[] {
  if (!storage) return [];
  try {
    const stored = JSON.parse(
      storage.getItem(recentSearchesStorageKey) ?? "[]",
    );
    if (!Array.isArray(stored)) return [];
    const unique = new Set<string>();
    return stored
      .map(asRecentSearch)
      .filter((search): search is GeocodeResult => {
        if (!search) return false;
        const key = search.displayName.toLocaleLowerCase();
        if (unique.has(key)) return false;
        unique.add(key);
        return true;
      })
      .slice(0, recentSearchesLimit);
  } catch {
    return [];
  }
}

export function rememberRecentSearch(
  result: GeocodeResult,
  current: GeocodeResult[],
  storage: RecentSearchesStorage | undefined = localBrowserStorage(),
): GeocodeResult[] {
  const entry = asRecentSearch(result);
  if (!entry) return current;
  const key = entry.displayName.toLocaleLowerCase();
  const next = [
    entry,
    ...current.filter(
      (search) => search.displayName.toLocaleLowerCase() !== key,
    ),
  ].slice(0, recentSearchesLimit);
  try {
    storage?.setItem(recentSearchesStorageKey, JSON.stringify(next));
  } catch {
    // Browsers can deny or exhaust local storage; the in-memory list still works.
  }
  return next;
}
