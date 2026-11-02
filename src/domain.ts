import { type AgentId, type DormantReason, type Truncation } from "./types.js";

export type ArtifactLocation = "in-scope" | "below-cwd" | "nested" | "outside-cwd";

export type CountedText = "body" | "description" | "server-name";

export type ClauseLoad =
  | {
      inclusion: "startup";
      counted: CountedText;
      manual: boolean;
      legacy: boolean;
    }
  | {
      inclusion: "dormant";
      reason: DormantReason;
      tokens: "text";
      counted: CountedText;
    }
  | {
      inclusion: "dormant";
      reason: DormantReason;
      tokens: "zero";
    }
  | { inclusion: "omit" };

export type LocationRule = "in-scope" | "below-cwd-only" | "root-only" | "in-scope-if-cwd-inside";

export type ConfigId =
  | "claude-user-json"
  | "claude-project-mcp"
  | "codex-user-toml"
  | "codex-project-toml"
  | "cursor-user-mcp"
  | "cursor-project-mcp";

export type ConfigFormat = "claude-user-json" | "mcp-json" | "codex-toml";

export type Root =
  | {
      kind: "files";
      from: "cwd-up";
      path: string;
      glob: string;
      location: LocationRule;
      stop: "walk-root" | "project-root";
    }
  | {
      kind: "files";
      from: "cwd-down" | "repo";
      path: string;
      glob: string;
      location: LocationRule;
    }
  | {
      kind: "files";
      from: "home" | "codex-home";
      path: string;
      glob: string;
      location: LocationRule;
    }
  | {
      kind: "files";
      from: "absolute";
      path: string;
      glob: string;
      location: LocationRule;
      when: "linux";
    }
  | { kind: "codex-global-doc" }
  | { kind: "codex-project-docs" }
  | {
      kind: "config";
      id: ConfigId;
      base: "home" | "codex-home" | "project-root";
      path: string;
      format: ConfigFormat;
    };

export type SkillTextPolicy = {
  fields: readonly ("name" | "description" | "whenToUse")[];
  charCap: number | null;
};

export type Budget =
  | {
      agent: "claude";
      instructionMode: "claude-md-or-agents-md";
      skillText: SkillTextPolicy;
    }
  | {
      agent: "codex";
      projectDocMaxBytes: number;
      fallbackFilenames: readonly string[];
      skillText: SkillTextPolicy;
    }
  | { agent: "cursor"; skillText: SkillTextPolicy };

export type CodexOverrides = {
  projectDocMaxBytes: number | null;
  fallbackFilenames: readonly string[] | null;
  disabledSkillPaths: readonly string[];
};

export type McpServer = {
  configPath: string;
  name: string;
  enabled: boolean;
  enabledToolCount: number | null;
};

export type InstructionArtifact = {
  type: "instruction";
  agent: AgentId;
  path: string;
  basename: string;
  location: ArtifactLocation;
  suppressed: boolean;
  pastCap: boolean;
  legacy: boolean;
  text: string;
  truncation: Truncation | null;
};

export type RuleArtifact = {
  type: "rule";
  agent: AgentId;
  path: string;
  extension: "md" | "mdc";
  alwaysApply: boolean;
  description: string | null;
  globs: string | null;
  paths: string | null;
  body: string;
};

export type SkillArtifact = {
  type: "skill";
  agent: AgentId;
  path: string;
  name: string;
  description: string;
  whenToUse: string | null;
  manual: boolean;
  pathScoped: boolean;
  enabled: boolean;
  location: ArtifactLocation;
};

export type McpArtifact = {
  type: "mcp";
  agent: AgentId;
  configPath: string;
  name: string;
  enabled: boolean;
  enabledToolCount: number | null;
};

export type Artifact = InstructionArtifact | RuleArtifact | SkillArtifact | McpArtifact;

export type ClaudeInstructionKey = "counted" | "suppressed" | "below-cwd";
export type CodexInstructionKey = "counted" | "past-cap";
export type CursorInstructionKey = "root" | "legacy-root" | "nested";

export type ClaudeRuleKey = "paths" | "always";
export type CursorRuleKey = "ignored-md" | "always-apply" | "globs" | "requestable" | "manual";

export type ClaudeSkillKey = "below-cwd" | "listed-manual" | "listed-auto";
export type CodexSkillKey = "disabled" | "listed-manual" | "listed-auto";
export type CursorSkillKey = "outside-cwd" | "path-scoped" | "listed-manual" | "listed-auto";

export type McpKey = "enabled" | "disabled";

export type ScanContext = {
  cwd: string;
  home: string;
  codexHome: string;
  walkRoot: string;
  projectRoot: string;
};
