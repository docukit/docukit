import { expect, test } from "@playwright/test";

test("docs site loads and shows home content", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/Build local-first apps/i);
  await expect(
    page.getByRole("heading", { name: /Build.*local-first.*apps/i }),
  ).toBeVisible();
});
