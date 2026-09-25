import type {
  BuildingCustomization,
  BuildingEnhancementProposal,
} from "@osm3d/contracts";

export function mergeEnhancementPreviews(
  saved: BuildingCustomization[],
  proposals: Record<string, BuildingEnhancementProposal>,
  automatic: BuildingCustomization[] = [],
): BuildingCustomization[] {
  const previews = Object.values(proposals).map(
    (proposal) => proposal.proposedCustomization,
  );
  const previewIds = new Set(previews.map((value) => value.sourceId));
  const savedIds = new Set(saved.map((value) => value.sourceId));
  return [
    ...saved.filter((value) => !previewIds.has(value.sourceId)),
    ...automatic.filter(
      (value) =>
        !savedIds.has(value.sourceId) && !previewIds.has(value.sourceId),
    ),
    ...previews,
  ];
}
