import { parse as parseToml } from "smol-toml";
import { type AgentId, type Report } from "./types.js";
import { type CodexOverrides, type McpServer } from "./domain.js";

export const SECRET_MIN_LENGTH = 8;

export type ConfigError = Error & { readonly name: "ConfigError"; readonly path: string };

export function configError(path: string, message: string): ConfigError {
  const err = new Error(message) as ConfigError;
  Object.defineProperty(err, "name", { value: "ConfigError" });
  Object.defineProperty(err, "path", { value: path });
  return err;
}

export type InstructionText = { text: string };

export type RuleFields = {
  body: string;
  alwaysApply: boolean;
  description: string | null;
  globs: string | null;
  paths: string | null;
};

export type SkillFields = {
  name: string;
  description: string;
  whenToUse: string | null;
  manual: boolean;
  pathScoped: boolean;
};

export type ParsedMcp = {
  path: string;
  servers: readonly McpServer[];
  disabledNames: readonly string[];
  secrets: readonly string[];
};

export type ParsedCodex = ParsedMcp & { codex: CodexOverrides };

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function unquote(value: string): string {
  const val = value.trim();
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    return val.slice(1, -1);
  }
  return val;
}

function parseSimpleYaml(yaml: string): Record<string, string | boolean> {
  const lines = yaml.split("\n");
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const match = trimmed.match(/^([\w.-]+):\s*(.*)$/);
    if (!match) {
      continue;
    }
    const key = match[1];
    let val = match[2].trim();
    if (val === "" || val === "|" || val === ">") {
      const items: string[] = [];
      while (i + 1 < lines.length && /^\s+-\s+/.test(lines[i + 1])) {
        i += 1;
        items.push(unquote(lines[i].replace(/^\s+-\s+/, "")));
      }
      if (items.length > 0) {
        out[key] = items.join(",");
        continue;
      }
      if (val !== "") {
        continue;
      }
    }
    if (val === "true") {
      out[key] = true;
    } else if (val === "false") {
      out[key] = false;
    } else if (val.length > 0) {
      out[key] = unquote(val);
    }
  }
  return out;
}

function splitFrontmatter(markdown: string): { frontmatter: string | null; body: string } {
  const match = markdown.match(FRONTMATTER_RE);
  if (!match) {
    return { frontmatter: null, body: markdown };
  }
  return { frontmatter: match[1], body: markdown.slice(match[0].length) };
}

export function stripHtmlComments(markdown: string): string {
  return markdown.replace(/<!--[\s\S]*?-->/g, "");
}

export function parseInstruction(text: string, basename: string): InstructionText {
  let body = text;
  if (basename === "CLAUDE.md" || basename === "CLAUDE.local.md") {
    body = stripHtmlComments(body);
  }
  return { text: body };
}

export function parseRule(text: string): RuleFields {
  const { frontmatter, body } = splitFrontmatter(text);
  const fm = frontmatter ? parseSimpleYaml(frontmatter) : {};
  const alwaysApply = fm.alwaysApply === true;
  const description =
    typeof fm.description === "string" && fm.description.length > 0 ? fm.description : null;
  const globs = typeof fm.globs === "string" && fm.globs.length > 0 ? fm.globs : null;
  const paths = typeof fm.paths === "string" && fm.paths.length > 0 ? fm.paths : null;
  return { body, alwaysApply, description, globs, paths };
}

export function parseSkill(_agent: AgentId, skillText: string, sidecarYaml: string | null): SkillFields {
  const { frontmatter, body } = splitFrontmatter(skillText);
  const fm = frontmatter ? parseSimpleYaml(frontmatter) : {};
  const name =
    (typeof fm.name === "string" && fm.name.length > 0 ? fm.name : null) ??
    body.split("\n").find((l) => l.startsWith("# "))?.slice(2).trim() ??
    "skill";
  const description =
    typeof fm.description === "string" ? fm.description : body.split("\n").slice(0, 3).join("\n").trim();
  const whenToUse =
    typeof fm.when_to_use === "string"
      ? fm.when_to_use
      : typeof fm.whenToUse === "string"
        ? fm.whenToUse
        : null;
  const manual = fm["disable-model-invocation"] === true;
  const pathScoped =
    (typeof fm.paths === "string" && fm.paths.length > 0) ||
    (typeof fm.globs === "string" && fm.globs.length > 0);
  if (sidecarYaml) {
    const side = parseSimpleYaml(sidecarYaml);
    if (side["allow_implicit_invocation"] === false) {
      return { name, description, whenToUse, manual: true, pathScoped };
    }
  }
  return { name, description, whenToUse, manual, pathScoped };
}

