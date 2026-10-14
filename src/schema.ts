// Poll definitions and answer validation. Pure functions, no Worker APIs,
// so they can be unit tested in plain Node.

export type QuestionType = "single" | "multiple" | "text" | "paragraph" | "rating" | "scale";

export interface Question {
  id: string;
  type: QuestionType;
  title: string;
  description?: string;
  required: boolean;
  options?: string[];
  allowOther?: boolean;
  maxSelections?: number;
  max?: number;
  min?: number;
  minLabel?: string;
  maxLabel?: string;
}

export type ShowResults = "never" | "after_submit" | "public";

export interface PollSettings {
  showResults: ShowResults;
  allowMultipleResponses: boolean;
  maxResponses?: number;
  confirmationMessage?: string;
  /** Pins the poll's colors; otherwise they're derived from the slug. Hues are 0-359. */
  theme?: { hue: number; hue2?: number };
}

export interface PollInput {
  slug?: string;
  title: string;
  description?: string;
  questions: Question[];
  settings: PollSettings;
  status: "draft" | "open" | "closed";
  closesAt?: string | null;
}

export type Answers = Record<string, string | string[] | number>;

export type FieldErrors = Record<string, string>;

const TYPES: QuestionType[] = ["single", "multiple", "text", "paragraph", "rating", "scale"];
const STATUSES = ["draft", "open", "closed"] as const;
const SHOW_RESULTS: ShowResults[] = ["never", "after_submit", "public"];

export const LIMITS = {
  questions: 100,
  options: 50,
  titleLength: 300,
  descriptionLength: 4000,
  optionLength: 200,
  textAnswer: 500,
  paragraphAnswer: 5000,
};

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])?$/;
const QUESTION_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length > 0 && t.length <= max ? t : undefined;
}

function optionalStr(
  v: unknown,
  max: number,
  field: string,
  errors: FieldErrors,
): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const s = str(v, max);
  if (s === undefined) errors[field] = `must be a string up to ${max} characters`;
  return s;
}

function int(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) ? v : undefined;
}

function validateQuestion(raw: unknown, index: number, errors: FieldErrors): Question | undefined {
  const at = `questions[${index}]`;
  if (!isObject(raw)) {
    errors[at] = "must be an object";
    return undefined;
  }
  const id = raw.id === undefined ? `q${index + 1}` : raw.id;
  if (typeof id !== "string" || !QUESTION_ID_RE.test(id)) {
    errors[`${at}.id`] = "must be 1-40 letters, digits, _ or -";
  }
  const type = raw.type as QuestionType;
  if (!TYPES.includes(type)) {
    errors[`${at}.type`] = `must be one of ${TYPES.join(", ")}`;
    return undefined;
  }
  const title = str(raw.title, LIMITS.titleLength);
  if (!title) errors[`${at}.title`] = `is required, up to ${LIMITS.titleLength} characters`;
  const q: Question = {
    id: id as string,
    type,
    title: title ?? "",
    required: raw.required === undefined ? true : raw.required === true,
  };
  const description = optionalStr(raw.description, LIMITS.descriptionLength, `${at}.description`, errors);
  if (description) q.description = description;

  if (type === "single" || type === "multiple") {
    const options = raw.options;
    if (!Array.isArray(options) || options.length < 1 || options.length > LIMITS.options) {
      errors[`${at}.options`] = `must be a list of 1-${LIMITS.options} options`;
    } else {
      const clean = options.map((o) => str(o, LIMITS.optionLength));
      if (clean.some((o) => o === undefined)) {
        errors[`${at}.options`] = `each option must be a string up to ${LIMITS.optionLength} characters`;
      } else if (new Set(clean).size !== clean.length) {
        errors[`${at}.options`] = "options must be unique";
      } else {
        q.options = clean as string[];
      }
    }
    if (raw.allowOther === true) q.allowOther = true;
    if (type === "multiple" && raw.maxSelections !== undefined) {
      const m = int(raw.maxSelections);
      if (m === undefined || m < 1) errors[`${at}.maxSelections`] = "must be a positive integer";
      else q.maxSelections = m;
    }
  }

  if (type === "rating") {
    const max = raw.max === undefined ? 5 : int(raw.max);
    if (max === undefined || max < 2 || max > 10) errors[`${at}.max`] = "must be an integer from 2 to 10";
    else q.max = max;
  }

  if (type === "scale") {
    const min = raw.min === undefined ? 0 : int(raw.min);
    const max = raw.max === undefined ? 10 : int(raw.max);
    if (min === undefined || min < 0 || min > 1) errors[`${at}.min`] = "must be 0 or 1";
    if (max === undefined || max < 2 || max > 10) errors[`${at}.max`] = "must be an integer from 2 to 10";
    if (min !== undefined && max !== undefined) {
      q.min = min;
      q.max = max;
    }
    const minLabel = optionalStr(raw.minLabel, 60, `${at}.minLabel`, errors);
    const maxLabel = optionalStr(raw.maxLabel, 60, `${at}.maxLabel`, errors);
    if (minLabel) q.minLabel = minLabel;
    if (maxLabel) q.maxLabel = maxLabel;
  }
  return q;
}

