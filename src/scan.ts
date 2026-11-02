import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  estimateFor,
  loadFor,
  POLICIES,
  resolveCodexBudget,
  LARGEST_LIMIT,
  type AgentPolicy,
} from "./registry.js";
import {
  assertNoSecrets,
  configError,
  importPaths,
  mergeCodexOverrides,
  parseClaudeUserJson,
  parseCodexToml,
  parseInstruction,
  parseMcpJson,
  parseRule,
  parseSkill,
} from "./parse.js";
import { TOKENIZER_ID, countTokens } from "./tokenizer.js";
import {
  type Artifact,
  type ArtifactLocation,
  type Budget,
  type CodexOverrides,
  type ConfigFormat,
  type CountedText,
  type InstructionArtifact,
  type McpArtifact,
  type Root,
  type ScanContext,
  type SkillArtifact,
  type SkillTextPolicy,
} from "./domain.js";
import {
  type AgentId,
  type AgentTotal,
  type DeadItem,
  type Duplicate,
  type LargestItem,
  type ManualListing,
  type NotScanned,
  type Report,
  type Row,
  type ScanOptions,
  type Trim,
  type Truncation,
} from "./types.js";

function resolveContext(options: ScanOptions | undefined): ScanContext {
  const cwdRaw = options?.cwd ?? process.cwd();
  const cwd = path.resolve(cwdRaw);
  if (!fs.existsSync(cwd)) {
    throw new Error(`cwd not found: ${cwd}`);
  }
  const home = path.resolve(options?.home ?? os.homedir());
  const codexHome = path.resolve(options?.codexHome ?? path.join(home, ".codex"));
  const walkRoot = path.resolve(options?.walkRoot ?? path.parse(cwd).root);
  const projectRoot = findGitRoot(cwd, walkRoot) ?? cwd;
  return { cwd, home, codexHome, walkRoot, projectRoot };
}

function findGitRoot(start: string, stop: string): string | null {
  let dir = start;
  while (true) {
    if (fs.existsSync(path.join(dir, ".git")) || fs.existsSync(path.join(dir, ".git-root"))) {
      return dir;
    }
    if (dir === stop || dir === path.dirname(dir)) {
      return null;
    }
    const parent = path.dirname(dir);
    if (!isInside(parent, stop) && parent !== stop) {
      return null;
    }
    dir = parent;
  }
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function realpathSafe(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

function readTextFile(absPath: string): string | null {
  try {
    if (!fs.existsSync(absPath)) {
      return null;
    }
    const stat = fs.statSync(absPath);
    if (!stat.isFile()) {
      return null;
    }
    return fs.readFileSync(absPath, "utf8");
  } catch (e) {
    if (fs.existsSync(absPath)) {
      throw configError(absPath, e instanceof Error ? e.message : "read failed");
    }
    return null;
  }
}

function matchGlob(relativePath: string, glob: string): boolean {
  const norm = relativePath.split(path.sep).join("/");
  const base = path.basename(norm);
  if (glob === norm || glob === base) {
    return true;
  }
  if (glob.startsWith("**/")) {
    const rest = glob.slice(3);
    if (rest.includes("*")) {
      const re = new RegExp("^" + rest.replace(/\*/g, ".*") + "$");
      return re.test(base) || re.test(norm);
    }
    return norm === rest || norm.endsWith(`/${rest}`);
  }
  const pattern =
    "^" +
    glob
      .split("/")
      .map((part) => part.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*"))
      .join("/") +
    "$";
  const re = new RegExp(pattern);
  return re.test(norm) || re.test(base);
}

const SKIP_DIR = new Set(["node_modules", ".git", "dist", ".netlify"]);

function allowedWalk(dir: string, ctx: ScanContext): boolean {
  const rp = realpathSafe(dir);
  return (
    isInside(rp, ctx.walkRoot) ||
    isInside(rp, ctx.home) ||
    isInside(rp, ctx.codexHome) ||
    rp === "/etc" ||
    rp.startsWith("/etc/")
  );
}

function walkFiles(baseDir: string, relPath: string, glob: string, ctx: ScanContext): string[] {
  const root = path.join(baseDir, relPath === "." ? "" : relPath);
  if (!fs.existsSync(root)) {
    return [];
  }
  const results: string[] = [];
  const walk = (dir: string) => {
    if (!allowedWalk(dir, ctx)) {
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (SKIP_DIR.has(ent.name)) {
        continue;
      }
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full);
      } else if (ent.isFile()) {
        const relFromBase = path.relative(baseDir, full);
        const normalized = relFromBase.split(path.sep).join("/");
        const relFromSearch =
          relPath === "." ? normalized : path.relative(path.join(baseDir, relPath), full).split(path.sep).join("/");
        if (
          matchGlob(normalized, glob) ||
          matchGlob(relFromSearch, glob) ||
          matchGlob(ent.name, glob)
        ) {
          results.push(full);
        }
      }
    }
  };
  if (glob.includes("**") || relPath.includes("/")) {
    walk(root);
  } else {
    const candidate = path.join(baseDir, relPath, glob);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      results.push(candidate);
    }
  }
  return results;
}

