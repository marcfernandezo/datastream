import { expect, PASSWORD, signIn, test } from "./fixtures";

test.describe.configure({ mode: "serial" });

test("unauthenticated visitors are sent to setup/login", async ({ page, request }) => {
  await page.goto("/settings");
  await expect(page).toHaveURL(/\/(setup|login)$/);
  const api = await request.get("/api/export");
  expect(api.status()).toBe(401);
});

test("first-run setup rejects a wrong token", async ({ page }) => {
  await page.goto("/setup");
  test.skip(!page.url().endsWith("/setup"), "already set up");
  await page.getByLabel("Setup token").fill("wrong");
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Confirm password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create password" }).click();
  await expect(page.getByText("Invalid setup token.")).toBeVisible();
});

test("setup, sign out, and sign back in", async ({ page, context }) => {
  await signIn(page);
  const cookies = await context.cookies();
  const session = cookies.find((c) => c.name === "wt_session");
  expect(session?.httpOnly).toBe(true);
  expect(session?.sameSite).toBe("Strict");

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);

  await page.getByLabel("Password").fill("not the password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Incorrect password.")).toBeVisible();

  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
});

test("security headers are present", async ({ request }) => {
  const res = await request.get("/login");
  const h = res.headers();
  expect(h["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(h["content-security-policy"]).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
  expect(h["x-frame-options"]).toBe("DENY");
  expect(h["referrer-policy"]).toBe("no-referrer");
  expect(h["x-powered-by"]).toBeUndefined();
});
