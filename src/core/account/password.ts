/** Password rules, shared by the app and the password-reset page. */

export const MIN_PASSWORD_LENGTH = 10;

export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (/^(.)\1+$/.test(password)) return 'That password is too easy to guess.';
  return null;
}

/** Rough strength from 0 (weak) to 4 (strong), for the meter under the field. */
export function passwordScore(password: string): number {
  if (!password) return 0;
  let pool = 0;
  if (/[a-z]/.test(password)) pool += 26;
  if (/[A-Z]/.test(password)) pool += 26;
  if (/[0-9]/.test(password)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(password)) pool += 33;
  const unique = new Set(password).size;
  const bits = Math.log2(Math.max(pool, 2)) * Math.min(password.length, unique * 2);
  if (password.length < MIN_PASSWORD_LENGTH) return Math.min(1, Math.floor(bits / 40));
  return bits < 45 ? 1 : bits < 60 ? 2 : bits < 80 ? 3 : 4;
}
