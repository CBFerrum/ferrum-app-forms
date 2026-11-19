// The small proof of work a form may ask before a response is sent (src/token.rs `work_done`): a nonce whose
// SHA-256 of `token:nonce` starts with `bits` zero bits. Done in the page, a few hundred milliseconds at the server's
// default; no outside service is asked.

/** Whether `digest` starts with `bits` zero bits. */
export function leadingZeros(digest: Uint8Array, bits: number): boolean {
  let left = bits;
  for (const byte of digest) {
    if (left <= 0) return true;
    const take = Math.min(left, 8);
    if (byte >> (8 - take) !== 0) return false;
    left -= take;
  }
  return left <= 0;
}

/** A nonce that solves `token` at `bits` (decimal digits, as the server reads any text of at most 64 characters). */
export async function solve(token: string, bits: number): Promise<string> {
  const enc = new TextEncoder();
  for (let n = 0; ; n++) {
    const nonce = String(n);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(`${token}:${nonce}`)));
    if (leadingZeros(digest, bits)) return nonce;
  }
}
