import { describe, expect, it } from "vitest";
import { answerKeys, compile, Dbl, holds, quote, toVal } from "./cel";

const answers = toVal({
  country: "IN",
  age: 20,
  budget: new Dbl(1500.5),
  colors: ["red", "blue"],
  agree: true,
  grid: { Speed: "Good" },
  name: null,
});
const vars = { answers, today: "2026-10-29", now: "2026-10-29T10:00:00+05:30" };
const run = (src: string, a = answers) => {
  const p = compile(src);
  expect(p, src).not.toBeNull();
  return holds(p!, { ...vars, answers: a });
};

describe("a condition, as the server reads it", () => {
  it("evaluates over answers (the cases of src/logic.rs)", () => {
    expect(run("answers.country == 'IN' && answers.age >= 18")).toBe(true);
    expect(run("answers.age < 18")).toBe(false);
    expect(run("answers.budget > 1000.0")).toBe(true);
    expect(run("'red' in answers.colors && size(answers.colors) == 2")).toBe(true);
    expect(run("answers.colors.exists(c, c == 'blue')")).toBe(true);
    expect(run("answers.agree")).toBe(true);
    expect(run("answers.grid['Speed'] == 'Good'")).toBe(true);
    expect(run("answers['country'] == 'IN'")).toBe(true);
    expect(run("answers.name == null")).toBe(true);
    expect(run("today == '2026-10-29'")).toBe(true);
  });

  it("counts an error as false, and a result that is not true or false as false", () => {
    expect(run("answers.name > 3"), "null compared with a number").toBe(false);
    expect(run("!(answers.name > 3)"), "an error stays an error under !").toBe(false);
    expect(run("answers.country"), "a text is not a condition").toBe(false);
    expect(run("answers.grid['Price'] == 'Good'"), "a row nobody answered").toBe(false);
    expect(run("answers.name.startsWith('a')")).toBe(false);
  });

  it("lets one side decide when the other fails, like the server", () => {
    expect(run("answers.name > 3 || answers.age > 18")).toBe(true);
    expect(run("answers.age > 18 || answers.name > 3")).toBe(true);
    expect(run("answers.name > 3 && false")).toBe(false);
    expect(run("answers.name > 3 || false"), "false or an error is an error").toBe(false);
    expect(run("answers.age > 18 && answers.name > 3")).toBe(false);
  });

  it("compares numbers across ints and doubles, and nothing else across types", () => {
    expect(run("answers.age == 20.0")).toBe(true);
    expect(run("answers.age > 19.5")).toBe(true);
    expect(run("answers.country == 20"), "different types are not equal, and that is no error").toBe(false);
    expect(run("answers.country != 20")).toBe(true);
    expect(run("answers.name != 'x'"), "an unanswered question is not equal to anything").toBe(true);
  });

  it("does arithmetic, strings, lists and the ternary", () => {
    expect(run("answers.age / 3 == 6")).toBe(true);
    expect(run("answers.age % 7 == 6")).toBe(true);
    expect(run("answers.budget / 2 == 750.25")).toBe(true);
    expect(run("answers.age / 0 == 1")).toBe(false);
    expect(run("answers.country + 'x' == 'INx'")).toBe(true);
    expect(run("size(answers.country) == 2 && answers.country.startsWith('I') && answers.country.endsWith('N')")).toBe(true);
    expect(run("answers.country.contains('N') && answers.country.matches('^I.$')")).toBe(true);
    expect(run("answers.age > 10 ? answers.agree : false")).toBe(true);
    expect(run("answers.colors.all(c, c.size() >= 3) && answers.colors.exists_one(c, c == 'red')")).toBe(true);
    expect(run("answers.colors.filter(c, c != 'red').size() == 1 && answers.colors.map(c, c.size())[0] == 3")).toBe(true);
    expect(run("[1, 2, 3].all(x, x > 0) && has(answers.country) && !(answers.age in [1, 2])")).toBe(true);
    expect(run("{'a': 1}['a'] == 1 && 'a' in {'a': 1}")).toBe(true);
    expect(run("int('42') == 42 && double(2) == 2.0 && string(7) == '7' && int(2.9) == 2")).toBe(true);
  });

  it("reads strings the way CEL writes them", () => {
    expect(run("answers.country == \"IN\"")).toBe(true);
    expect(run("'it\\'s' == \"it's\"")).toBe(true);
    expect(run("r'a\\nb' == 'a\\\\nb'")).toBe(true);
    expect(run("'''two\nlines''' == 'two\\nlines'")).toBe(true);
    expect(run("'\\u00e9' == 'é'")).toBe(true);
    expect(run("0x10 == 16 && 1e2 == 100.0 && 3u == 3")).toBe(true);
    expect(run("answers.age > 18 // an adult")).toBe(true);
  });

  it("says when it cannot run a condition, so the question stays shown", () => {
    expect(run("timestamp(now) > timestamp('2026-01-01T00:00:00Z')")).toBeUndefined();
    expect(run("answers.country.lowerAscii() == 'in'")).toBeUndefined();
    expect(compile("answers.age >=")).toBeNull();
    expect(compile("answers.age && ) 3")).toBeNull();
    expect(compile("b'bytes' == b'bytes'")).toBeNull();
    expect(compile("(".repeat(100))).toBeNull();
  });

  it("lists the questions a condition reads", () => {
    const keys = (s: string) => answerKeys(compile(s)!);
    expect(keys("answers.a == 1 && answers['b'] != null || has(answers.c)")).toEqual(["a", "b", "c"]);
    expect(keys("answers.colors.exists(c, c == answers.pick)")).toEqual(["colors", "pick"]);
    expect(keys("today > '2026-01-01'")).toEqual([]);
    expect(keys("answers.a == answers.a")).toEqual(["a"]);
  });

  it("quotes text for a condition", () => {
    expect(quote("Don't")).toBe("'Don\\'t'");
    expect(quote("a\\b\nc")).toBe("'a\\\\b\\nc'");
    expect(run(`answers.country == ${quote("IN")}`)).toBe(true);
    expect(holds(compile(`${quote("it's \\ ok")} == "it's \\\\ ok"`)!, vars)).toBe(true);
  });
});
