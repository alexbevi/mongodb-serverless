export function isStringProperty(property: PropertyKey): property is string {
  return typeof property === 'string';
}

export function hasProperty<T extends object>(target: T, property: PropertyKey): property is keyof T {
  return property in target;
}
