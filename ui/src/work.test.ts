import { describe, expect, it } from "vitest";
import { leadingZeros, solve } from "./work";
import vectors from "./work.vectors.json";

const sha = async (s: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));

describe("the proof of work", () => {
  it("accepts the vectors the server accepts (src/token.rs work_vectors)", async () => {
    for (const v of vectors) expect(leadingZeros(await sha(`${v.token}:${v.nonce}`), v.bits)).toBe(true);
  });
  it("finds a solution the server's rule passes", async () => {
    const nonce = await solve("a-session", 10);
    expect(leadingZeros(await sha(`a-session:${nonce}`), 10)).toBe(true);
    expect(nonce.length).toBeLessThanOrEqual(64);
  });
});
