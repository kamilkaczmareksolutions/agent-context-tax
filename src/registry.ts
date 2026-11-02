import { type AgentId, type SchemaEstimate } from "./types.js";
import {
  type Artifact,
  type Budget,
  type ClauseLoad,
  type ClaudeInstructionKey,
  type ClaudeRuleKey,
  type ClaudeSkillKey,
  type CodexInstructionKey,
  type CodexOverrides,
  type CodexSkillKey,
  type CursorInstructionKey,
  type CursorRuleKey,
  type CursorSkillKey,
  type InstructionArtifact,
  type McpArtifact,
  type McpKey,
  type Root,
  type RuleArtifact,
  type SkillArtifact,
  type SkillTextPolicy,
} from "./domain.js";

export const LARGEST_LIMIT = 5;

const CLAUDE_MCP_NOTE =
  "estimate: tool schemas not fetched; Claude tool search defers schemas by default (https://code.claude.com/docs/en/mcp). Count is the server name only.";

const NAME_ONLY_NOTE = "estimate: tool schemas not fetched. Count is the server name only.";

const ENABLED_TOOLS_NOTE = "lower bound from enabled_tools; schemas not fetched";

const claudeSkillText: SkillTextPolicy = {
  fields: ["name", "description", "whenToUse"],
  charCap: 1536,
};

const nameAndDescription: SkillTextPolicy = {
  fields: ["name", "description"],
  charCap: null,
};

const mcpLoads: Record<McpKey, ClauseLoad> = {
  enabled: { inclusion: "startup", counted: "server-name", manual: false, legacy: false },
  disabled: {
    inclusion: "dormant",
    reason: "disabled",
    tokens: "text",
    counted: "server-name",
  },
};

export type ClaudePolicy = {
  agent: "claude";
  budget: Extract<Budget, { agent: "claude" }>;
  sources: readonly Root[];
  notScanned: readonly string[];
  mcpNameOnlyNote: string;
  mcpEnabledToolsNote: null;
  instructionLoads: Record<ClaudeInstructionKey, ClauseLoad>;
  ruleLoads: Record<ClaudeRuleKey, ClauseLoad>;
  skillLoads: Record<ClaudeSkillKey, ClauseLoad>;
  mcpLoads: Record<McpKey, ClauseLoad>;
};

export type CodexPolicy = {
  agent: "codex";
  budget: Extract<Budget, { agent: "codex" }>;
  sources: readonly Root[];
  notScanned: readonly string[];
  mcpNameOnlyNote: string;
  mcpEnabledToolsNote: string;
  instructionLoads: Record<CodexInstructionKey, ClauseLoad>;
  skillLoads: Record<CodexSkillKey, ClauseLoad>;
  mcpLoads: Record<McpKey, ClauseLoad>;
};

export type CursorPolicy = {
  agent: "cursor";
  budget: Extract<Budget, { agent: "cursor" }>;
  sources: readonly Root[];
  notScanned: readonly string[];
  mcpNameOnlyNote: string;
  mcpEnabledToolsNote: null;
  instructionLoads: Record<CursorInstructionKey, ClauseLoad>;
  ruleLoads: Record<CursorRuleKey, ClauseLoad>;
  skillLoads: Record<CursorSkillKey, ClauseLoad>;
  mcpLoads: Record<McpKey, ClauseLoad>;
};

export type AgentPolicy = ClaudePolicy | CodexPolicy | CursorPolicy;

const claudeSources: readonly Root[] = [
  { kind: "files", from: "cwd-up", path: ".", glob: "CLAUDE.md", location: "in-scope", stop: "walk-root" },
  {
    kind: "files",
    from: "cwd-up",
    path: ".",
    glob: "CLAUDE.local.md",
    location: "in-scope",
    stop: "walk-root",
  },
  {
    kind: "files",
    from: "cwd-up",
    path: ".claude",
    glob: "CLAUDE.md",
    location: "in-scope",
    stop: "walk-root",
  },
  { kind: "files", from: "cwd-up", path: ".", glob: "AGENTS.md", location: "in-scope", stop: "walk-root" },
  {
    kind: "files",
    from: "cwd-up",
    path: ".claude",
    glob: "AGENTS.md",
    location: "in-scope",
    stop: "walk-root",
  },
  { kind: "files", from: "cwd-down", path: ".", glob: "**/AGENTS.md", location: "below-cwd-only" },
  { kind: "files", from: "home", path: ".claude", glob: "CLAUDE.md", location: "in-scope" },
  {
    kind: "files",
    from: "absolute",
    path: "/etc/claude-code",
    glob: "CLAUDE.md",
    location: "in-scope",
    when: "linux",
  },
  {
    kind: "files",
    from: "cwd-up",
    path: ".claude/rules",
    glob: "**/*.md",
    location: "in-scope",
    stop: "walk-root",
  },
  { kind: "files", from: "home", path: ".claude/rules", glob: "**/*.md", location: "in-scope" },
  {
    kind: "files",
    from: "cwd-up",
    path: ".claude/skills",
    glob: "*/SKILL.md",
    location: "in-scope",
    stop: "project-root",
  },
  {
    kind: "files",
    from: "cwd-down",
    path: ".claude/skills",
    glob: "**/SKILL.md",
    location: "below-cwd-only",
  },
  { kind: "files", from: "home", path: ".claude/skills", glob: "*/SKILL.md", location: "in-scope" },
  {
    kind: "config",
    id: "claude-project-mcp",
    base: "project-root",
    path: ".mcp.json",
    format: "mcp-json",
  },
  {
    kind: "config",
    id: "claude-user-json",
    base: "home",
    path: ".claude.json",
    format: "claude-user-json",
  },
];