function resolveLocation(
  filePath: string,
  rule: Root & { kind: "files" },
  ctx: ScanContext,
): ArtifactLocation {
  switch (rule.location) {
    case "in-scope":
      return "in-scope";
    case "below-cwd-only": {
      const dir = path.dirname(filePath);
      if (dir === ctx.cwd) {
        return "in-scope";
      }
      return isInside(dir, ctx.cwd) ? "below-cwd" : "in-scope";
    }
    case "root-only": {
      const dir = path.dirname(filePath);
      return dir === ctx.projectRoot ? "in-scope" : "nested";
    }
    case "in-scope-if-cwd-inside": {
      const owner = skillOwnerRoot(filePath, ctx.projectRoot);
      if (owner && (ctx.cwd === owner || isInside(ctx.cwd, owner))) {
        return "in-scope";
      }
      return "outside-cwd";
    }
  }
}

function skillOwnerRoot(filePath: string, projectRoot: string): string | null {
  const rel = path.relative(projectRoot, filePath);
  if (rel.startsWith("..")) {
    return null;
  }
  const parts = rel.split(path.sep);
  for (let i = 0; i < parts.length; i++) {
    if ([".cursor", ".agents", ".claude", ".codex"].includes(parts[i])) {
      return path.join(projectRoot, ...parts.slice(0, i));
    }
  }
  return null;
}

