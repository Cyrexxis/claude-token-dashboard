import { expect, test } from "@playwright/test";

test("overview loads fixture data and nav switches views", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto("/");
  await expect(page.locator(".tile", { hasText: "Requests" }).locator(".value")).not.toHaveText(
    "0",
  );

  for (const link of await page.locator("header nav a").all()) {
    await link.click();
    await expect(link).toHaveAttribute("aria-current", "page");
  }
  expect(errors).toEqual([]);
});

test("widen button stretches a chart card to 95 % of the viewport and back", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  const card = page.locator("section.card", {
    has: page.getByRole("heading", { name: "Tokens", exact: true }),
  });
  const width = async () => (await card.boundingBox())?.width ?? 0;
  await expect(card.locator(".recharts-surface")).toBeVisible();
  const before = await width();

  await card.getByRole("button", { name: "Widen chart" }).click();
  await expect.poll(width).toBeCloseTo(1920 * 0.95, -1);
  await card.getByRole("button", { name: "Narrow chart" }).click();
  await expect.poll(width).toBeCloseTo(before, -1);
});
