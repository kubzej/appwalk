import type { Page } from "playwright";
import * as actions from "../browser/actions.js";
import { toStepResult } from "../browser/snapshot.js";
import { resolveLocator } from "../browser/locator.js";
import type { ToolCall, ToolDefinition } from "../providers/provider.js";
import type { ExpectationAssertion, ExpectationObservation, StepResult } from "../types.js";

const clickOptions = {
  button: { type: "string", enum: ["left", "right", "middle"] },
  modifiers: { type: "array", items: { type: "string", enum: ["Alt", "Control", "Meta", "Shift"] } },
};

const locatorProp = {
  locator: {
    type: "string",
    description: "A Playwright locator string — prefer the stable locator hint from the page observation; see the locator syntax rules in the system prompt.",
  },
};

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "navigate",
    description: "Navigate the browser to a URL.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
  },
  {
    name: "click",
    description: "Click an element.",
    inputSchema: { type: "object", properties: { ...locatorProp, ...clickOptions }, required: ["locator"] },
  },
  {
    name: "doubleClick",
    description: "Double-click an element.",
    inputSchema: { type: "object", properties: { ...locatorProp, ...clickOptions }, required: ["locator"] },
  },
  {
    name: "fill",
    description: "Type a value into a text field, replacing its current content.",
    inputSchema: {
      type: "object",
      properties: { ...locatorProp, value: { type: "string" } },
      required: ["locator", "value"],
    },
  },
  {
    name: "select",
    description: "Choose one option in a <select> dropdown by its value, or multiple options by passing an array of values.",
    inputSchema: {
      type: "object",
      properties: {
        ...locatorProp,
        value: {
          description: "One option value for a normal select, or an array of option values for a multi-select.",
          anyOf: [
            { type: "string" },
            { type: "array", items: { type: "string" }, minItems: 1 },
          ],
        },
      },
      required: ["locator", "value"],
    },
  },
  {
    name: "pressKey",
    description: "Press a keyboard key (e.g. Enter, Tab, Escape) while an element is focused.",
    inputSchema: {
      type: "object",
      properties: { ...locatorProp, key: { type: "string" } },
      required: ["locator", "key"],
    },
  },
  {
    name: "check",
    description: "Check a checkbox or radio button.",
    inputSchema: { type: "object", properties: locatorProp, required: ["locator"] },
  },
  {
    name: "uncheck",
    description: "Uncheck a checkbox.",
    inputSchema: { type: "object", properties: locatorProp, required: ["locator"] },
  },
  {
    name: "hover",
    description: "Hover over an element — use this to reveal menus that only appear on mouseover.",
    inputSchema: { type: "object", properties: locatorProp, required: ["locator"] },
  },
  {
    name: "dragAndDrop",
    description: "Drag one element onto another element.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Locator for the element to drag." },
        target: { type: "string", description: "Locator for the drop target." },
      },
      required: ["source", "target"],
    },
  },
  {
    name: "goBack",
    description: "Navigate back to the previous page in browser history.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "reload",
    description: "Reload the current page.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "clearCookie",
    description:
      "Delete one named cookie, or all cookies when name is omitted. Follow it with a request or reload to test how the app handles the missing session or token.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Cookie name to delete; omit to delete all cookies." } },
    },
  },
  {
    name: "goForward",
    description: "Navigate forward to the next page in browser history (undoes a goBack).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "hardReload",
    description: "Reload the current page bypassing the browser cache, forcing a real network re-fetch of everything.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "openInNewTab",
    description: "Open the current page's URL in a new browser tab and switch to it. The old tab stays open in the background.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "reopenBrowser",
    description: "Simulate fully closing and reopening the browser, then navigate back to the current URL. Cookies and localStorage carry over; sessionStorage does not, matching a real browser restart.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "scroll",
    description:
      "Scroll a specific element into view (pass locator), or scroll to the bottom of the page to reveal more content on infinite-scroll pages (omit locator).",
    inputSchema: { type: "object", properties: locatorProp },
  },
  {
    name: "setViewportSize",
    description: "Set the browser viewport to a specific width and height in pixels, such as 375 by 667 for a mobile device.",
    inputSchema: {
      type: "object",
      properties: {
        width: { type: "number" },
        height: { type: "number" },
      },
      required: ["width", "height"],
    },
  },
  {
    name: "uploadFile",
    description: "Set one or more file paths on a file input element.",
    inputSchema: {
      type: "object",
      properties: {
        ...locatorProp,
        filePaths: { type: "array", items: { type: "string" } },
      },
      required: ["locator", "filePaths"],
    },
  },
  {
    name: "download",
    description: "Click a download control and wait for a file download to complete.",
    inputSchema: { type: "object", properties: locatorProp, required: ["locator"] },
  },
  {
    name: "handleDialog",
    description:
      "Arms the browser's next native dialog (alert/confirm/prompt) to auto-accept or auto-dismiss. Call this BEFORE the action you expect to trigger the dialog.",
    inputSchema: {
      type: "object",
      properties: { behavior: { type: "string", enum: ["accept", "dismiss"] } },
      required: ["behavior"],
    },
  },
  {
    name: "waitFor",
    description: "Wait until an element becomes visible before continuing.",
    inputSchema: { type: "object", properties: locatorProp, required: ["locator"] },
  },
  {
    name: "burst",
    description:
      "Fire the same action count times, rapidly, back-to-back, with no waiting between repetitions — a single tool call instead of N separate turns. Only click, pressKey, check, and uncheck can be repeated this way.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["click", "pressKey", "check", "uncheck"] },
        ...locatorProp,
        count: { type: "number", description: "How many times to repeat, e.g. 5." },
        key: { type: "string", description: "Required when action is pressKey — the key to press each time." },
      },
      required: ["action", "locator", "count"],
    },
  },
  {
    name: "simulateFailure",
    description:
      "Arms the next network request matching a URL pattern to fail in a specific way instead of completing normally. Call this BEFORE the action you expect to trigger that request (e.g. before clicking Submit/Pay). Modes: 500/503/404 (fake error response, real server never sees the request), malformed (fake 200 with an invalid body), offline/connectionReset (the client's network drops before any response), timeout (the request genuinely reaches the server and completes there, but the response never reaches the page — the realistic shape of a request that succeeded server-side while the client thinks it failed).",
    inputSchema: {
      type: "object",
      properties: {
        urlPattern: { type: "string", description: "A glob pattern matching the request URL, e.g. '**/api/order' or '**checkout**'." },
        mode: { type: "string", enum: ["500", "503", "404", "malformed", "offline", "connectionReset", "timeout"] },
      },
      required: ["urlPattern", "mode"],
    },
  },
  {
    name: "simulateLatency",
    description:
      "Arms the next network request matching a URL pattern to wait before continuing. Use it before reload, navigation, or a submit action to test loading states and duplicate-action handling under a slow response. The delay is one-shot and measured in milliseconds.",
    inputSchema: {
      type: "object",
      properties: {
        urlPattern: { type: "string", description: "A glob pattern matching the request URL, e.g. '**/api/**' or '**checkout**'." },
        delayMs: { type: "number", description: "How long to delay the matching request in milliseconds, typically 2000-5000." },
      },
      required: ["urlPattern", "delayMs"],
    },
  },
  {
    name: "verifyExpectation",
    description:
      "Check one user expectation against a concrete signal caused by the current flow. The expectation index refers to the numbered expectation in the system prompt. Only use this after the current flow has performed the behavior described by the expectation; a read-only page or matching heading from an existing record does not prove that a create, submit, update, complete, or confirm operation happened. Translate the natural-language requirement into one observable condition: a locator is visible/hidden, contains exact text, has an exact input value, is checked/unchecked, is enabled/disabled, has an exact count, or the URL contains/equals a value. Use unknown only when the current flow reached the relevant behavior but no reliable signal can be identified; do not claim a result in plain text.",
    inputSchema: {
      type: "object",
      properties: {
        expectationIndex: { type: "number", description: "1-based expectation number from the system prompt." },
        assertion: { type: "string", enum: ["visible", "hidden", "containsText", "urlContains", "urlEquals", "value", "checked", "unchecked", "disabled", "enabled", "count", "unknown"] },
        locator: { ...locatorProp.locator },
        value: { type: "string", description: "Expected text, URL, or input value; required for containsText, urlContains, urlEquals, and value." },
        expectedCount: { type: "number", description: "Expected locator count; required for count." },
      },
      required: ["expectationIndex", "assertion"],
    },
  },
  {
    name: "flowComplete",
    description:
      "Call this when you have completed a full, meaningful flow — instead of responding with plain text.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "A short stable title for the behavior, ideally 3-8 words. Omit persona names, concrete data, and IDs.",
        },
        summary: {
          type: "string",
          description:
            "What you did and what outcome was reached, in one short stable sentence. Describe the behavior at a high level; omit persona names, concrete product names, order IDs, timestamps, and other run-specific values.",
        },
      },
      required: ["title", "summary"],
    },
  },
];

