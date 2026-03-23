import { expect, test } from "@playwright/test";

test("docs site loads and shows home content", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/Build local-first apps/i);
  await expect(
    page.getByRole("heading", { name: /Build.*local-first.*apps/i }),
  ).toBeVisible();
});

test("after navigating to DocNode and back, editor demo is visible (not stuck on loading)", async ({
  page,
}) => {
  await page.goto("/");
  // Wait for the synced editors demo to finish loading (editors visible, not "Connecting…")
  await expect(page.getByText("Connecting…")).toBeHidden({ timeout: 15_000 });
  await expect(page.locator("[data-lexical-editor]")).toHaveCount(2);

  // Navigate to DocNode docs via SPA link (wait for fade-in animation to finish)
  const docNodeCard = page.getByRole("link", { name: /DocNode Type-safe/ });
  await expect(docNodeCard).toBeVisible();
  await docNodeCard.click();
  await expect(page).toHaveURL(/\/docnode/, { timeout: 15_000 });

  // Go back to home
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);

  // Editor demo should be visible again, not stuck on loading
  await expect(page.getByText("Connecting…")).toBeHidden({ timeout: 15_000 });
  await expect(page.locator("[data-lexical-editor]")).toHaveCount(2, {
    timeout: 15_000,
  });
});
