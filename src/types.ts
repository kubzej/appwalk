export type ExpectationStatus = "met" | "violated" | "unknown";

export type ExpectationAssertion = "visible" | "hidden" | "containsText" | "urlContains" | "urlEquals" | "unknown";

export interface ExpectationObservation {
  expectationIndex: number;
  status: ExpectationStatus;
  assertion: ExpectationAssertion;
  locator?: string;
  value?: string;
  detail: string;
}

export interface StepResult {
  url: string;
  snapshot: string;
  expectation?: ExpectationObservation;
}
