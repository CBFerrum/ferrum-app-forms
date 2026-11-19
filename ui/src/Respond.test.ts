import { describe, expect, it } from "vitest";
import type { Opened } from "./model";
import { responseBody } from "./Respond";

const opened = (more: Partial<Opened>): Opened => ({ form: {} as Opened["form"], token: "t", prefill: {}, ...more });

describe("what a response sends", () => {
  it("sends the link's hidden values, the prefill token and the work", () => {
    const body = responseBody(opened({ hidden: { utm_source: "mail" }, prefill_token: "p.v1.x" }), "t", { a: 1 }, "", "42");
    expect(body).toEqual({ token: "t", answers: { a: 1 }, honeypot: "", hidden: { utm_source: "mail" }, prefill_token: "p.v1.x", work: "42" });
  });
  it("sends nothing it was not given", () => {
    expect(responseBody(opened({ hidden: {} }), "t", {}, "")).toEqual({ token: "t", answers: {}, honeypot: "" });
  });
});