const SECRET_KEY_RE = /token|secret|authorization|api_key/i;

function collectSecretsFromObject(obj: unknown, out: Set<string>): void {
  if (obj === null || obj === undefined) {
    return;
  }
  if (typeof obj === "object" && !Array.isArray(obj)) {
    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
      if (key === "env" || key === "headers" || key === "auth") {
        collectSecretValues(val, out);
        continue;
      }
      if (SECRET_KEY_RE.test(key)) {
        collectSecretValues(val, out);
        continue;
      }
      if (typeof val === "object") {
        collectSecretsFromObject(val, out);
      }
    }
  }
}

function collectSecretValues(val: unknown, out: Set<string>): void {
  if (typeof val === "string" && val.length >= SECRET_MIN_LENGTH) {
    out.add(val);
    return;
  }
  if (val && typeof val === "object") {
    for (const v of Object.values(val as Record<string, unknown>)) {
      if (typeof v === "string" && v.length >= SECRET_MIN_LENGTH) {
        out.add(v);
      } else if (typeof v === "object") {
        collectSecretValues(v, out);
      }
    }
  }
}

function mcpServersFromRecord(
  record: Record<string, unknown> | undefined,
  configPath: string,
  disabled: Set<string>,
): McpServer[] {
  if (!record) {
    return [];
  }
  const servers: McpServer[] = [];
  for (const [name, raw] of Object.entries(record)) {
    const entry = raw as Record<string, unknown> | undefined;
    const enabledField = entry?.enabled;
    const enabled = enabledField === false ? false : !disabled.has(name);
    servers.push({
      configPath,
      name,
      enabled,
      enabledToolCount: null,
    });
  }
  return servers;
}

export function parseClaudeUserJson(
  text: string,
  path: string,
  projectPath: string,
  cwdPath: string,
): ParsedMcp {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw configError(path, "invalid JSON");
  }
  const secrets = new Set<string>();
  collectSecretsFromObject(parsed, secrets);
  const disabled = new Set<string>();
  const disabledRaw = parsed.disabledMcpServers;
  if (Array.isArray(disabledRaw)) {
    for (const n of disabledRaw) {
      if (typeof n === "string") {
        disabled.add(n);
      }
    }
  }
  const servers: McpServer[] = [];
  servers.push(...mcpServersFromRecord(parsed.mcpServers as Record<string, unknown>, path, disabled));
  const projects = parsed.projects as Record<string, unknown> | undefined;
  if (projects) {
    const projRoot = projects[projectPath] as Record<string, unknown> | undefined;
    if (projRoot?.mcpServers) {
      servers.push(
        ...mcpServersFromRecord(projRoot.mcpServers as Record<string, unknown>, path, disabled),
      );
    }
    if (cwdPath !== projectPath) {
      const projCwd = projects[cwdPath] as Record<string, unknown> | undefined;
      if (projCwd?.mcpServers) {
        servers.push(...mcpServersFromRecord(projCwd.mcpServers as Record<string, unknown>, path, disabled));
      }
    }
  }
  const known = new Set(servers.map((server) => server.name));
  for (const name of disabled) {
    if (!known.has(name)) {
      servers.push({ configPath: path, name, enabled: false, enabledToolCount: null });
    }
  }
  return { path, servers, disabledNames: [...disabled], secrets: [...secrets] };
}

export function parseMcpJson(text: string, path: string): ParsedMcp {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw configError(path, "invalid JSON");
  }
  const secrets = new Set<string>();
  collectSecretsFromObject(parsed, secrets);
  const servers = mcpServersFromRecord(parsed.mcpServers as Record<string, unknown>, path, new Set());
  return { path, servers, disabledNames: [], secrets: [...secrets] };
}

