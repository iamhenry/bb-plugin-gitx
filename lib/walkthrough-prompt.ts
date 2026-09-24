// Adapted from OpenChamber's guided change prompt. A walkthrough explains code; it is not a review verdict.
export const DEFAULT_WALKTHROUGH_PROMPT = `Guide the reader through this code change in an order that makes sense, rather than file-path order.
Group related diff hunks across files into short stops. Explain what behavior changes and why the hunks belong together.
Use only the supplied hunk identifiers. Do not invent code, guess intent, or paraphrase syntax changes that the reader can already see.
Write plain sentences without markdown. Leave mechanical hunks out of the guide; the reader can inspect them separately.`;