const claudePolicy: ClaudePolicy = {
  agent: "claude",
  budget: { agent: "claude", instructionMode: "claude-md-or-agents-md", skillText: claudeSkillText },
  sources: claudeSources,
  notScanned: [
    "auto memory directory",
    "output styles",
    "system prompt",
    "hooks",
    "account-synced skills",
    "plugin skills",
    "team dashboard rules",
  ],
  mcpNameOnlyNote: CLAUDE_MCP_NOTE,
  mcpEnabledToolsNote: null,
  instructionLoads: {
    counted: { inclusion: "startup", counted: "body", manual: false, legacy: false },
    suppressed: {
      inclusion: "dormant",
      reason: "suppressed-by-claude-md",
      tokens: "text",
      counted: "body",
    },
    "below-cwd": { inclusion: "dormant", reason: "below-cwd", tokens: "text", counted: "body" },
  },
  ruleLoads: {
    paths: { inclusion: "dormant", reason: "paths", tokens: "text", counted: "body" },
    always: { inclusion: "startup", counted: "body", manual: false, legacy: false },
  },
  skillLoads: {
    "below-cwd": { inclusion: "dormant", reason: "below-cwd", tokens: "text", counted: "description" },
    "listed-manual": { inclusion: "startup", counted: "description", manual: true, legacy: false },
    "listed-auto": { inclusion: "startup", counted: "description", manual: false, legacy: false },
  },
  mcpLoads,
};

const codexSources: readonly Root[] = [
  { kind: "codex-global-doc" },
  { kind: "codex-project-docs" },
  {
    kind: "files",
    from: "cwd-up",
    path: ".agents/skills",
    glob: "**/SKILL.md",
    location: "in-scope",
    stop: "project-root",
  },
  { kind: "files", from: "home", path: ".agents/skills", glob: "**/SKILL.md", location: "in-scope" },
  {
    kind: "files",
    from: "absolute",
    path: "/etc/codex/skills",
    glob: "**/SKILL.md",
    location: "in-scope",
    when: "linux",
  },
  { kind: "config", id: "codex-user-toml", base: "codex-home", path: "config.toml", format: "codex-toml" },
  {
    kind: "config",
    id: "codex-project-toml",
    base: "project-root",
    path: ".codex/config.toml",
    format: "codex-toml",
  },
];

const codexPolicy: CodexPolicy = {
  agent: "codex",
  budget: {
    agent: "codex",
    projectDocMaxBytes: 32768,
    fallbackFilenames: [],
    skillText: nameAndDescription,
  },
  sources: codexSources,
  notScanned: [],
  mcpNameOnlyNote: NAME_ONLY_NOTE,
  mcpEnabledToolsNote: ENABLED_TOOLS_NOTE,
  instructionLoads: {
    counted: { inclusion: "startup", counted: "body", manual: false, legacy: false },
    "past-cap": { inclusion: "dormant", reason: "past-byte-cap", tokens: "text", counted: "body" },
  },
  skillLoads: {
    disabled: { inclusion: "omit" },
    "listed-manual": { inclusion: "startup", counted: "description", manual: true, legacy: false },
    "listed-auto": { inclusion: "startup", counted: "description", manual: false, legacy: false },
  },
  mcpLoads,
};

