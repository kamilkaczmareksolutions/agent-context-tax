import { getEncoding } from "js-tiktoken";

export const TOKENIZER_ID = "o200k_base" as const;

const encoding = getEncoding(TOKENIZER_ID);

export function countTokens(text: string): number {
  return encoding.encode(text).length;
}
