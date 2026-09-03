/** Shared login selectors and patterns used by runtime login and generated test helpers. */
export const LOGIN_CONTRACT = {
  triggerPattern: "log ?in|sign ?in",
  passwordSelector: 'input[type="password"]',
  usernameSelector: 'input[type="email"], input[autocomplete="username"], input[name="username"]',
  usernameFallbackSelector: 'input[type="text"], input:not([type])',
  formSelector: 'form:has(input[type="password"])',
  submitSelector: 'button[type="submit"], input[type="submit"]',
  loginRoutePattern: String.raw`(^|\/)login(?:\/|$)`,
} as const;
