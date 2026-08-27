import type { Page } from "playwright";
import type { StepResult } from "../types.js";

export async function captureSnapshot(page: Page): Promise<string> {
  return page.locator("body").ariaSnapshot();
}

export async function toStepResult(page: Page): Promise<StepResult> {
  return { url: page.url(), snapshot: await captureSnapshot(page) };
}

export async function captureScreenshot(page: Page): Promise<string> {
  // JPEG at CSS scale keeps vision useful while avoiding a full-resolution PNG on every LLM turn.
  const buffer = await page.screenshot({ type: "jpeg", quality: 60, scale: "css" });
  return buffer.toString("base64");
}
