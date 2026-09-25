import type {
  GeocodeResult,
  BuildingCustomization,
  BuildingEnhancementProposal,
  ImportJob,
  ImportRequest,
  SnapshotPreview,
  SceneEnhancementTile,
  WorldCreateRequest,
  WorldDefinition,
  WorldOverride,
  WorldSummary,
} from "@osm3d/contracts";

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "/api";

export class ApiClientError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const body = (await response.json().catch(() => ({}))) as {
    error?: { code?: string; message?: string };
  } & T;
  if (!response.ok) {
    throw new ApiClientError(
      body.error?.message ?? `Request failed with HTTP ${response.status}`,
      body.error?.code ?? "REQUEST_FAILED",
      response.status,
    );
  }
  return body;
}

export const api = {
  async createSceneEnhancement(
    id: string,
    center: [number, number],
    sizeMeters = 200,
    signal?: AbortSignal,
  ): Promise<SceneEnhancementTile> {
    return apiFetch(`/worlds/${id}/scene-enhancement`, {
      method: "POST",
      body: JSON.stringify({ center, sizeMeters }),
      ...(signal ? { signal } : {}),
    });
  },
  async createBuildingEnhancement(
    id: string,
    sourceId: string,
    bufferMeters = 30,
  ): Promise<BuildingEnhancementProposal> {
    return apiFetch(`/worlds/${id}/building-enhancement`, {
      method: "POST",
      body: JSON.stringify({ sourceId, bufferMeters }),
    });
  },
  async saveBuildingCustomization(
    id: string,
    value: BuildingCustomization,
  ): Promise<BuildingCustomization> {
    return apiFetch(`/worlds/${id}/building-customization`, {
      method: "PUT",
      body: JSON.stringify(value),
    });
  },
  async ready(): Promise<boolean> {
    try {
      await apiFetch("/ready");
      return true;
    } catch {
      return false;
    }
  },

  async geocode(query: string): Promise<GeocodeResult[]> {
    const response = await apiFetch<{ results: GeocodeResult[] }>("/geocode", {
      method: "POST",
      body: JSON.stringify({ query }),
    });
    return response.results;
  },

  async createImport(request: ImportRequest): Promise<ImportJob> {
    return apiFetch<ImportJob>("/imports", {
      method: "POST",
      body: JSON.stringify(request),
    });
  },

  async getImport(id: string): Promise<ImportJob> {
    return apiFetch<ImportJob>(`/imports/${id}`);
  },

  async getSnapshotPreview(id: string): Promise<SnapshotPreview> {
    return apiFetch<SnapshotPreview>(`/snapshots/${id}/preview`);
  },

  async createWorld(request: WorldCreateRequest): Promise<WorldSummary> {
    return apiFetch<WorldSummary>("/worlds", {
      method: "POST",
      body: JSON.stringify(request),
    });
  },

  async listWorlds(): Promise<WorldSummary[]> {
    const response = await apiFetch<{ worlds: WorldSummary[] }>("/worlds");
    return response.worlds;
  },

  async getWorldDefinition(id: string): Promise<WorldDefinition> {
    return apiFetch<WorldDefinition>(`/worlds/${id}/definition`);
  },

  async saveOverrides(
    id: string,
    overrides: WorldOverride[],
  ): Promise<WorldOverride[]> {
    const response = await apiFetch<{ overrides: WorldOverride[] }>(
      `/worlds/${id}/overrides`,
      {
        method: "PUT",
        body: JSON.stringify({ overrides }),
      },
    );
    return response.overrides;
  },
};
