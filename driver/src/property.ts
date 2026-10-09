export function isStringProperty(property: PropertyKey): property is string {
  return typeof property === 'string';
}
