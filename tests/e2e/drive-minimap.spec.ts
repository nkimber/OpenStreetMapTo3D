import { expect, test } from "@playwright/test";

test("keeps the 2D drive minimap visible and expandable", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/");
  await expect
    .poll(async () => (await page.request.get("/api/ready")).status())
    .toBe(200);

  await page.getByRole("button", { name: /Use the offline sample/ }).click();
  await page.getByRole("button", { name: /Import neighborhood data/ }).click();
  await expect(page.getByLabel("Imported source coverage")).toContainText(
    "16buildings",
  );

  const worldName = `Minimap check ${Date.now()}`;
  await page.getByLabel("World name").fill(worldName);
  await page.getByRole("button", { name: /Generate and explore/ }).click();
  await expect(page.getByRole("heading", { name: worldName })).toBeVisible();

  const driveButton = page.getByRole("button", { name: "Drive" });
  await expect(driveButton).toBeEnabled({ timeout: 30_000 });
  await driveButton.click();

  const driveMap = page.getByRole("region", { name: "Drive map" });
  await expect(driveMap).toBeVisible();
  await expect(driveMap.locator(".drive-minimap-map canvas")).toBeVisible();
  await expect(driveMap.locator(".drive-minimap-car")).toBeVisible();

  const expandedBox = await driveMap.boundingBox();
  expect(expandedBox?.width).toBeGreaterThan(200);
  expect(expandedBox?.height).toBeGreaterThan(150);

  await page.getByRole("button", { name: "Collapse drive map" }).click();
  const expandButton = page.getByRole("button", { name: "Expand drive map" });
  await expect(expandButton).toBeVisible();
  await expandButton.click();
  await expect(driveMap.locator(".drive-minimap-map canvas")).toBeVisible();
});
