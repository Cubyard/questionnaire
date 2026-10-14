import type { Answers, Question } from "./schema";

export interface QuestionResult {
  id: string;
  type: Question["type"];
  title: string;
  answered: number;
  options?: { label: string; count: number }[];
  other?: { count: number; answers?: string[] };
  distribution?: { value: number; count: number }[];
  average?: number | null;
  answers?: string[];
}

export interface PollResults {
  total: number;
  questions: QuestionResult[];
}

/**
 * Tallies responses per question. `includeText` controls whether free-text
 * answers (text, paragraph, "other") are returned: admins get them, the
 * public results view only gets counts.
 */
export function tally(questions: Question[], responses: Answers[], includeText: boolean): PollResults {
  const out = questions.map((q): QuestionResult => {
    const r: QuestionResult = { id: q.id, type: q.type, title: q.title, answered: 0 };
    const otherTexts: string[] = [];

    if (q.type === "single" || q.type === "multiple") {
      const counts = new Map((q.options ?? []).map((o) => [o, 0]));
      let other = 0;
      for (const a of responses) {
        const v = a[q.id];
        if (v === undefined) continue;
        r.answered++;
        for (const pick of Array.isArray(v) ? v : [v]) {
          const p = String(pick);
          if (counts.has(p)) counts.set(p, counts.get(p)! + 1);
          else {
            other++;
            otherTexts.push(p);
          }
        }
      }
      r.options = [...counts].map(([label, count]) => ({ label, count }));
      if (q.allowOther || other > 0) {
        r.other = { count: other };
        if (includeText) r.other.answers = otherTexts;
      }
    } else if (q.type === "rating" || q.type === "scale") {
      const min = q.type === "rating" ? 1 : (q.min ?? 0);
      const max = q.max ?? (q.type === "rating" ? 5 : 10);
      const dist = new Map<number, number>();
      for (let i = min; i <= max; i++) dist.set(i, 0);
      let sum = 0;
      for (const a of responses) {
        const v = a[q.id];
        if (typeof v !== "number") continue;
        r.answered++;
        sum += v;
        dist.set(v, (dist.get(v) ?? 0) + 1);
      }
      r.distribution = [...dist].map(([value, count]) => ({ value, count }));
      r.average = r.answered > 0 ? Math.round((sum / r.answered) * 100) / 100 : null;
    } else {
      for (const a of responses) {
        const v = a[q.id];
        if (typeof v !== "string") continue;
        r.answered++;
        otherTexts.push(v);
      }
      if (includeText) r.answers = otherTexts;
    }
    return r;
  });
  return { total: responses.length, questions: out };
}

function csvCell(v: unknown): string {
  let s = v === undefined || v === null ? "" : Array.isArray(v) ? v.join("; ") : String(v);
  // Keep spreadsheet apps from evaluating a cell as a formula.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(
  questions: Question[],
  rows: { id: string; createdAt: string; answers: Answers }[],
): string {
  const header = ["response_id", "submitted_at", ...questions.map((q) => q.title)];
  const lines = [header.map(csvCell).join(",")];
  for (const row of rows) {
    lines.push([row.id, row.createdAt, ...questions.map((q) => row.answers[q.id])].map(csvCell).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}