const cursorSources: readonly Root[] = [
  { kind: "files", from: "repo", path: ".", glob: "**/AGENTS.md", location: "root-only" },
  { kind: "files", from: "repo", path: ".", glob: "**/CLAUDE.md", location: "root-only" },
  { kind: "files", from: "repo", path: ".", glob: ".cursorrules", location: "in-scope" },
  { kind: "files", from: "repo", path: ".cursor/rules", glob: "**/*.mdc", location: "in-scope" },
  { kind: "files", from: "repo", path: ".cursor/rules", glob: "**/*.md", location: "in-scope" },
  { kind: "files", from: "home", path: ".cursor/rules", glob: "**/*.mdc", location: "in-scope" },
  { kind: "files", from: "home", path: ".cursor/rules", glob: "**/*.md", location: "in-scope" },
  {
    kind: "files",
    from: "repo",
    path: ".agents/skills",
    glob: "**/SKILL.md",
    location: "in-scope-if-cwd-inside",
  },
  {
    kind: "files",
    from: "repo",
    path: ".cursor/skills",
    glob: "**/SKILL.md",
    location: "in-scope-if-cwd-inside",
  },
  {
    kind: "files",
    from: "repo",
    path: ".claude/skills",
    glob: "**/SKILL.md",
    location: "in-scope-if-cwd-inside",
  },
  {
    kind: "files",
    from: "repo",
    path: ".codex/skills",
    glob: "**/SKILL.md",
    location: "in-scope-if-cwd-inside",
  },
  { kind: "files", from: "home", path: ".agents/skills", glob: "**/SKILL.md", location: "in-scope" },
  { kind: "files", from: "home", path: ".cursor/skills", glob: "**/SKILL.md", location: "in-scope" },
  { kind: "files", from: "home", path: ".claude/skills", glob: "**/SKILL.md", location: "in-scope" },
  { kind: "files", from: "home", path: ".codex/skills", glob: "**/SKILL.md", location: "in-scope" },
  {
    kind: "config",
    id: "cursor-project-mcp",
    base: "project-root",
    path: ".cursor/mcp.json",
    format: "mcp-json",
  },
  { kind: "config", id: "cursor-user-mcp", base: "home", path: ".cursor/mcp.json", format: "mcp-json" },
];

const cursorPolicy: CursorPolicy = {
  agent: "cursor",
  budget: { agent: "cursor", skillText: nameAndDescription },
  sources: cursorSources,
  notScanned: ["User Rules typed in Customize", "team rules"],
  mcpNameOnlyNote: NAME_ONLY_NOTE,
  mcpEnabledToolsNote: null,
  instructionLoads: {
    root: { inclusion: "startup", counted: "body", manual: false, legacy: false },
    "legacy-root": { inclusion: "startup", counted: "body", manual: false, legacy: true },
    nested: { inclusion: "dormant", reason: "nested", tokens: "text", counted: "body" },
  },
  ruleLoads: {
    "ignored-md": { inclusion: "dormant", reason: "ignored-md", tokens: "zero" },
    "always-apply": { inclusion: "startup", counted: "body", manual: false, legacy: false },
    globs: { inclusion: "dormant", reason: "globs", tokens: "text", counted: "body" },
    requestable: { inclusion: "startup", counted: "description", manual: false, legacy: false },
    manual: { inclusion: "dormant", reason: "manual", tokens: "text", counted: "body" },
  },
  skillLoads: {
    "outside-cwd": {
      inclusion: "dormant",
      reason: "outside-cwd",
      tokens: "text",
      counted: "description",
    },
    "path-scoped": {
      inclusion: "dormant",
      reason: "path-scoped",
      tokens: "text",
      counted: "description",
    },
    "listed-manual": { inclusion: "startup", counted: "description", manual: true, legacy: false },
    "listed-auto": { inclusion: "startup", counted: "description", manual: false, legacy: false },
  },
  mcpLoads,
};

export const POLICIES: readonly [ClaudePolicy, CodexPolicy, CursorPolicy] = [
  claudePolicy,
  codexPolicy,
  cursorPolicy,
];

export function instructionKey(agent: "claude", instruction: InstructionArtifact): ClaudeInstructionKey;
export function instructionKey(agent: "codex", instruction: InstructionArtifact): CodexInstructionKey;
export function instructionKey(agent: "cursor", instruction: InstructionArtifact): CursorInstructionKey;
export function instructionKey(
  agent: AgentId,
  instruction: InstructionArtifact,
): ClaudeInstructionKey | CodexInstructionKey | CursorInstructionKey {
  switch (agent) {
    case "claude": {
      if (instruction.location === "below-cwd") {
        return "below-cwd";
      }
      if (instruction.suppressed) {
        return "suppressed";
      }
      return "counted";
    }
    case "codex": {
      if (instruction.pastCap) {
        return "past-cap";
      }
      return "counted";
    }
    case "cursor": {
      if (instruction.legacy) {
        return "legacy-root";
      }
      if (instruction.location === "nested") {
        return "nested";
      }
      if (instruction.suppressed || instruction.pastCap) {
        throw new Error("unexpected cursor instruction flags");
      }
      return "root";
    }
    default: {
      const exhaustive: never = agent;
      return exhaustive;
    }
  }
}

