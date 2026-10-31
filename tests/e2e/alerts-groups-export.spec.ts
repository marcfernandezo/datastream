import { readFileSync } from "node:fs";
import { expect, signIn, test } from "./fixtures";

test.describe.configure({ mode: "serial" });

test("creates an alert channel without echoing secrets back", async ({ page }, testInfo) => {
  await signIn(page);
  await page.goto("/alerts");
  await page.getByRole("button", { name: "Add channel" }).first().click();
  const dialog = page.getByRole("dialog");
  const name = `Phone ${testInfo.project.name}`;
  await dialog.getByLabel("Name").fill(name);
  await dialog.getByLabel("Topic URL").fill("not a url");
  await dialog.getByRole("button", { name: "Save channel" }).click();
  // Native URL validation blocks submit; fix it and include a secret token.
  await dialog.getByLabel("Topic URL").fill("https://ntfy.example/super-secret-topic-123");
  await dialog.getByLabel("Access token (optional)").fill("tk_secret_value");
  await dialog.getByRole("button", { name: "Save channel" }).click();

  await expect(page.getByText(name)).toBeVisible();
  await expect(page.getByText("ntfy.example/••••").first()).toBeVisible();
  const html = await page.content();
  expect(html).not.toContain("super-secret-topic-123");
  expect(html).not.toContain("tk_secret_value");

  await page.getByRole("button", { name: `Delete ${name}` }).click({ noWaitAfter: true });
});

test("groups, membership and CSV export", async ({ page }, testInfo) => {
  page.on("dialog", (d) => d.accept());
  await signIn(page);
  const group = `Cold ${testInfo.project.name}`;
  const address =
    testInfo.project.name === "mobile"
      ? "bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el"
      : "3FZbgi29cpjq2GjdwV8eyHuJJnkLtktZc5";

  await page.goto("/wallets");
  await page.getByRole("button", { name: "Add wallet" }).first().click();
  await page.getByRole("dialog").getByLabel("Address or public key").fill(address);
  await page.getByRole("dialog").getByLabel("Label").fill("Grouped");
  await page.getByRole("dialog").getByRole("button", { name: "Add wallet" }).click();
  await expect(page.getByRole("heading", { name: "Grouped" })).toBeVisible();
  const walletUrl = page.url();

  await page.goto("/wallets");
  await page.getByRole("button", { name: "Groups" }).click();
  await page.getByLabel("New group name").fill(group);
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("dialog").getByText(group)).toBeVisible();
  await page.keyboard.press("Escape");

  await page.goto(walletUrl);
  await page.getByRole("button", { name: group }).click();
  await expect(page.getByRole("button", { name: group })).toHaveAttribute("aria-pressed", "true");

  await page.goto("/wallets");
  await page.getByRole("link", { name: group }).click();
  await expect(page.getByText("Grouped")).toBeVisible();
  await expect(page.getByText("Group total")).toBeVisible();

  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "CSV" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^datastream-group-\d{4}-\d{2}-\d{2}\.csv$/);
  const csv = readFileSync((await file.path())!, "utf8");
  expect(csv.split("\n")[0]).toContain("date_utc,wallet,network,txid");

  // Cleanup
  await page.goto(walletUrl);
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("button", { name: "Delete wallet" }).click();
  await expect(page).toHaveURL(/\/wallets$/);
  await page.getByRole("button", { name: "Groups" }).click();
  await page.getByRole("button", { name: `Delete group ${group}` }).click();
  await expect(page.getByRole("dialog").getByText(group)).toHaveCount(0);
});

test("export requires authentication", async ({ request }) => {
  const res = await request.get("/api/export", { maxRedirects: 0 });
  expect(res.status()).toBe(401);
});
