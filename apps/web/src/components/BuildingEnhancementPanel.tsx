import { useMemo, useState } from "react";
import type {
  BuildingCustomization,
  BuildingEnhancementProposal,
  NormalizedFeature,
  WorldDefinition,
} from "@osm3d/contracts";
import { api } from "../api.js";

interface BuildingEnhancementPanelProps {
  definition: WorldDefinition;
  feature: NormalizedFeature;
  proposal: BuildingEnhancementProposal | undefined;
  proposalCount: number;
  onProposalChange: (proposal?: BuildingEnhancementProposal) => void;
  onDefinitionChange: (definition: WorldDefinition) => void;
  onClose: () => void;
}

function replaceCustomization(
  values: BuildingCustomization[],
  next: BuildingCustomization,
) {
  return [...values.filter((item) => item.sourceId !== next.sourceId), next];
}

function confidence(value: number | undefined) {
  return value === undefined ? "—" : `${Math.round(value * 100)}%`;
}

export function BuildingEnhancementPanel({
  definition,
  feature,
  proposal,
  proposalCount,
  onProposalChange,
  onDefinitionChange,
  onClose,
}: BuildingEnhancementPanelProps) {
  const [analyzing, setAnalyzing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const saved = useMemo(
    () => definition.buildingCustomizations ?? [],
    [definition.buildingCustomizations],
  );

  const analyze = async () => {
    setAnalyzing(true);
    setError(undefined);
    try {
      onProposalChange(
        await api.createBuildingEnhancement(
          definition.world.id,
          feature.sourceId,
          30,
        ),
      );
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The aerial analysis could not be completed.",
      );
    } finally {
      setAnalyzing(false);
    }
  };

  const apply = async () => {
    if (!proposal) return;
    setSaving(true);
    setError(undefined);
    try {
      const customization = await api.saveBuildingCustomization(
        definition.world.id,
        proposal.proposedCustomization,
      );
      const nextValues = replaceCustomization(saved, customization);
      onDefinitionChange({
        ...definition,
        buildingCustomizations: nextValues,
      });
      onProposalChange(undefined);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The proposed enhancement could not be saved.",
      );
    } finally {
      setSaving(false);
    }
  };

  const title =
    feature.tags.name ??
    feature.tags["addr:housenumber"] ??
    "Selected building";

  return (
    <aside
      className="building-enhancement glass-panel"
      aria-label="Building enhancement"
    >
      <header>
        <div>
          <p className="eyebrow">Aerial enhancement</p>
          <strong>{title}</strong>
        </div>
        <button
          type="button"
          className="icon-button"
          onClick={onClose}
          aria-label="Close building enhancement"
        >
          ×
        </button>
      </header>
      {!proposal ? (
        <>
          <p>
            Analyze a licensed aerial image covering this footprint and a 30 m
            buffer. The preview may add a roof form, driveway, trees, and
            bushes.
          </p>
          <button
            className="enhance-primary"
            type="button"
            disabled={analyzing}
            onClick={() => void analyze()}
          >
            {analyzing ? "Analyzing aerial image…" : "Enhance this building"}
          </button>
          <small>
            Uses public-domain USGS NAIP imagery where coverage exists. No
            change is saved until you apply the preview. Other analyzed
            buildings remain visible while this world stays open.
          </small>
        </>
      ) : (
        <>
          <div className="enhancement-image-wrap">
            <img
              src={proposal.imagery.previewDataUrl}
              alt="Aerial image analyzed around the selected building"
            />
            <span>30 m analysis area</span>
          </div>
          <dl className="enhancement-findings">
            <div>
              <dt>Roof</dt>
              <dd>
                {proposal.observations.roof.shape},{" "}
                {proposal.observations.roof.orientation} ·{" "}
                {confidence(proposal.observations.roof.confidence)}
              </dd>
            </div>
            <div>
              <dt>Driveway</dt>
              <dd>
                {proposal.observations.driveway?.detected
                  ? "candidate found"
                  : "not confidently detected"}{" "}
                · {confidence(proposal.observations.driveway?.confidence)}
              </dd>
            </div>
            <div>
              <dt>Vegetation</dt>
              <dd>
                {proposal.observations.landscaping.trees} trees ·{" "}
                {proposal.observations.landscaping.bushes} bushes
              </dd>
            </div>
          </dl>
          <p className="enhancement-warning">{proposal.warnings[0]}</p>
          <small>
            Unsaved preview · retained while this world stays open
            {proposalCount > 1
              ? ` · ${proposalCount} building previews active`
              : ""}
          </small>
          <div className="enhancement-actions">
            <button
              type="button"
              onClick={() => onProposalChange(undefined)}
              disabled={saving}
            >
              Discard
            </button>
            <button
              className="enhance-primary"
              type="button"
              onClick={() => void apply()}
              disabled={saving}
            >
              {saving ? "Saving…" : "Save enhancement"}
            </button>
          </div>
          <small>
            <a
              href={proposal.imagery.sourceUrl}
              target="_blank"
              rel="noreferrer"
            >
              {proposal.imagery.attribution}
            </a>{" "}
            · {proposal.imagery.license}
          </small>
        </>
      )}
      {error && (
        <p className="enhancement-error" role="alert">
          {error}
        </p>
      )}
    </aside>
  );
}