export function ruleKey(agent: "claude", rule: RuleArtifact): ClaudeRuleKey;
export function ruleKey(agent: "cursor", rule: RuleArtifact): CursorRuleKey;
export function ruleKey(agent: "codex", rule: RuleArtifact): never;
export function ruleKey(agent: AgentId, rule: RuleArtifact): ClaudeRuleKey | CursorRuleKey {
  switch (agent) {
    case "claude": {
      if (rule.paths !== null && rule.paths !== "") {
        return "paths";
      }
      return "always";
    }
    case "cursor": {
      if (rule.extension === "md") {
        return "ignored-md";
      }
      if (rule.alwaysApply) {
        return "always-apply";
      }
      if (rule.globs !== null && rule.globs !== "") {
        return "globs";
      }
      if (rule.description !== null && rule.description !== "") {
        return "requestable";
      }
      return "manual";
    }
    case "codex": {
      throw new Error("codex has no rules");
    }
    default: {
      const exhaustive: never = agent;
      return exhaustive;
    }
  }
}

export function skillKey(agent: "claude", skill: SkillArtifact): ClaudeSkillKey;
export function skillKey(agent: "codex", skill: SkillArtifact): CodexSkillKey;
export function skillKey(agent: "cursor", skill: SkillArtifact): CursorSkillKey;
export function skillKey(agent: AgentId, skill: SkillArtifact): ClaudeSkillKey | CodexSkillKey | CursorSkillKey {
  switch (agent) {
    case "claude": {
      if (skill.location === "below-cwd") {
        return "below-cwd";
      }
      return skill.manual ? "listed-manual" : "listed-auto";
    }
    case "codex": {
      if (!skill.enabled) {
        return "disabled";
      }
      return skill.manual ? "listed-manual" : "listed-auto";
    }
    case "cursor": {
      if (skill.location === "outside-cwd") {
        return "outside-cwd";
      }
      if (skill.pathScoped) {
        return "path-scoped";
      }
      return skill.manual ? "listed-manual" : "listed-auto";
    }
    default: {
      const exhaustive: never = agent;
      return exhaustive;
    }
  }
}

export function mcpKey(server: McpArtifact): McpKey {
  return server.enabled ? "enabled" : "disabled";
}

export function loadFor(policy: AgentPolicy, artifact: Artifact): ClauseLoad {
  switch (policy.agent) {
    case "claude":
      switch (artifact.type) {
        case "instruction":
          return policy.instructionLoads[instructionKey("claude", artifact)];
        case "rule":
          return policy.ruleLoads[ruleKey("claude", artifact)];
        case "skill":
          return policy.skillLoads[skillKey("claude", artifact)];
        case "mcp":
          return policy.mcpLoads[mcpKey(artifact)];
        default: {
          const exhaustive: never = artifact;
          return exhaustive;
        }
      }
    case "codex":
      switch (artifact.type) {
        case "instruction":
          return policy.instructionLoads[instructionKey("codex", artifact)];
        case "rule":
          throw new Error("codex has no rules");
        case "skill":
          return policy.skillLoads[skillKey("codex", artifact)];
        case "mcp":
          return policy.mcpLoads[mcpKey(artifact)];
        default: {
          const exhaustive: never = artifact;
          return exhaustive;
        }
      }
    case "cursor":
      switch (artifact.type) {
        case "instruction":
          return policy.instructionLoads[instructionKey("cursor", artifact)];
        case "rule":
          return policy.ruleLoads[ruleKey("cursor", artifact)];
        case "skill":
          return policy.skillLoads[skillKey("cursor", artifact)];
        case "mcp":
          return policy.mcpLoads[mcpKey(artifact)];
        default: {
          const exhaustive: never = artifact;
          return exhaustive;
        }
      }
    default: {
      const exhaustive: never = policy;
      return exhaustive;
    }
  }
}

export function estimateFor(policy: AgentPolicy, server: McpArtifact): SchemaEstimate {
  if (server.enabledToolCount !== null) {
    if (policy.mcpEnabledToolsNote === null) {
      throw new Error("enabledToolCount without note");
    }
    return { tools: server.enabledToolCount, note: policy.mcpEnabledToolsNote };
  }
  return { tools: null, note: policy.mcpNameOnlyNote };
}

export function resolveCodexBudget(
  base: Extract<Budget, { agent: "codex" }>,
  overrides: CodexOverrides,
): Extract<Budget, { agent: "codex" }> {
  return {
    agent: "codex",
    projectDocMaxBytes: overrides.projectDocMaxBytes ?? base.projectDocMaxBytes,
    fallbackFilenames: overrides.fallbackFilenames ?? base.fallbackFilenames,
    skillText: base.skillText,
  };
}