function isCodexSkillDisabled(skillPath: string, disabledPaths: readonly string[], projectRoot: string): boolean {
  const skillDir = path.dirname(skillPath);
  const relSkill = path.relative(projectRoot, skillDir).split(path.sep).join("/");
  for (const dp of disabledPaths) {
    const normalized = dp.replace(/^\.\//, "").replace(/\/$/, "");
    if (relSkill === normalized || relSkill.endsWith(`/${normalized}`)) {
      return true;
    }
    if (skillPath.includes(normalized)) {
      return true;
    }
  }
  return false;
}

type CollectState = {
  seen: Map<string, number>;
  artifacts: Artifact[];
  secrets: string[];
  codexUser: CodexOverrides | null;
  codexProject: CodexOverrides | null;
};

function addArtifact(state: CollectState, artifact: Artifact, absPath: string): void {
  const key = realpathSafe(absPath);
  if (state.seen.has(key)) {
    return;
  }
  state.seen.set(key, state.artifacts.length);
  state.artifacts.push(artifact);
}

function collectFromRoot(
  policy: AgentPolicy,
  root: Root,
  ctx: ScanContext,
  state: CollectState,
  codexBudget: Extract<Budget, { agent: "codex" }> | null,
): void {
  switch (root.kind) {
    case "files": {
      if (root.from === "absolute") {
        if (root.when === "linux" && process.platform !== "linux") {
          return;
        }
        const files = walkFiles(root.path, ".", root.glob, ctx);
        for (const f of files) {
          ingestFile(policy, f, root, ctx, state);
        }
        return;
      }
      if (root.from === "home") {
        const files = walkFiles(ctx.home, root.path, root.glob, ctx);
        for (const f of files) {
          ingestFile(policy, f, root, ctx, state);
        }
        return;
      }
      if (root.from === "codex-home") {
        const files = walkFiles(ctx.codexHome, root.path, root.glob, ctx);
        for (const f of files) {
          ingestFile(policy, f, root, ctx, state);
        }
        return;
      }
      if (root.from === "cwd-up") {
        let dir = ctx.cwd;
        const stop =
          root.stop === "project-root"
            ? ctx.projectRoot
            : ctx.walkRoot;
        while (true) {
          const base = path.join(dir, root.path === "." ? "" : root.path);
          const files =
            root.glob.includes("**") || root.path.includes("/")
              ? walkFiles(dir, root.path, root.glob, ctx)
              : (() => {
                  const candidate = path.join(base, root.glob);
                  return fs.existsSync(candidate) ? [candidate] : [];
                })();
          for (const f of files) {
            ingestFile(policy, f, root, ctx, state);
          }
          if (dir === stop || dir === path.dirname(dir)) {
            break;
          }
          dir = path.dirname(dir);
          if (!isInside(dir, ctx.walkRoot) && dir !== ctx.walkRoot) {
            break;
          }
        }
        return;
      }
      if (root.from === "cwd-down") {
        const files = walkFiles(ctx.cwd, root.path, root.glob, ctx);
        for (const f of files) {
          ingestFile(policy, f, root, ctx, state);
        }
        return;
      }
      if (root.from === "repo") {
        const files = walkFiles(ctx.projectRoot, root.path, root.glob, ctx);
        for (const f of files) {
          ingestFile(policy, f, root, ctx, state);
        }
        return;
      }
      break;
    }
    case "codex-global-doc": {
      if (policy.agent !== "codex") {
        return;
      }
      const override = path.join(ctx.codexHome, "AGENTS.override.md");
      const agents = path.join(ctx.codexHome, "AGENTS.md");
      let file: string | null = null;
      const oText = readTextFile(override);
      if (oText !== null && oText.trim().length > 0) {
        file = override;
      } else {
        const aText = readTextFile(agents);
        if (aText !== null && aText.trim().length > 0) {
          file = agents;
        }
      }
      if (file) {
        const text = readTextFile(file)!;
        addArtifact(
          state,
          makeInstruction(policy.agent, file, "AGENTS.md", "in-scope", text, false, false, null),
          file,
        );
      }
      return;
    }
    case "codex-project-docs": {
      if (policy.agent !== "codex" || !codexBudget) {
        return;
      }
      const dirs = dirsFromRootToCwd(ctx.projectRoot, ctx.cwd);
      for (const dir of dirs) {
        let picked: string | null = null;
        let text = "";
        const override = path.join(dir, "AGENTS.override.md");
        const agents = path.join(dir, "AGENTS.md");
        const oText = readTextFile(override);
        if (oText !== null && oText.trim().length > 0) {
          picked = override;
          text = oText;
        } else {
          const aText = readTextFile(agents);
          if (aText !== null && aText.trim().length > 0) {
            picked = agents;
            text = aText;
          } else {
            for (const fb of codexBudget.fallbackFilenames) {
              const fbPath = path.join(dir, fb);
              const fbText = readTextFile(fbPath);
              if (fbText !== null && fbText.trim().length > 0) {
                picked = fbPath;
                text = fbText;
                break;
              }
            }
          }
        }
        if (picked) {
          addArtifact(
            state,
            makeInstruction(policy.agent, picked, path.basename(picked), "in-scope", text, false, false, null),
            picked,
          );
        }
      }
      return;
    }
    case "config": {
      const base =
        root.base === "home"
          ? ctx.home
          : root.base === "codex-home"
            ? ctx.codexHome
            : ctx.projectRoot;
      const configPath = path.join(base, root.path);
      const text = readTextFile(configPath);
      if (text === null) {
        return;
      }
      ingestConfig(policy, root.format, configPath, text, ctx, state);
      return;
    }
    default: {
      const exhaustive: never = root;
      return exhaustive;
    }
  }
}

function dirsFromRootToCwd(projectRoot: string, cwd: string): string[] {
  return orderRootToCwd(projectRoot, cwd);
}

function orderRootToCwd(projectRoot: string, cwd: string): string[] {
  const chain: string[] = [];
  let cur = cwd;
  while (true) {
    chain.unshift(cur);
    if (cur === projectRoot) {
      break;
    }
    const parent = path.dirname(cur);
    if (parent === cur || !isInside(cur, projectRoot)) {
      break;
    }
    cur = parent;
  }
  if (chain[0] !== projectRoot) {
    chain.unshift(projectRoot);
  }
  return chain;
}

function ingestConfig(
  policy: AgentPolicy,
  format: ConfigFormat,
  configPath: string,
  text: string,
  ctx: ScanContext,
  state: CollectState,
): void {
  if (format === "claude-user-json") {
    const parsed = parseClaudeUserJson(text, configPath, ctx.projectRoot, ctx.cwd);
    state.secrets.push(...parsed.secrets);
    for (const s of parsed.servers) {
      addArtifact(
        state,
        {
          type: "mcp",
          agent: policy.agent,
          configPath: s.configPath,
          name: s.name,
          enabled: s.enabled,
          enabledToolCount: s.enabledToolCount,
        },
        `${configPath}#${s.name}`,
      );
    }
    return;
  }
  if (format === "mcp-json") {
    const parsed = parseMcpJson(text, configPath);
    state.secrets.push(...parsed.secrets);
    for (const s of parsed.servers) {
      addArtifact(
        state,
        {
          type: "mcp",
          agent: policy.agent,
          configPath: s.configPath,
          name: s.name,
          enabled: s.enabled,
          enabledToolCount: s.enabledToolCount,
        },
        `${configPath}#${s.name}`,
      );
    }
    return;
  }
  if (format === "codex-toml") {
    const parsed = parseCodexToml(text, configPath);
    state.secrets.push(...parsed.secrets);
    const userToml = path.resolve(ctx.codexHome, "config.toml");
    if (path.resolve(configPath) === userToml) {
      state.codexUser = parsed.codex;
    } else {
      state.codexProject = parsed.codex;
    }
    for (const s of parsed.servers) {
      addArtifact(
        state,
        {
          type: "mcp",
          agent: policy.agent,
          configPath: s.configPath,
          name: s.name,
          enabled: s.enabled,
          enabledToolCount: s.enabledToolCount,
        },
        `${configPath}#${s.name}`,
      );
    }
  }
}

function makeInstruction(
  agent: AgentId,
  filePath: string,
  basename: string,
  location: ArtifactLocation,
  text: string,
  suppressed: boolean,
  pastCap: boolean,
  truncation: Truncation | null,
  legacy = false,
): InstructionArtifact {
  const parsed = parseInstruction(text, basename);
  return {
    type: "instruction",
    agent,
    path: filePath,
    basename,
    location,
    suppressed,
    pastCap,
    legacy,
    text: parsed.text,
    truncation,
  };
}

function ingestFile(
  policy: AgentPolicy,
  filePath: string,
  root: Root & { kind: "files" },
  ctx: ScanContext,
  state: CollectState,
): void {
  if (!allowedWalk(filePath, ctx)) {
    return;
  }
  const text = readTextFile(filePath);
  if (text === null) {
    return;
  }
  const basename = path.basename(filePath);
  const location = resolveLocation(filePath, root, ctx);

  if (basename.endsWith(".mdc") || (basename.endsWith(".md") && filePath.includes(`${path.sep}rules${path.sep}`))) {
    if (policy.agent === "codex") {
      return;
    }
    const fields = parseRule(text);
    const ext = basename.endsWith(".mdc") ? "mdc" : "md";
    addArtifact(
      state,
      {
        type: "rule",
        agent: policy.agent,
        path: filePath,
        extension: ext,
        alwaysApply: fields.alwaysApply,
        description: fields.description,
        globs: fields.globs,
        paths: fields.paths,
        body: fields.body,
      },
      filePath,
    );
    return;
  }

  if (basename === "SKILL.md") {
    const sidecarPath = path.join(path.dirname(filePath), "agents", "openai.yaml");
    const sidecar = readTextFile(sidecarPath);
    const fields = parseSkill(policy.agent, text, sidecar);
    let enabled = true;
    if (policy.agent === "codex") {
      const merged = mergeCodexOverrides(state.codexUser, state.codexProject);
      enabled = !isCodexSkillDisabled(filePath, merged.disabledSkillPaths, ctx.projectRoot);
    }
    addArtifact(
      state,
      {
        type: "skill",
        agent: policy.agent,
        path: filePath,
        name: fields.name,
        description: fields.description,
        whenToUse: fields.whenToUse,
        manual: fields.manual,
        pathScoped: fields.pathScoped,
        enabled,
        location,
      },
      filePath,
    );
    return;
  }

  if (
    basename === "CLAUDE.md" ||
    basename === "CLAUDE.local.md" ||
    basename === "AGENTS.md" ||
    basename === ".cursorrules" ||
    basename.endsWith(".md")
  ) {
    if (basename.endsWith(".md") && !["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md"].includes(basename)) {
      if (!filePath.includes("AGENTS") && !filePath.includes("CLAUDE")) {
        return;
      }
    }
    const legacy = policy.agent === "cursor" && basename === ".cursorrules";
    addArtifact(
      state,
      makeInstruction(policy.agent, filePath, basename, location, text, false, false, null, legacy),
      filePath,
    );
  }
}

function collect(
  policy: AgentPolicy,
  ctx: ScanContext,
  codexOverrides: CodexOverrides | null,
): { artifacts: Artifact[]; secrets: string[]; omittedDisabledSkills: number } {
  const state: CollectState = {
    seen: new Map(),
    artifacts: [],
    secrets: [],
    codexUser: codexOverrides,
    codexProject: null,
  };
  let codexBudget: Extract<Budget, { agent: "codex" }> | null = null;
  if (policy.agent === "codex") {
    const merged = mergeCodexOverrides(state.codexUser, state.codexProject);
    codexBudget = resolveCodexBudget(policy.budget, merged);
  }
  for (const root of policy.sources) {
    if (root.kind === "config" && root.format === "codex-toml") {
      collectFromRoot(policy, root, ctx, state, codexBudget);
    }
  }
  if (policy.agent === "codex") {
    const merged = mergeCodexOverrides(state.codexUser, state.codexProject);
    codexBudget = resolveCodexBudget(policy.budget, merged);
  }
  for (const root of policy.sources) {
    if (root.kind === "config" && root.format === "codex-toml") {
      continue;
    }
    collectFromRoot(policy, root, ctx, state, codexBudget);
  }
  let omitted = 0;
  if (policy.agent === "codex") {
    const merged = mergeCodexOverrides(state.codexUser, state.codexProject);
    for (const a of state.artifacts) {
      if (a.type === "skill" && !a.enabled) {
        omitted += 1;
      }
    }
    state.artifacts = state.artifacts.filter((a) => !(a.type === "skill" && !a.enabled));
  }
  return { artifacts: state.artifacts, secrets: state.secrets, omittedDisabledSkills: omitted };
}

function settle(
  policy: AgentPolicy,
  artifacts: readonly Artifact[],
  ctx: ScanContext,
  codexOverrides: CodexOverrides | null,
): Artifact[] {
  const list = artifacts.map((a) => ({ ...a })) as Artifact[];
  if (policy.agent === "claude") {
    const hasProjectClaude = list.some(
      (a) =>
        a.type === "instruction" &&
        (a.basename === "CLAUDE.md" ||
          a.basename === "CLAUDE.local.md" ||
          a.path.includes(`${path.sep}.claude${path.sep}CLAUDE.md`)) &&
        a.location === "in-scope" &&
        isProjectChain(a.path, ctx),
    );
    if (hasProjectClaude) {
      for (const a of list) {
        if (
          a.type === "instruction" &&
          a.basename === "AGENTS.md" &&
          a.location === "in-scope" &&
          isProjectChain(a.path, ctx)
        ) {
          (a as InstructionArtifact).suppressed = true;
        }
      }
    }
    const startupPaths = new Set<string>();
    for (const a of list) {
      if (a.type !== "instruction") {
        continue;
      }
      const load = loadFor(policy, a);
      if (load.inclusion === "startup") {
        startupPaths.add(realpathSafe(a.path));
      }
    }
    for (const a of list) {
      if (a.type !== "instruction") {
        continue;
      }
      const inst = a as InstructionArtifact;
      let text = inst.text;
      for (const imp of importPaths(text)) {
        const resolved = path.resolve(path.dirname(inst.path), imp);
        const rp = realpathSafe(resolved);
        if (startupPaths.has(rp)) {
          continue;
        }
        const imported = readTextFile(resolved);
        if (imported !== null) {
          const token = `@${imp}`;
          text = text.includes(token) ? text.replace(token, imported.trimEnd()) : `${text}\n${imported}`;
          startupPaths.add(rp);
        }
      }
      inst.text = text;
    }
  }
  if (policy.agent === "codex") {
    const budget = resolveCodexBudget(policy.budget, codexOverrides ?? mergeCodexOverrides(null, null));
    const instructions = list.filter((a): a is InstructionArtifact => a.type === "instruction");
    instructions.sort((a, b) => instructionCodexOrder(a, b, ctx));
    let usedBytes = 0;
    for (const inst of instructions) {
      const bytes = Buffer.byteLength(inst.text, "utf8");
      if (usedBytes >= budget.projectDocMaxBytes) {
        inst.pastCap = true;
        continue;
      }
      if (usedBytes + bytes > budget.projectDocMaxBytes) {
        const kept = budget.projectDocMaxBytes - usedBytes;
        inst.text = Buffer.from(inst.text, "utf8").subarray(0, kept).toString("utf8");
        inst.truncation = { unit: "bytes", kept, dropped: bytes - kept };
        usedBytes = budget.projectDocMaxBytes;
        continue;
      }
      usedBytes += bytes;
    }
  }
  return list;
}

function instructionCodexOrder(a: InstructionArtifact, b: InstructionArtifact, ctx: ScanContext): number {
  const aGlobal = a.path.startsWith(ctx.codexHome) ? 0 : 1;
  const bGlobal = b.path.startsWith(ctx.codexHome) ? 0 : 1;
  if (aGlobal !== bGlobal) {
    return aGlobal - bGlobal;
  }
  return a.path.localeCompare(b.path);
}

function isProjectChain(filePath: string, ctx: ScanContext): boolean {
  if (filePath.startsWith(ctx.home)) {
    return false;
  }
  if (filePath.startsWith("/etc/")) {
    return false;
  }
  return isInside(filePath, ctx.walkRoot) || isInside(filePath, ctx.projectRoot);
}

function textFor(
  artifact: Artifact,
  counted: CountedText,
  skillText: SkillTextPolicy,
): { text: string; truncation: Truncation | null } {
  switch (artifact.type) {
    case "instruction":
      if (counted === "body") {
        return { text: artifact.text, truncation: artifact.truncation };
      }
      return { text: "", truncation: null };
    case "rule": {
      if (counted === "description") {
        return { text: artifact.description ?? "", truncation: null };
      }
      return { text: artifact.body, truncation: null };
    }
    case "skill": {
      const parts: string[] = [];
      for (const field of skillText.fields) {
        if (field === "name") {
          parts.push(artifact.name);
        } else if (field === "description") {
          parts.push(artifact.description);
        } else if (field === "whenToUse") {
          if (artifact.whenToUse) {
            parts.push(artifact.whenToUse);
          }
        }
      }
      let combined = parts.join("\n");
      if (skillText.charCap !== null && combined.length > skillText.charCap) {
        const dropped = combined.length - skillText.charCap;
        combined = combined.slice(0, skillText.charCap);
        return {
          text: combined,
          truncation: { unit: "chars", kept: skillText.charCap, dropped },
        };
      }
      return { text: combined, truncation: null };
    }
    case "mcp":
      return { text: artifact.name, truncation: null };
    default: {
      const exhaustive: never = artifact;
      return exhaustive;
    }
  }
}

function measure(policy: AgentPolicy, artifacts: readonly Artifact[]): {
  rows: readonly Row[];
  omittedDisabledSkills: number;
} {
  const rows: Row[] = [];
  let omitted = 0;
  for (const artifact of artifacts) {
    if (artifact.type === "skill" && policy.agent === "codex" && !artifact.enabled) {
      omitted += 1;
      continue;
    }
    const load = loadFor(policy, artifact);
    if (load.inclusion === "omit") {
      omitted += 1;
      continue;
    }
    const skillText = policy.budget.skillText;

    if (load.inclusion === "dormant" && load.tokens === "zero") {
      rows.push({
        agent: policy.agent,
        path: artifactPath(artifact),
        tokens: 0,
        percent: 0,
        inclusion: "dormant",
        kind: artifactKind(artifact),
        reason: load.reason,
      });
      continue;
    }

    const counted = load.inclusion === "startup" ? load.counted : load.counted;
    const { text, truncation } = textFor(artifact, counted, skillText);
    const tokens = countTokens(text);

    if (load.inclusion === "dormant") {
      rows.push({
        agent: policy.agent,
        path: artifactPath(artifact),
        tokens,
        percent: 0,
        inclusion: "dormant",
        kind: artifactKind(artifact),
        reason: load.reason,
      });
      continue;
    }

    switch (artifact.type) {
      case "instruction":
        rows.push({
          agent: policy.agent,
          path: artifact.path,
          tokens,
          percent: 0,
          inclusion: "startup",
          kind: "instruction",
          counted: "body",
          truncation,
          legacy: load.legacy,
        });
        break;
      case "rule":
        rows.push({
          agent: policy.agent,
          path: artifact.path,
          tokens,
          percent: 0,
          inclusion: "startup",
          kind: "rule",
          counted: load.counted === "body" || load.counted === "description" ? load.counted : "body",
        });
        break;
      case "skill":
        rows.push({
          agent: policy.agent,
          path: artifact.path,
          tokens,
          percent: 0,
          inclusion: "startup",
          kind: "skill",
          counted: "description",
          manual: load.manual,
          truncation,
        });
        break;
      case "mcp":
        rows.push({
          agent: policy.agent,
          path: `${artifact.configPath}#${artifact.name}`,
          tokens,
          percent: 0,
          inclusion: "startup",
          kind: "mcp",
          counted: "server-name",
          estimate: estimateFor(policy, artifact),
        });
        break;
      default: {
        const exhaustive: never = artifact;
        return exhaustive;
      }
    }
  }

  const measured = rows.filter((r) => r.inclusion === "startup").reduce((s, r) => s + r.tokens, 0);
  for (const row of rows) {
    if (row.inclusion === "startup" && measured > 0) {
      (row as Row).percent = Math.round((row.tokens / measured) * 1000) / 10;
    }
  }
  return { rows, omittedDisabledSkills: omitted };
}

function artifactPath(artifact: Artifact): string {
  if (artifact.type === "mcp") {
    return `${artifact.configPath}#${artifact.name}`;
  }
  return artifact.path;
}

function artifactKind(artifact: Artifact): Row["kind"] {
  switch (artifact.type) {
    case "instruction":
      return "instruction";
    case "rule":
      return "rule";
    case "skill":
      return "skill";
    case "mcp":
      return "mcp";
    default: {
      const exhaustive: never = artifact;
      return exhaustive;
    }
  }
}

function normalizeLines(text: string): Set<string> {
  const lines = new Set<string>();
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t.length > 0) {
      lines.add(t);
    }
  }
  return lines;
}

