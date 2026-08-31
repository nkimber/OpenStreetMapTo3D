import { expect, test } from "@playwright/test";

test("imports, generates, drives, resets, and reopens the sample world", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByText("Docker services ready")).toBeVisible();

  await page.getByRole("button", { name: /Use the offline sample/ }).click();
  await page.getByRole("button", { name: /Import neighborhood data/ }).click();
  await expect(page.getByText("23 geographic features ready")).toBeVisible();
  await expect(page.getByLabel("Imported source coverage")).toContainText(
    "16buildings",
  );

  const worldName = `Playwright sample ${Date.now()}`;
  await page.getByLabel("World name").fill(worldName);
  await page.getByRole("button", { name: /Generate and explore/ }).click();
  await expect(page.getByRole("heading", { name: worldName })).toBeVisible();
  await expect(page.getByText("© OpenStreetMap contributors")).toBeVisible();

  await page.getByRole("button", { name: "Drive" }).click();
  await expect(page.getByRole("button", { name: "Reset car" })).toBeVisible();
  await page.keyboard.down("w");
  await expect
    .poll(async () =>
      Number(await page.locator(".world-stats .speed strong").textContent()),
    )
    .toBeGreaterThan(0);
  await page.keyboard.up("w");
  await page.getByRole("button", { name: "Reset car" }).click();

  await page.getByRole("button", { name: "Return to world setup" }).click();
  await expect(
    page.getByRole("button", { name: new RegExp(worldName) }),
  ).toBeVisible();
});
