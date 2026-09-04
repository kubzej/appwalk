export type ExpectationStatus = 'met' | 'violated' | 'unknown';

export type ExpectationAssertion =
  | 'visible'
  | 'hidden'
  | 'containsText'
  | 'urlContains'
  | 'urlEquals'
  | 'value'
  | 'checked'
  | 'unchecked'
  | 'disabled'
  | 'enabled'
  | 'count'
  | 'unknown';

export interface ExpectationObservation {
  expectationIndex: number;
  status: ExpectationStatus;
  assertion: ExpectationAssertion;
  locator?: string;
  value?: string;
  expectedCount?: number;
  detail: string;
}

export interface StepResult {
  url: string;
  snapshot: string;
  expectation?: ExpectationObservation;
}
