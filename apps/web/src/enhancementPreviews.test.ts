import { describe, expect, it } from "vitest";
import type {
  BuildingCustomization,
  BuildingEnhancementProposal,
} from "@osm3d/contracts";
import { mergeEnhancementPreviews } from "./enhancementPreviews.js";

function customization(sourceId: string, roof: "flat" | "gabled" | "hipped") {
  return {
    sourceId,
    revision: 0,
    footprint: `footprint:${sourceId}`,
    openings: [],
    appearance: { roof },
    boundaries: [],
    landscaping: [],
  } satisfies BuildingCustomization;
}

function proposal(value: BuildingCustomization): BuildingEnhancementProposal {
  return {
    sourceId: value.sourceId,
    bufferMeters: 30,
    imagery: {
      previewDataUrl: "data:image/jpeg;base64,AA==",
      analyzedAt: "2026-09-25T00:00:00.000Z",
      provider: "usgs-naip",
      attribution: "USGS",
      license: "Public domain",
      sourceUrl: "https://example.test/ImageServer",
    },
    observations: {
      roof: {
        shape: value.appearance.roof ?? "flat",
        orientation: "along",
        color: "#777777",
        confidence: 0.8,
      },
      landscaping: { trees: 0, bushes: 0, confidence: 0.5 },
    },
    proposedCustomization: value,
    warnings: [],
  };
}

describe("mergeEnhancementPreviews", () => {
  it("retains every analyzed building while a different building is selected", () => {
    const first = customization("building:first", "gabled");
    const second = customization("building:second", "hipped");

    expect(
      mergeEnhancementPreviews([], {
        [first.sourceId]: proposal(first),
        [second.sourceId]: proposal(second),
      }),
    ).toEqual([first, second]);
  });

  it("uses an unsaved preview without removing other saved enhancements", () => {
    const savedFirst = customization("building:first", "flat");
    const previewFirst = customization("building:first", "gabled");
    const savedSecond = customization("building:second", "hipped");

    expect(
      mergeEnhancementPreviews([savedFirst, savedSecond], {
        [previewFirst.sourceId]: proposal(previewFirst),
      }),
    ).toEqual([savedSecond, previewFirst]);
  });
});
