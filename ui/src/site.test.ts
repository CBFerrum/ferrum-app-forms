import { describe, expect, it } from "vitest";
import { accentVars, contrast, hexOf } from "./accent";
import { closedState, formPath, loginPath, resultPath, safeRedirect } from "./site";

describe("a form's address", () => {
  it("names the workspace and the form", () => {
    expect(formPath("acme", "spring-survey")).toBe("/forms/f/acme/spring-survey");
    expect(resultPath("acme", "quiz", "a_b-c")).toBe("/forms/f/acme/quiz/result/a_b-c");
    expect(loginPath("/forms/f/acme/x?a=1")).toBe("/login?next=%2Fforms%2Ff%2Facme%2Fx%3Fa%3D1");
  });

  it("sends people on to web addresses only", () => {
    expect(safeRedirect("https://example.com/thanks?x=1")).toBe("https://example.com/thanks?x=1");
    expect(safeRedirect("http://example.com")).toBe("http://example.com/");
    expect(safeRedirect("javascript:alert(1)")).toBeNull();
    expect(safeRedirect("data:text/html,hi")).toBeNull();
    expect(safeRedirect("//evil.test")).toBeNull();
    expect(safeRedirect(null)).toBeNull();
    expect(safeRedirect("  ")).toBeNull();
  });
});

describe("why a form is not open", () => {
  it("reads the server's reasons", () => {
    expect(closedState("This form is not accepting responses.").title).toBe("This form is closed");
    expect(closedState("This form has reached its response limit.").title).toBe("This form is full");
    const soon = closedState("This form opens at 2026-11-02T09:00:00Z.");
    expect(soon.title).toBe("This form is not open yet");
    expect(soon.opensAt?.toISOString()).toBe("2026-11-02T09:00:00.000Z");
    expect(closedState("See you next year").body).toBe("See you next year");
  });
});

describe("a form's colour", () => {
  it("keeps any colour readable under its buttons", () => {
    expect(hexOf("#ABC")).toBe("#aabbcc");
    expect(hexOf("red")).toBeNull();
    expect(accentVars("not a colour")).toBeUndefined();
    for (const c of ["#ffff00", "#30a67d", "#000080", "#ffffff", "#ff0000"]) {
      const v = accentVars(c)!;
      const [light, dark] = /light-dark\((#[0-9a-f]{6}), (#[0-9a-f]{6})\)/.exec(v["--primary"])!.slice(1);
      expect(contrast(light, "#ffffff"), c).toBeGreaterThanOrEqual(4.5);
      expect(contrast(dark, "#0b1020"), c).toBeGreaterThanOrEqual(4.5);
      expect(v["--primary-text"]).toContain("#ffffff");
    }
  });
});
