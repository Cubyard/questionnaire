import { describe, expect, it } from "vitest";
import { validateAnswers, validatePoll, type Answers, type Question } from "../src/schema";
import { tally, toCsv } from "../src/results";

const questions: Question[] = [
  { id: "color", type: "single", title: "Favorite color?", required: true, options: ["Red", "Blue"], allowOther: true },
  { id: "pets", type: "multiple", title: "Pets?", required: false, options: ["Cat", "Dog", "Fish"], maxSelections: 2 },
  { id: "stars", type: "rating", title: "Rate us", required: true, max: 5 },
  { id: "nps", type: "scale", title: "Recommend?", required: false, min: 0, max: 10 },
  { id: "why", type: "paragraph", title: "Why?", required: false },
];

describe("validatePoll", () => {
  it("fills defaults and generates question ids", () => {
    const r = validatePoll({ title: "T", questions: [{ type: "text", title: "Name?" }] });
    expect(r.errors).toBeUndefined();
    expect(r.poll!.questions[0]).toMatchObject({ id: "q1", required: true });
    expect(r.poll!.status).toBe("draft");
    expect(r.poll!.settings).toEqual({ showResults: "after_submit", allowMultipleResponses: true });
  });

  it("rejects bad definitions with field paths", () => {
    const r = validatePoll({
      title: "",
      slug: "Bad Slug",
      questions: [{ type: "single", title: "x", options: ["a", "a"] }, { type: "nope", title: "y" }],
    });
    expect(Object.keys(r.errors!)).toEqual(
      expect.arrayContaining(["title", "slug", "questions[0].options", "questions[1].type"]),
    );
  });

  it("merges a partial update over the existing poll", () => {
    const base = validatePoll({ title: "T", slug: "keep-me", questions: [{ type: "text", title: "Q" }] }).poll!;
    const r = validatePoll({ status: "open", settings: { showResults: "public" } }, base);
    expect(r.poll).toMatchObject({ title: "T", slug: "keep-me", status: "open" });
    expect(r.poll!.settings.showResults).toBe("public");
  });

  it("validates an optional pinned theme", () => {
    const q = [{ type: "text", title: "Q" }];
    expect(validatePoll({ title: "T", questions: q, settings: { theme: { hue: 12, hue2: 200 } } }).poll!.settings.theme).toEqual({ hue: 12, hue2: 200 });
    expect(validatePoll({ title: "T", questions: q, settings: { theme: { hue: 400 } } }).errors!["settings.theme"]).toBeDefined();
  });

  it("rejects duplicate question ids", () => {
    const r = validatePoll({ title: "T", questions: [{ id: "a", type: "text", title: "1" }, { id: "a", type: "text", title: "2" }] });
    expect(r.errors!.questions).toMatch(/unique/);
  });
});

describe("validateAnswers", () => {
  it("accepts a valid set and drops unknown keys", () => {
    const r = validateAnswers(questions, { color: "Blue", pets: ["Cat", "Cat"], stars: 4, extra: "x" });
    expect(r.answers).toEqual({ color: "Blue", pets: ["Cat"], stars: 4 });
  });

  it("flags missing required answers and out-of-range values", () => {
    const r = validateAnswers(questions, { stars: 9, nps: 11, pets: ["Cat", "Dog", "Fish"] });
    expect(Object.keys(r.errors!).sort()).toEqual(["color", "nps", "pets", "stars"]);
  });

  it("allows one free-text other only when the question allows it", () => {
    expect(validateAnswers(questions, { color: "Green", stars: 3 }).answers).toBeDefined();
    expect(validateAnswers(questions, { color: "Blue", stars: 3, pets: ["Hamster"] }).errors!.pets).toBeDefined();
  });

  it("rejects non-integer ratings", () => {
    expect(validateAnswers(questions, { color: "Red", stars: 2.5 }).errors!.stars).toBeDefined();
  });
});

describe("tally", () => {
  const responses: Answers[] = [
    { color: "Red", stars: 5, why: "great", pets: ["Cat", "Dog"] },
    { color: "Green", stars: 3 },
    { color: "Red", stars: 4, nps: 9 },
  ];

  it("counts options, other, and averages", () => {
    const r = tally(questions, responses, false);
    expect(r.total).toBe(3);
    const color = r.questions[0];
    expect(color.options).toEqual([{ label: "Red", count: 2 }, { label: "Blue", count: 0 }]);
    expect(color.other).toEqual({ count: 1 });
    expect(r.questions[2].average).toBe(4);
    expect(r.questions[4]).toMatchObject({ answered: 1 });
    expect(r.questions[4].answers).toBeUndefined();
  });

  it("includes free text only for admins", () => {
    const r = tally(questions, responses, true);
    expect(r.questions[0].other!.answers).toEqual(["Green"]);
    expect(r.questions[4].answers).toEqual(["great"]);
  });
});

describe("toCsv", () => {
  it("quotes, joins lists, and neutralizes formulas", () => {
    const csv = toCsv(questions.slice(0, 2), [
      { id: "r1", createdAt: "2026-01-01T00:00:00.000Z", answers: { color: '=HYPERLINK("x")', pets: ["Cat", "Dog"] } },
    ]);
    const [, row] = csv.trim().split("\r\n");
    expect(row).toBe(`r1,2026-01-01T00:00:00.000Z,"'=HYPERLINK(""x"")",Cat; Dog`);
  });
});
