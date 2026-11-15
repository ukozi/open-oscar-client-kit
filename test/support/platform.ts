/** A path `relative()` gave, with Windows separators turned to `/`. */
export const toPosix = (path: string): string => path.replaceAll('\\', '/');
