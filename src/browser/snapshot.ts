import type { Page } from "playwright";
import type { StepResult } from "../types.js";

interface InteractiveElementObservation {
  tag: string;
  role?: string;
  name?: string;
  locator?: string;
  state: string[];
  placeholder?: string;
  href?: string;
  options?: string[];
  multiple?: boolean;
}

interface FrameObservation {
  title?: string;
  name?: string;
  src?: string;
  locator?: string;
}

interface PageObservation {
  accessibilityTree: string;
  interactiveElements: InteractiveElementObservation[];
  frames: FrameObservation[];
}

export async function captureSnapshot(page: Page): Promise<string> {
  const observation = await capturePageObservation(page);
  return formatPageObservation(observation);
}

export async function toStepResult(page: Page): Promise<StepResult> {
  return { url: page.url(), snapshot: await captureSnapshot(page) };
}

async function capturePageObservation(page: Page): Promise<PageObservation> {
  const [accessibilityTree, domObservation] = await Promise.all([
    page.locator("body").ariaSnapshot(),
    page.evaluate(() => {
      const selector = [
        "a",
        "button",
        "input",
        "select",
        "textarea",
        "summary",
        "[role]",
        "[tabindex]",
        "[contenteditable='true']",
        "[data-testid]",
        "[onclick]",
      ].join(",");
      const elements = Array.from(document.querySelectorAll(selector));
      const interactiveElements: InteractiveElementObservation[] = [];
      for (const element of elements) {
        const htmlElement = element as HTMLElement;
        const rect = htmlElement.getBoundingClientRect();
        const style = window.getComputedStyle(htmlElement);
        if (rect.width === 0 || rect.height === 0 || style.display === "none" || style.visibility === "hidden") continue;

        const tag = htmlElement.tagName.toLowerCase();
        const role = htmlElement.getAttribute("role") ?? implicitRole(htmlElement);
        const label = htmlElement.getAttribute("aria-label")?.trim();
        const associatedLabel = "labels" in htmlElement
          ? (htmlElement as HTMLInputElement).labels?.[0]?.textContent?.trim()
          : undefined;
        const placeholder = htmlElement.getAttribute("placeholder")?.trim();
        const text = tag === "select"
          ? Array.from((htmlElement as HTMLSelectElement).options).map((option) => option.text.trim()).filter(Boolean).join(" ")
          : htmlElement.textContent?.replace(/\s+/g, " ").trim();
        const name = clipText(label || associatedLabel || placeholder || text);
        const testId = htmlElement.getAttribute("data-testid")?.trim();
        const id = htmlElement.id.trim();
        const nameAttribute = htmlElement.getAttribute("name")?.trim();
        const rawHref = htmlElement.getAttribute("href")?.trim();
        const href = rawHref ? safeUrl(rawHref) : undefined;
        const cssLocator = stableCssLocator(tag, htmlElement.classList);
        const locator = testId
          ? `[data-testid=${JSON.stringify(testId)}]`
          : id
            ? `[id=${JSON.stringify(id)}]`
            : nameAttribute
              ? `${tag}[name=${JSON.stringify(nameAttribute)}]`
              : rawHref && tag === "a" && !/[?#]/.test(rawHref) && rawHref.length <= 200
                ? `a[href=${JSON.stringify(rawHref)}]`
                : name && text && text.length <= 100
                  ? `text=${JSON.stringify(name)}`
                  : cssLocator;
        const state: string[] = [];
        if ("disabled" in htmlElement && Boolean((htmlElement as HTMLButtonElement).disabled)) state.push("disabled");
        if (htmlElement.getAttribute("aria-disabled") === "true") state.push("disabled");
        if ("checked" in htmlElement && Boolean((htmlElement as HTMLInputElement).checked)) state.push("checked");
        if (htmlElement.getAttribute("aria-checked") === "true") state.push("checked");
        if (htmlElement.getAttribute("aria-expanded") !== null) state.push(`expanded=${htmlElement.getAttribute("aria-expanded")}`);
        if (htmlElement.hasAttribute("required")) state.push("required");

        const multiple = tag === "select" && (htmlElement as HTMLSelectElement).multiple;
        const options = tag === "select"
          ? Array.from((htmlElement as HTMLSelectElement).options).slice(0, 8).map((option) => `${option.text.trim()}=${option.value}${option.selected ? " (selected)" : ""}`)
          : undefined;
        interactiveElements.push({ tag, role, name, locator, state, placeholder, href, options, multiple: multiple || undefined });
      }

      const frames: FrameObservation[] = Array.from(document.querySelectorAll("iframe")).slice(0, 20).map((frame) => {
        const title = frame.title.trim() || undefined;
        const name = frame.name.trim() || undefined;
        const rawSrc = frame.getAttribute("src")?.trim() || undefined;
        const src = rawSrc ? safeUrl(rawSrc) : undefined;
        return {
          title,
          name,
          src,
          locator: title
            ? `iframe[title=${JSON.stringify(title)}]`
            : name
              ? `iframe[name=${JSON.stringify(name)}]`
              : rawSrc && !/[?#]/.test(rawSrc) && rawSrc.length <= 200
                ? `iframe[src=${JSON.stringify(rawSrc)}]`
                : undefined,
        };
      });
      return { interactiveElements: interactiveElements.slice(0, 80), frames };

      function implicitRole(element: HTMLElement): string | undefined {
        switch (element.tagName.toLowerCase()) {
          case "a": return element.hasAttribute("href") ? "link" : undefined;
          case "button": return "button";
          case "input": {
            const type = (element.getAttribute("type") || "text").toLowerCase();
            return type === "checkbox" ? "checkbox" : type === "radio" ? "radio" : type === "submit" ? "button" : "textbox";
          }
          case "select": return "combobox";
          case "textarea": return "textbox";
          case "summary": return "button";
          default: return undefined;
        }
      }

      function clipText(value: string | undefined): string | undefined {
        if (!value) return undefined;
        return value.length <= 100 ? value : `${value.slice(0, 97)}...`;
      }

      function stableCssLocator(tag: string, classes: DOMTokenList): string | undefined {
        const utilityPrefix = /^(?:2?xl|block|border|container|content|duration|ease|flex|font|gap|grid|h|hidden|inline|items|justify|leading|m|max|min|object|overflow|p|pointer|relative|rounded|shadow|space|sr|sticky|text|tracking|transition|w|z)(?:-|$)/i;
        const generatedClass = /^(?:css|emotion|jsx|sc|ng|mui|chakra)[-_]/i;
        const candidate = Array.from(classes).find((token) =>
          /^[A-Za-z][A-Za-z0-9_-]{1,79}$/.test(token)
          && !utilityPrefix.test(token)
          && !generatedClass.test(token)
          && !/[A-Fa-f0-9]{8,}/.test(token),
        );
        return candidate ? `${tag}[class~=${JSON.stringify(candidate)}]` : undefined;
      }

      function safeUrl(value: string): string {
        try {
          const parsed = new URL(value, window.location.href);
          return `${parsed.origin}${parsed.pathname}`;
        } catch {
          return value.slice(0, 200);
        }
      }
    }),
  ]);
  return { accessibilityTree, ...domObservation };
}

function formatPageObservation(observation: PageObservation): string {
  const interactive = observation.interactiveElements.length
    ? observation.interactiveElements.map((element) => {
      const identity = [element.role, element.name ? JSON.stringify(element.name) : undefined].filter(Boolean).join(" ");
      const locator = element.locator ? ` | locator: ${element.locator}` : "";
      const state = element.state.length ? ` | ${element.state.join(", ")}` : "";
      const placeholder = element.placeholder ? ` | placeholder: ${JSON.stringify(element.placeholder)}` : "";
      const href = element.href ? ` | href: ${element.href}` : "";
      const options = element.options?.length ? ` | options: ${element.options.join(", ")}` : "";
      const multiple = element.multiple ? " | multiple" : "";
      return `- ${identity || element.tag}${locator}${state}${placeholder}${href}${multiple}${options}`;
    }).join("\n")
    : "(none detected)";
  const frames = observation.frames.length
    ? observation.frames.map((frame) => `- iframe${frame.title ? ` title=${JSON.stringify(frame.title)}` : ""}${frame.name ? ` name=${JSON.stringify(frame.name)}` : ""}${frame.src ? ` src=${frame.src}` : ""}${frame.locator ? ` | frame selector: ${frame.locator}` : ""}`).join("\n")
    : "(none detected)";
  return `Accessibility tree:\n${observation.accessibilityTree}\n\nInteractive elements:\n${interactive}\n\nFrames:\n${frames}`;
}

export async function captureScreenshot(page: Page): Promise<string> {
  // JPEG at CSS scale keeps vision useful while avoiding a full-resolution PNG on every LLM turn.
  const buffer = await page.screenshot({ type: "jpeg", quality: 60, scale: "css" });
  return buffer.toString("base64");
}
