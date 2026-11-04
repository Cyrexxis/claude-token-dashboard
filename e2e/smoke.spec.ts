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
