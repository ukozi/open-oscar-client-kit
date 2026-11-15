const PLATFORM_TOKENS: Partial<Record<NodeJS.Platform, string>> = { darwin: 'MAC', win32: 'WIN32', linux: 'LINUX' };

export function platformToken(platform: NodeJS.Platform): string {
  return PLATFORM_TOKENS[platform] ?? platform.toUpperCase();
}

const build = (product: string, version: string, token: string): string => `${product}, version ${version}/${token}`;

export function clientIdFor(product: string, version: string, platform: NodeJS.Platform): string {
  return build(product, version, platformToken(platform));
}

export const FALLBACK_CLIENT_ID = build('OSCAR client', '0.0.0', 'UNKNOWN');
