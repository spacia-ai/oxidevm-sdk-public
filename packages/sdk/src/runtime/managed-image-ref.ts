/** The stable identity of a shared managed image base. */
export interface ManagedImageRef { readonly id: string; readonly version: string; readonly identity: string }
export function isManagedImageName(name: string): boolean { return /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/u.test(name); }
export function managedImageStem(image: ManagedImageRef): string { return `${image.id}-${image.version}-${image.identity}`; }
