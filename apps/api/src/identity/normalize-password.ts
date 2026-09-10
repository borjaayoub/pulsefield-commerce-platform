export function normalizePassword(password: string): string {
  return password.normalize('NFC');
}