/** `activePage` is set only by actions that replace the browser's active page (a new tab, a
 * reopened browser) — the caller (agent loop, replay) must switch to it for subsequent actions. */
export interface ToolCallResult extends StepResult {
  activePage?: Page;
}

async function verifyExpectation(
  page: Page,
  expectationIndex: number,
  assertion: ExpectationAssertion,
  locatorInput: string | undefined,
  value: string | undefined,
  expectedCount: number | undefined,
): Promise<ToolCallResult> {
  let status: ExpectationObservation["status"] = "unknown";
  let detail = "No reliable observable signal was supplied.";
  const locator = locatorInput ? resolveLocator(page, locatorInput).first() : undefined;

  try {
    if (assertion === "visible" || assertion === "hidden") {
      if (!locatorInput || !locator) {
        detail = `The ${assertion} check needs a locator.`;
      } else {
        const isVisible = (await locator.count()) > 0 && await locator.isVisible();
        const passed = assertion === "visible" ? isVisible : !isVisible;
        status = passed ? "met" : "violated";
        detail = passed ? `Locator ${locatorInput} is ${assertion}.` : `Locator ${locatorInput} is not ${assertion}.`;
      }
    } else if (assertion === "containsText") {
      if (!locatorInput || value === undefined) {
        detail = "The containsText check needs both a locator and a value.";
      } else {
        const text = await locator!.textContent();
        const passed = text?.includes(value) ?? false;
        status = passed ? "met" : "violated";
        detail = passed ? `Locator ${locatorInput} contains the expected text.` : `Locator ${locatorInput} does not contain the expected text.`;
      }
    } else if (assertion === "urlContains" || assertion === "urlEquals") {
      if (value === undefined) {
        detail = `The ${assertion} check needs a value.`;
      } else {
        const currentUrl = page.url();
        const passed = assertion === "urlContains" ? currentUrl.includes(value) : currentUrl === value;
        status = passed ? "met" : "violated";
        detail = passed ? `Current URL satisfies ${assertion}.` : `Current URL does not satisfy ${assertion}.`;
      }
    } else if (assertion === "value") {
      if (!locatorInput || value === undefined) {
        detail = "The value check needs both a locator and a value.";
      } else {
        const actual = await locator!.inputValue();
        const passed = actual === value;
        status = passed ? "met" : "violated";
        detail = passed ? `Locator ${locatorInput} has the expected value.` : `Locator ${locatorInput} does not have the expected value.`;
      }
    } else if (assertion === "checked" || assertion === "unchecked") {
      if (!locatorInput) {
        detail = `The ${assertion} check needs a locator.`;
      } else {
        const checked = await locator!.isChecked();
        const passed = assertion === "checked" ? checked : !checked;
        status = passed ? "met" : "violated";
        detail = passed ? `Locator ${locatorInput} is ${assertion}.` : `Locator ${locatorInput} is not ${assertion}.`;
      }
    } else if (assertion === "disabled" || assertion === "enabled") {
      if (!locatorInput) {
        detail = `The ${assertion} check needs a locator.`;
      } else {
        const enabled = await locator!.isEnabled();
        const passed = assertion === "enabled" ? enabled : !enabled;
        status = passed ? "met" : "violated";
        detail = passed ? `Locator ${locatorInput} is ${assertion}.` : `Locator ${locatorInput} is not ${assertion}.`;
      }
    } else if (assertion === "count") {
      if (expectedCount === undefined || !Number.isSafeInteger(expectedCount) || expectedCount < 0) {
        detail = "The count check needs a non-negative integer expectedCount.";
      } else if (!locatorInput) {
        detail = "The count check needs a locator.";
      } else {
        const actual = await resolveLocator(page, locatorInput).count();
        const passed = actual === expectedCount;
        status = passed ? "met" : "violated";
        detail = passed ? `Locator count is ${expectedCount}.` : `Locator count is ${actual}, expected ${expectedCount}.`;
      }
    }
  } catch (error) {
    status = "unknown";
    detail = `Could not evaluate the signal: ${(error as Error).message}`;
  }

  const result = await toStepResult(page);
  return {
    ...result,
    expectation: { expectationIndex, status, assertion, locator: locatorInput, value, expectedCount, detail },
  };
}

