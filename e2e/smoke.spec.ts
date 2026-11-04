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

test("widen button stretches a chart card to 95 % of the viewport, remembers it, and back", async ({
  page,
}) => {
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
  // Remembered per chart: still wide after a reload, while the cost chart stays narrow.
  await page.reload();
  await expect.poll(width).toBeCloseTo(1920 * 0.95, -1);
  await expect(page.getByRole("button", { name: "Widen chart" })).toHaveCount(1);
  await card.getByRole("button", { name: "Narrow chart" }).click();
  await expect.poll(width).toBeCloseTo(before, -1);
});

test("plan: 5-hour/weekly switch lives in the sticky header and follows the picked window", async ({
  page,
  request,
}) => {
  const H = 3_600_000;
  const now = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  // Oldest first, so the current windows are the latest readings.
  for (const [kind, resetsAt] of [
    ["seven_day", now - 4 * 24 * H],
    ["five_hour", now - 6 * 24 * H],
    ["five_hour", now - 24 * H],
    ["seven_day", now + 3 * 24 * H],
    ["five_hour", now + 2 * H],
  ] as const) {
    const r = await request.post("/api/v1/plan-snapshots", {
      data: { windows: [{ kind, percentUsed: 10, resetsAt: iso(resetsAt) }] },
    });
    expect(r.ok()).toBe(true);
  }
  await page.goto("/#/plan");
  const header = page.locator("header");
  await expect(header.getByRole("button", { name: "5-hour" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(header.getByLabel("Period")).toHaveCount(0);
  await expect(page.locator("main .tabs", { hasText: "Weekly" })).toHaveCount(0);

  // Pick the 5-hour window of last week, then flip: its week, then back to it.
  const windows = page.locator("section.card", {
    has: page.getByRole("heading", { name: "Windows" }),
  });
  await windows.getByRole("button", { name: "← Older week" }).click();
  await windows.locator("button.row-pick").first().click();
  const banner = page.locator(".card", { hasText: "Charts and sessions show the past" });
  await expect(banner).toContainText("5-hour");
  await page.mouse.wheel(0, 2000);
  const weekly = header.getByRole("button", { name: "Weekly" });
  const y = (await weekly.boundingBox())?.y;
  await weekly.click();
  await expect(banner).toContainText("Weekly");
  expect((await weekly.boundingBox())?.y).toBe(y);
  await header.getByRole("button", { name: "5-hour" }).click();
  await expect(banner).toContainText("5-hour");
  await expect(windows.locator("button.row-pick[aria-pressed=true]")).toHaveCount(1);

  await header.getByRole("link", { name: "Overview" }).click();
  await expect(header.getByLabel("Period")).toBeVisible();
});

test("a new view opens at the top; back and forward keep their scroll position", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 600 });
  const header = page.locator("header");
  const sessions = page.getByRole("heading", { name: "Sessions", exact: true });
  // Load Sessions once: from the cache it renders full height at once, so the browser keeps the
  // old scroll position (a first, uncached visit is short and drops to 0 on its own).
  await page.goto("/#/sessions");
  await expect(page.locator("main table tbody tr").first()).toBeVisible();
  await header.getByRole("link", { name: "Overview" }).click();
  // Every chart loaded, so the page is full height before scrolling.
  await page.waitForLoadState("networkidle");
  await page.mouse.wheel(0, 1500);
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(500);
  const scrolled = await page.evaluate(() => scrollY);
  await header.getByRole("link", { name: "Sessions" }).click();
  await expect(sessions).toBeVisible();
  expect(await page.evaluate(() => scrollY)).toBe(0);
  // Back returns to where Overview was left, forward to the top of Sessions again.
  await page.goBack();
  await expect(page.locator(".recharts-surface").first()).toBeVisible();
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(scrolled);
  await page.goForward();
  await expect(sessions).toBeVisible();
  await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
});