/**
 * Validates a full poll definition. With `base`, the input is a partial update
 * merged over the existing poll first.
 */
export function validatePoll(
  input: unknown,
  base?: PollInput,
): { poll: PollInput; errors?: undefined } | { poll?: undefined; errors: FieldErrors } {
  const errors: FieldErrors = {};
  if (!isObject(input)) return { errors: { body: "must be a JSON object" } };
  const merged: Record<string, unknown> = base ? { ...base, ...input } : { ...input };
  if (base && isObject(input.settings)) merged.settings = { ...base.settings, ...input.settings };

  const title = str(merged.title, LIMITS.titleLength);
  if (!title) errors.title = `is required, up to ${LIMITS.titleLength} characters`;
  const description = optionalStr(merged.description, LIMITS.descriptionLength, "description", errors);

  let slug: string | undefined;
  if (merged.slug !== undefined && merged.slug !== null) {
    if (typeof merged.slug !== "string" || !SLUG_RE.test(merged.slug)) {
      errors.slug = "must be 3-64 lowercase letters, digits or hyphens";
    } else slug = merged.slug;
  }

  const status = merged.status === undefined ? "draft" : merged.status;
  if (!STATUSES.includes(status as (typeof STATUSES)[number])) {
    errors.status = `must be one of ${STATUSES.join(", ")}`;
  }

  let closesAt: string | null = null;
  if (merged.closesAt !== undefined && merged.closesAt !== null && merged.closesAt !== "") {
    const t = typeof merged.closesAt === "string" ? Date.parse(merged.closesAt) : NaN;
    if (Number.isNaN(t)) errors.closesAt = "must be an ISO 8601 date-time";
    else closesAt = new Date(t).toISOString();
  }

  const questions: Question[] = [];
  if (!Array.isArray(merged.questions) || merged.questions.length < 1) {
    errors.questions = "must be a list with at least one question";
  } else if (merged.questions.length > LIMITS.questions) {
    errors.questions = `at most ${LIMITS.questions} questions`;
  } else {
    merged.questions.forEach((raw, i) => {
      const q = validateQuestion(raw, i, errors);
      if (q) questions.push(q);
    });
    const ids = questions.map((q) => q.id);
    if (new Set(ids).size !== ids.length) errors.questions = "question ids must be unique";
  }

  const rawSettings = isObject(merged.settings) ? merged.settings : {};
  const showResults = (rawSettings.showResults ?? "after_submit") as ShowResults;
  if (!SHOW_RESULTS.includes(showResults)) {
    errors["settings.showResults"] = `must be one of ${SHOW_RESULTS.join(", ")}`;
  }
  const settings: PollSettings = {
    showResults,
    // Duplicates are fine by default; a poll can opt into one per browser.
    allowMultipleResponses: rawSettings.allowMultipleResponses !== false,
  };
  if (rawSettings.maxResponses !== undefined && rawSettings.maxResponses !== null) {
    const m = int(rawSettings.maxResponses);
    if (m === undefined || m < 1) errors["settings.maxResponses"] = "must be a positive integer";
    else settings.maxResponses = m;
  }
  const confirmation = optionalStr(
    rawSettings.confirmationMessage,
    1000,
    "settings.confirmationMessage",
    errors,
  );
  if (confirmation) settings.confirmationMessage = confirmation;
  if (rawSettings.theme !== undefined && rawSettings.theme !== null) {
    const t = rawSettings.theme;
    const hue = isObject(t) ? int(t.hue) : undefined;
    const hue2 = isObject(t) && t.hue2 !== undefined ? int(t.hue2) : undefined;
    const ok = (h: number | undefined) => h !== undefined && h >= 0 && h < 360;
    if (!ok(hue) || (isObject(t) && t.hue2 !== undefined && !ok(hue2))) {
      errors["settings.theme"] = "must be { hue: 0-359, hue2?: 0-359 }";
    } else settings.theme = hue2 === undefined ? { hue: hue! } : { hue: hue!, hue2 };
  }

  if (Object.keys(errors).length > 0) return { errors };
  return {
    poll: {
      slug,
      title: title!,
      description,
      questions,
      settings,
      status: status as PollInput["status"],
      closesAt,
    },
  };
}