export async function executeToolCall(page: Page, call: ToolCall): Promise<ToolCallResult> {
  const input = call.input;
  switch (call.name) {
    case "navigate":
      return actions.navigate(page, input.url as string);
    case "click":
      return actions.click(page, input.locator as string, input.button as actions.ClickButton | undefined, input.modifiers as actions.ClickModifier[] | undefined);
    case "doubleClick":
      return actions.doubleClick(page, input.locator as string, input.button as actions.ClickButton | undefined, input.modifiers as actions.ClickModifier[] | undefined);
    case "fill":
      return actions.fill(page, input.locator as string, input.value as string);
    case "select":
      return actions.select(page, input.locator as string, input.value as string | string[]);
    case "pressKey":
      return actions.pressKey(page, input.locator as string, input.key as string);
    case "check":
      return actions.check(page, input.locator as string);
    case "uncheck":
      return actions.uncheck(page, input.locator as string);
    case "hover":
      return actions.hover(page, input.locator as string);
    case "dragAndDrop":
      return actions.dragAndDrop(page, input.source as string, input.target as string);
    case "goBack":
      return actions.goBack(page);
    case "reload":
      return actions.reload(page);
    case "clearCookie":
      return actions.clearCookie(page, input.name as string | undefined);
    case "goForward":
      return actions.goForward(page);
    case "hardReload":
      return actions.hardReload(page);
    case "openInNewTab":
      return actions.openInNewTab(page);
    case "reopenBrowser":
      return actions.reopenBrowser(page);
    case "scroll":
      return actions.scroll(page, input.locator as string | undefined);
    case "setViewportSize":
      return actions.setViewportSize(page, input.width as number, input.height as number);
    case "uploadFile":
      return actions.uploadFile(page, input.locator as string, input.filePaths as string[]);
    case "download":
      return actions.download(page, input.locator as string);
    case "handleDialog":
      actions.handleDialog(page, input.behavior as "accept" | "dismiss");
      return toStepResult(page);
    case "waitFor":
      return actions.waitFor(page, input.locator as string);
    case "burst":
      return actions.burst(page, input.action as string, input.locator as string, input.count as number, input.key as string | undefined);
    case "simulateFailure":
      await actions.simulateFailure(page, input.urlPattern as string, input.mode as actions.FailureMode);
      return toStepResult(page);
    case "simulateLatency":
      await actions.simulateLatency(page, input.urlPattern as string, input.delayMs as number);
      return toStepResult(page);
    case "verifyExpectation":
      return verifyExpectation(
        page,
        input.expectationIndex as number,
        input.assertion as ExpectationAssertion,
        input.locator as string | undefined,
        input.value as string | undefined,
        input.expectedCount as number | undefined,
      );
    default:
      throw new Error(`Unknown tool: ${call.name}`);
  }
}
