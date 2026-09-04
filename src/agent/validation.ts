import type { ToolDefinition } from '../providers/provider.js';

type Schema = Record<string, unknown>;

/** Maximum size for any string supplied in a single tool input unless a schema sets a smaller limit. */
const DEFAULT_MAX_STRING_LENGTH = 20_000;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function schemaTypeMatches(value: unknown, type: string): boolean {
  switch (type) {
    case 'object':
      return isObject(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isSafeInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return true;
  }
}

function validateSchema(value: unknown, schema: Schema, path: string, errors: string[]): void {
  const anyOf = schema.anyOf;
  if (Array.isArray(anyOf)) {
    const matches = anyOf.some((candidate) => {
      const candidateErrors: string[] = [];
      if (isObject(candidate)) validateSchema(value, candidate, path, candidateErrors);
      return candidateErrors.length === 0;
    });
    if (!matches) errors.push(`${path} does not match any allowed shape.`);
    return;
  }

  const type = schema.type;
  if (typeof type === 'string' && !schemaTypeMatches(value, type)) {
    errors.push(`${path} must be a ${type}.`);
    return;
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    errors.push(`${path} must be one of ${schema.enum.map(String).join(', ')}.`);
    return;
  }

  if (typeof value === 'string') {
    const maxLength = typeof schema.maxLength === 'number' ? schema.maxLength : DEFAULT_MAX_STRING_LENGTH;
    if (value.length > maxLength) errors.push(`${path} must be at most ${maxLength} characters.`);
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      errors.push(`${path} must be at least ${schema.minLength} characters.`);
    }
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum)
      errors.push(`${path} must be at least ${schema.minimum}.`);
    if (typeof schema.maximum === 'number' && value > schema.maximum)
      errors.push(`${path} must be at most ${schema.maximum}.`);
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      errors.push(`${path} must contain at least ${schema.minItems} item(s).`);
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      errors.push(`${path} must contain at most ${schema.maxItems} item(s).`);
    }
    if (isObject(schema.items)) {
      value.forEach((item, index) => validateSchema(item, schema.items as Schema, `${path}[${index}]`, errors));
    }
  }

  if (isObject(value) && type === 'object') {
    const properties = isObject(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === 'string')
      : [];
    for (const key of required) {
      if (!(key in value)) errors.push(`${path}.${key} is required.`);
    }
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined && !required.includes(key)) continue;
      const childSchema = properties[key];
      if (childSchema === undefined) {
        if (isObject(schema.additionalProperties)) {
          validateSchema(child, schema.additionalProperties, `${path}.${key}`, errors);
        } else if (schema.additionalProperties !== true) {
          errors.push(`${path}.${key} is not allowed.`);
        }
        continue;
      }
      if (isObject(childSchema)) validateSchema(child, childSchema, `${path}.${key}`, errors);
    }
  }
}

/**
 * Validates untrusted provider output before it reaches tool dispatch. The provider-facing JSON
 * schema is the single source of truth for types, enums, required fields, and collection limits;
 * action functions retain only checks that depend on live browser or filesystem state.
 */
export function validateToolInput(definition: ToolDefinition, input: unknown): Record<string, unknown> {
  const errors: string[] = [];
  validateSchema(input, definition.inputSchema, '$', errors);
  if (errors.length > 0) {
    throw new Error(`Invalid input for tool "${definition.name}": ${errors.join(' ')}`);
  }
  return input as Record<string, unknown>;
}
