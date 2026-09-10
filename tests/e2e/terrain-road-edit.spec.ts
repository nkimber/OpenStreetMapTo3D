import { expect, test } from "@playwright/test";

test("road width, hiding and undo rebuild the terrain before driving", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.goto("/");
  await expect
    .poll(async () => (await page.request.get("/api/ready")).status())
    .toBe(200);
  await page.getByRole("button", { name: /Use the offline sample/ }).click();
  await page.getByRole("button", { name: /Import neighborhood data/ }).click();
  await expect(
    page.getByText(/23 geographic features (ready|reused)/),
  ).toBeVisible();
  await page.getByLabel("World name").fill(`Terrain edits ${Date.now()}`);
  await page.getByRole("button", { name: /Generate and explore/ }).click();
  const drive = page.getByRole("button", { name: "Drive" });
  await expect(drive).toBeEnabled({ timeout: 30_000 });
  await page.getByText("Build & performance").click();
  const hash = page.getByTitle("Deterministic build hash");
  const triangles = page.locator(
    '.telemetry-panel dt:text-is("Terrain triangles") + dd',
  );
  const initialHash = (await hash.textContent())!;
  const initialTriangles = (await triangles.textContent())!;
  await page.getByLabel("Select a feature").selectOption("osm:way:10000");
  const width = page.getByLabel("Width (metres)");
  const initialWidth = await width.inputValue();
  await width.fill("18");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(hash).not.toHaveText(initialHash, { timeout: 30_000 });
  await expect(triangles).not.toHaveText(initialTriangles);
  const wideHash = (await hash.textContent())!;
  const wideTriangles = (await triangles.textContent())!;

  await page.getByRole("button", { name: "Hide feature" }).click();
  await expect(hash).not.toHaveText(wideHash, { timeout: 30_000 });
  await expect(triangles).not.toHaveText(wideTriangles);
  await page.getByRole("button", { name: /Undo/ }).click();
  await expect(hash).toHaveText(wideHash, { timeout: 30_000 });
  await expect(triangles).toHaveText(wideTriangles);
  await page.getByRole("button", { name: /Undo/ }).click();
  await expect(hash).toHaveText(initialHash, { timeout: 30_000 });
  await expect(triangles).toHaveText(initialTriangles);
  await page.getByLabel("Select a feature").selectOption("osm:way:10000");
  await expect(width).toHaveValue(initialWidth);

  await drive.click();
  await page.keyboard.down("w");
  await expect
    .poll(async () =>
      Number(await page.locator(".world-stats .speed strong").textContent()),
    )
    .toBeGreaterThan(5);
  await page.keyboard.up("w");
  await page.getByRole("button", { name: "Reset car" }).click();
  await expect
    .poll(async () =>
      Number(await page.locator(".world-stats .speed strong").textContent()),
    )
    .toBeLessThan(1);
});
