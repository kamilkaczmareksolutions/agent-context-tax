import { TOKENIZER_ID } from "./tokenizer.js";

export type AgentId = "claude" | "codex" | "cursor";

export type ScanOptions = {
  cwd?: string;
  home?: string;
  codexHome?: string;
  walkRoot?: string;
};

export type RenderFormat = "human" | "json";

export type Truncation = {
  unit: "bytes" | "chars";
  kept: number;
  dropped: number;
};

export type SchemaEstimate = {
  tools: number | null;
  note: string;
};

export type DormantReason =
  | "suppressed-by-claude-md"
  | "below-cwd"
  | "nested"
  | "outside-cwd"
  | "paths"
  | "globs"
  | "path-scoped"
  | "manual"
  | "ignored-md"
  | "disabled"
  | "past-byte-cap";

type RowBase = {
  agent: AgentId;
  path: string;
  tokens: number;
  percent: number;
};

export type Row =
  | (RowBase & {
      inclusion: "startup";
      kind: "instruction";
      counted: "body";
      truncation: Truncation | null;
      legacy: boolean;
    })
  | (RowBase & {
      inclusion: "startup";
      kind: "rule";
      counted: "body" | "description";
    })
  | (RowBase & {
      inclusion: "startup";
      kind: "skill";
      counted: "description";
      manual: boolean;
      truncation: Truncation | null;
    })
  | (RowBase & {
      inclusion: "startup";
      kind: "mcp";
      counted: "server-name";
      estimate: SchemaEstimate;
    })
  | (RowBase & {
      inclusion: "dormant";
      kind: "instruction" | "rule" | "skill" | "mcp";
      reason: DormantReason;
    });

export type LargestItem = {
  agent: AgentId;
  path: string;
  tokens: number;
};

export type Duplicate = {
  agentsPath: string;
  claudePath: string;
  overlapPercentOfSmaller: number;
};

export type DeadItem = {
  agent: AgentId;
  path: string;
  why: "manual" | "ignored-md" | "legacy-cursorrules";
};

export type ManualListing = {
  agent: AgentId;
  path: string;
};

export type Trim = {
  largest: readonly LargestItem[];
  duplicates: readonly Duplicate[];
  dead: readonly DeadItem[];
  manualListings: readonly ManualListing[];
};

export type NotScanned = {
  agent: AgentId;
  topics: readonly string[];
};

export type AgentTotal = {
  agent: AgentId;
  measuredTokens: number;
  omittedDisabledSkills: number;
  rows: readonly Row[];
};

export type Report = {
  tokenizer: typeof TOKENIZER_ID;
  cwd: string;
  home: string;
  agents: readonly AgentTotal[];
  trim: Trim;
  notScanned: readonly NotScanned[];
};
