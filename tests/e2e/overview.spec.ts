import { expect, signIn, test } from "./fixtures";

test.describe.configure({ mode: "serial" });

test("overview renders with a wallet and privacy mode masks amounts", async ({
  page,
}, testInfo) => {
  await signIn(page);
  const address =
    testInfo.project.name === "mobile"
      ? "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"
      : "37VucYSaXLCAsxYyAPfbSi9eh4iEcbShgf";
  await page.goto("/wallets");
  await page.getByRole("button", { name: "Add wallet" }).first().click();
  await page.getByRole("dialog").getByLabel("Address or public key").fill(address);
  await page.getByRole("dialog").getByLabel("Label").fill("Privacy test");
  await page.getByRole("dialog").getByRole("button", { name: "Add wallet" }).click();
  await expect(page.getByRole("heading", { name: "Privacy test" })).toBeVisible();

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(page.getByText("Total value")).toBeVisible();
  const total = page.locator("[data-private]").first();
  await expect(total).not.toHaveCSS("color", "rgba(0, 0, 0, 0)");

  await page.getByRole("button", { name: "Hide amounts" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-privacy", "on");
  await expect(total).toHaveCSS("color", "rgba(0, 0, 0, 0)");

  // Persists across reloads, server-rendered (no flash of real amounts).
  const response = await page.reload();
  expect(await response!.text()).toContain('data-privacy="on"');
  await expect(total).toHaveCSS("color", "rgba(0, 0, 0, 0)");

  // Keyboard shortcut toggles it back.
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("h");
  await expect(page.locator("html")).toHaveAttribute("data-privacy", "off");

  // Clean up so later runs start from the same state.
  await page.goto("/wallets");
  await page.getByRole("link", { name: /Privacy test/ }).click();
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("button", { name: "Delete wallet" }).click();
  await expect(page).toHaveURL(/\/wallets$/);
});

test("PWA assets are public and the service worker is never cached", async ({ request }) => {
  const manifest = await request.get("/manifest.webmanifest");
  expect(manifest.ok()).toBe(true);
  expect((await manifest.json()).name).toBe("Datastream");
  const sw = await request.get("/sw.js");
  expect(sw.ok()).toBe(true);
  expect(sw.headers()["cache-control"]).toContain("no-store");
  expect((await request.get("/icons/icon-192.png")).ok()).toBe(true);
  expect((await request.get("/offline")).ok()).toBe(true);
});