function buildTrim(rows: readonly Row[], artifacts: readonly Artifact[]): Trim {
  const startup = rows.filter((r) => r.inclusion === "startup");
  const largest: LargestItem[] = [...startup]
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, LARGEST_LIMIT)
    .map((r) => ({ agent: r.agent, path: r.path, tokens: r.tokens }));

  const duplicates: Duplicate[] = [];
  const byDir = new Map<string, { agents?: InstructionArtifact; claude?: InstructionArtifact }>();
  for (const a of artifacts) {
    if (a.type !== "instruction") {
      continue;
    }
    if (a.basename !== "AGENTS.md" && a.basename !== "CLAUDE.md") {
      continue;
    }
    const dir = path.dirname(a.path);
    const entry = byDir.get(dir) ?? {};
    if (a.basename === "AGENTS.md") {
      entry.agents = a;
    } else {
      entry.claude = a;
    }
    byDir.set(dir, entry);
  }
  for (const [dir, pair] of byDir) {
    if (!pair.agents || !pair.claude) {
      continue;
    }
    const aLines = normalizeLines(pair.agents.text);
    const cLines = normalizeLines(pair.claude.text);
    let shared = 0;
    for (const line of aLines) {
      if (cLines.has(line)) {
        shared += 1;
      }
    }
    const smaller = Math.min(aLines.size, cLines.size);
    const overlapPercentOfSmaller = smaller === 0 ? 0 : Math.round((shared / smaller) * 1000) / 10;
    duplicates.push({
      agentsPath: pair.agents.path,
      claudePath: pair.claude.path,
      overlapPercentOfSmaller,
    });
  }

  const dead: DeadItem[] = [];
  for (const r of rows) {
    if (r.inclusion === "dormant" && r.reason === "manual") {
      dead.push({ agent: r.agent, path: r.path, why: "manual" });
    }
    if (r.inclusion === "dormant" && r.reason === "ignored-md") {
      dead.push({ agent: r.agent, path: r.path, why: "ignored-md" });
    }
    if (r.inclusion === "startup" && r.kind === "instruction" && r.legacy) {
      dead.push({ agent: r.agent, path: r.path, why: "legacy-cursorrules" });
    }
  }

  const manualListings: ManualListing[] = [];
  for (const r of rows) {
    if (r.inclusion === "startup" && r.kind === "skill" && r.manual) {
      manualListings.push({ agent: r.agent, path: r.path });
    }
  }

  return { largest, duplicates, dead, manualListings };
}