export function parseCodexToml(text: string, path: string): ParsedCodex {
  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(text) as Record<string, unknown>;
  } catch {
    throw configError(path, "invalid TOML");
  }
  const secrets = new Set<string>();
  collectSecretsFromObject(parsed, secrets);
  const disabledSkillPaths: string[] = [];
  const skillsConfig = parsed["skills.config"];
  if (Array.isArray(skillsConfig)) {
    for (const entry of skillsConfig) {
      if (entry && typeof entry === "object") {
        const e = entry as Record<string, unknown>;
        if (e.enabled === false && typeof e.path === "string") {
          disabledSkillPaths.push(e.path);
        }
      }
    }
  }
  const skillsBlock = parsed.skills;
  if (skillsBlock && typeof skillsBlock === "object") {
    const configArr = (skillsBlock as Record<string, unknown>).config;
    if (Array.isArray(configArr)) {
      for (const entry of configArr) {
        if (entry && typeof entry === "object") {
          const e = entry as Record<string, unknown>;
          if (e.enabled === false && typeof e.path === "string") {
            disabledSkillPaths.push(e.path);
          }
        }
      }
    }
  }

  let projectDocMaxBytes: number | null = null;
  if (typeof parsed.project_doc_max_bytes === "number") {
    projectDocMaxBytes = parsed.project_doc_max_bytes;
  }
  let fallbackFilenames: string[] | null = null;
  const fallbackRaw = parsed.project_doc_fallback_filenames;
  if (Array.isArray(fallbackRaw)) {
    fallbackFilenames = fallbackRaw.filter((x): x is string => typeof x === "string");
  }

  const servers: McpServer[] = [];
  const mcpServers = parsed.mcp_servers as Record<string, unknown> | undefined;
  if (mcpServers) {
    for (const [name, raw] of Object.entries(mcpServers)) {
      const entry = raw as Record<string, unknown>;
      const enabled = entry.enabled !== false;
      let enabledToolCount: number | null = null;
      const tools = entry.enabled_tools;
      if (Array.isArray(tools)) {
        enabledToolCount = tools.length;
      }
      servers.push({ configPath: path, name, enabled, enabledToolCount });
    }
  }

  return {
    path,
    servers,
    disabledNames: [],
    secrets: [...secrets],
    codex: {
      projectDocMaxBytes,
      fallbackFilenames,
      disabledSkillPaths,
    },
  };
}

export function mergeCodexOverrides(user: CodexOverrides | null, project: CodexOverrides | null): CodexOverrides {
  return {
    projectDocMaxBytes: project?.projectDocMaxBytes ?? user?.projectDocMaxBytes ?? null,
    fallbackFilenames: project?.fallbackFilenames ?? user?.fallbackFilenames ?? null,
    disabledSkillPaths: [...(user?.disabledSkillPaths ?? []), ...(project?.disabledSkillPaths ?? [])],
  };
}

function stripInlineAndFenced(text: string): string {
  const parts: string[] = [];
  let i = 0;
  while (i < text.length) {
    if (text.startsWith("```", i)) {
      const end = text.indexOf("```", i + 3);
      if (end === -1) {
        break;
      }
      i = end + 3;
      continue;
    }
    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      if (end === -1) {
        parts.push(text.slice(i));
        break;
      }
      i = end + 1;
      continue;
    }
    parts.push(text[i]);
    i += 1;
  }
  return parts.join("");
}

export function importPaths(text: string): readonly string[] {
  const stripped = stripInlineAndFenced(text);
  const paths: string[] = [];
  const re = /@([^\s@][^\s]*)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(stripped)) !== null) {
    paths.push(match[1]);
  }
  return paths;
}

export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length < SECRET_MIN_LENGTH) {
      continue;
    }
    out = out.split(secret).join("[REDACTED]");
  }
  return out;
}

export function assertNoSecrets(report: Report, secrets: readonly string[]): void {
  const json = JSON.stringify(report);
  for (const secret of secrets) {
    if (secret.length >= SECRET_MIN_LENGTH && json.includes(secret)) {
      throw new Error(`secret leaked into report: length ${secret.length}`);
    }
  }
}
