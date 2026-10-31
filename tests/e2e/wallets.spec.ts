import { expect, signIn, test } from "./fixtures";

test.describe.configure({ mode: "serial" });

const SEED =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

test("refuses seed phrases and invalid input", async ({ page }) => {
  await signIn(page);
  await page.goto("/wallets");
  await page.getByRole("button", { name: "Add wallet" }).first().click();
  const dialog = page.getByRole("dialog");

  await dialog.getByLabel("Address or public key").fill(SEED);
  await dialog.getByLabel("Label").fill("Should fail");
  await dialog.getByRole("button", { name: "Add wallet" }).click();
  await expect(dialog.getByText(/never accepts private keys or seed phrases/)).toBeVisible();

  await dialog.getByLabel("Address or public key").fill("bc1qthisisnotvalid");
  await dialog.getByRole("button", { name: "Add wallet" }).click();
  await expect(dialog.getByText("Invalid Bitcoin mainnet address.")).toBeVisible();
});

test("adds, renames and deletes a wallet", async ({ page }, testInfo) => {
  await signIn(page);
  await page.goto("/wallets");
  await page.getByRole("button", { name: "Add wallet" }).first().click();
  const dialog = page.getByRole("dialog");
  // Each browser project uses its own address so the runs don't collide.
  const address =
    testInfo.project.name === "mobile"
      ? "bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g"
      : "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
  await dialog.getByLabel("Address or public key").fill(address);
  await expect(dialog.getByText("Detected: Address")).toBeVisible();
  await dialog.getByLabel("Label").fill("E2E cold storage");
  await dialog.getByRole("button", { name: "Add wallet" }).click();

  await expect(page.getByRole("heading", { name: "E2E cold storage" })).toBeVisible();
  await expect(page.getByText(address)).toBeVisible();
  await expect(page.getByText(/Syncing…|Not synced yet/).first()).toBeVisible();

  // Duplicate detection.
  await page.goto("/wallets");
  await page.getByRole("button", { name: "Add wallet" }).first().click();
  await page.getByRole("dialog").getByLabel("Address or public key").fill(address.toUpperCase());
  await page.getByRole("dialog").getByLabel("Label").fill("dup");
  await page.getByRole("dialog").getByRole("button", { name: "Add wallet" }).click();
  await expect(page.getByText("This wallet is already being watched.")).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByRole("link", { name: /E2E cold storage/ }).click();
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  await page.getByLabel("Label").fill("E2E renamed");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("heading", { name: "E2E renamed" })).toBeVisible();

  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("button", { name: "Delete wallet" }).click();
  await expect(page).toHaveURL(/\/wallets$/);
  await expect(page.getByText("E2E renamed")).toHaveCount(0);
});