/** Validates a respondent's answers against the poll's questions. */
export function validateAnswers(
  questions: Question[],
  input: unknown,
): { answers: Answers; errors?: undefined } | { answers?: undefined; errors: FieldErrors } {
  if (!isObject(input)) return { errors: { answers: "must be an object keyed by question id" } };
  const errors: FieldErrors = {};
  const answers: Answers = {};

  for (const q of questions) {
    const v = input[q.id];
    const empty =
      v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
    if (empty) {
      if (q.required) errors[q.id] = "This question needs an answer.";
      continue;
    }
    switch (q.type) {
      case "single": {
        const s = str(v, LIMITS.optionLength);
        if (s === undefined) errors[q.id] = "Pick one option.";
        else if (!q.options!.includes(s) && !q.allowOther) errors[q.id] = "That isn't one of the options.";
        else answers[q.id] = s;
        break;
      }
      case "multiple": {
        if (!Array.isArray(v)) {
          errors[q.id] = "Pick one or more options.";
          break;
        }
        const picks = v.map((x) => str(x, LIMITS.optionLength));
        const unique = [...new Set(picks)];
        const others = unique.filter((p) => p !== undefined && !q.options!.includes(p));
        if (picks.some((p) => p === undefined)) errors[q.id] = "Each choice must be text.";
        else if (others.length > (q.allowOther ? 1 : 0)) errors[q.id] = "That isn't one of the options.";
        else if (q.maxSelections && unique.length > q.maxSelections)
          errors[q.id] = `Pick at most ${q.maxSelections}.`;
        else answers[q.id] = unique as string[];
        break;
      }
      case "text":
      case "paragraph": {
        const max = q.type === "text" ? LIMITS.textAnswer : LIMITS.paragraphAnswer;
        const s = str(v, max);
        if (s === undefined) errors[q.id] = `Keep it under ${max} characters.`;
        else answers[q.id] = s;
        break;
      }
      case "rating":
      case "scale": {
        const n = int(v);
        const min = q.type === "rating" ? 1 : q.min!;
        if (n === undefined || n < min || n > q.max!) errors[q.id] = `Pick a number from ${min} to ${q.max}.`;
        else answers[q.id] = n;
        break;
      }
    }
  }
  if (Object.keys(errors).length > 0) return { errors };
  return { answers };
}