export function scan(options?: ScanOptions): Report {
  const ctx = resolveContext(options);
  const allSecrets: string[] = [];
  const agents: AgentTotal[] = [];
  let allRows: Row[] = [];
  let allArtifacts: Artifact[] = [];

  let codexOverrides: CodexOverrides | null = null;
  const codexPolicy = POLICIES[1];
  const userToml = readTextFile(path.join(ctx.codexHome, "config.toml"));
  const projectToml = readTextFile(path.join(ctx.projectRoot, ".codex/config.toml"));
  if (userToml) {
    codexOverrides = parseCodexToml(userToml, path.join(ctx.codexHome, "config.toml")).codex;
  }
  if (projectToml) {
    const proj = parseCodexToml(projectToml, path.join(ctx.projectRoot, ".codex/config.toml")).codex;
    codexOverrides = mergeCodexOverrides(codexOverrides, proj);
  }

  for (const policy of POLICIES) {
    const overrides = policy.agent === "codex" ? codexOverrides : null;
    const { artifacts, secrets, omittedDisabledSkills } = collect(policy, ctx, overrides);
    allSecrets.push(...secrets);
    const settled = settle(policy, artifacts, ctx, policy.agent === "codex" ? codexOverrides : null);
    const { rows, omittedDisabledSkills: omitted2 } = measure(policy, settled);
    const measuredTokens = rows.filter((r) => r.inclusion === "startup").reduce((s, r) => s + r.tokens, 0);
    agents.push({
      agent: policy.agent,
      measuredTokens,
      omittedDisabledSkills: omittedDisabledSkills + omitted2,
      rows,
    });
    allRows = allRows.concat([...rows]);
    allArtifacts = allArtifacts.concat([...settled]);
  }

  const trim = buildTrim(allRows, allArtifacts);
  const notScanned: NotScanned[] = POLICIES.map((p) => ({
    agent: p.agent,
    topics: p.notScanned,
  }));

  const report: Report = {
    tokenizer: TOKENIZER_ID,
    cwd: ctx.cwd,
    home: ctx.home,
    agents,
    trim,
    notScanned,
  };
  assertNoSecrets(report, allSecrets);
  return report;
}

