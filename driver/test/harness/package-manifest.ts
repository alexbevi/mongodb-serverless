export const DEPENDENCY_FIELDS = [
  'dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'
] as const;

interface PackageManifest {
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

function isStringMap(value: unknown): value is Record<string, string> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    Object.values(value).every((entry): entry is string => typeof entry === 'string');
}

function assertManifest(value: unknown): asserts value is PackageManifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Package manifest must be an object');
  }

  if ('version' in value && typeof value.version !== 'string') {
    throw new TypeError('Package version must be a string');
  }

  for (const field of DEPENDENCY_FIELDS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);

    if (descriptor && !isStringMap(descriptor.value)) {
      throw new TypeError(`Package ${field} must map names to version strings`);
    }
  }
}

export function parseManifest(text: string): PackageManifest {
  const value: unknown = JSON.parse(text);
  assertManifest(value);

  return value;
}
