# Aerial building enhancement

Status: Proof of concept

Last updated: 2026-09-24

## User experience

In **Drive** mode, clicking a building selects it and draws an amber outline.
The **Aerial enhancement** panel offers one explicit action: analyze the
building footprint plus a 30 metre buffer. Analysis never changes saved data by
itself. The result first appears as an aerial-image card, confidence-labelled
findings, and a live 3D preview. **Apply enhancement** persists it through the
normal revision-checked building customization API; **Discard** restores the
saved model.

Building picking is disabled while race setup or a race is active so the
interaction does not compete with driving and race controls.

## Data source and processing

The server requests a 512 × 512 natural-colour crop from the configured
`USGS_NAIP_BASE_URL`. The default is the USGS National Agriculture Imagery
Program ImageServer. NAIP imagery is a United States government product and is
public domain; availability and vintage vary by location. The provider,
license, analysis time, source URL and confidence values are saved with the
building customization.

The browser never supplies a provider URL. The API caps the buffer to 10–60 m,
uses a 20 second timeout, accepts only image responses and rejects responses
larger than 8 MB.

The current deterministic computer-vision pass estimates:

- roof colour from pixels inside the OSM footprint;
- flat, gabled or hipped roof form and ridge orientation from roof texture and
  dominant edges;
- a driveway candidate by scoring the image corridor from viable exterior
  walls to the nearest imported road;
- compact green connected components outside the footprint as tree or bush
  candidates, capped at 16 objects.

The proposal preserves any existing manual openings and boundaries. It only
adds a garage/driveway when no manual garage exists and the surface score clears
the confidence threshold.

## Deliberate limitations

This is a proof of concept, not a survey product. Shadows, seasonal colour,
tree cover, image age, low resolution and footprint offsets can all produce
false positives. Users must inspect the 3D preview before applying it.

The imported USGS 3DEP elevation grid is a bare-earth terrain surface. It does
not provide roof or vegetation height. Raw 3DEP point-cloud processing is not
part of this increment, so tree and bush heights are visual estimates and roof
height remains governed by the existing OSM/world-generation rules.

The default source covers the United States. Outside NAIP coverage the action
fails clearly and leaves the building unchanged. A future provider registry can
add other licensed imagery or local orthophotos without exposing arbitrary URLs
to the browser.

## Verification

The analyzer has a synthetic-image test covering schema validation, roof
appearance, driveway proposal, vegetation extraction and embedded preview
generation. Shared-contract tests cover persisted evidence, roof orientation
and landscaping defaults. Browser acceptance should additionally verify
building picking, preview/discard and persistence against a live NAIP-covered
world.

## References

- [USGS NAIP imagery service](https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer)
- [USGS data and copyright policy](https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits)
- [USGS 3DEP products and services](https://www.usgs.gov/3d-elevation-program/about-3dep-products-services)
