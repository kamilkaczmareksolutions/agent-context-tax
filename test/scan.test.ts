import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getEncoding } from "js-tiktoken";
import { scan, render } from "../src/index.js";
import { stripHtmlComments, parseRule, parseSkill } from "../src/parse.js";
import { spawnSync } from "node:child_process";
import { main, parseArgs } from "../src/cli.js";
import { fixtureHome, fixtureProject, scanOptions, fixtureCodexHome, cliEntry } from "./paths.js";

function setupClaudeJson(projectRoot: string): void {
  const template = fs.readFileSync(path.join(fixtureHome, ".claude.json.template"), "utf8");
  const json = template.replaceAll("PLACEHOLDER_PROJECT", projectRoot);
  fs.writeFileSync(path.join(fixtureHome, ".claude.json"), json);
}

describe("agent-context-tax scan", () => {
  setupClaudeJson(fixtureProject);

  it("Claude CLAUDE.md startup tokens match tokenizer on comment-stripped text", () => {
    const report = scan(scanOptions());
    const raw = fs.readFileSync(path.join(fixtureProject, "CLAUDE.md"), "utf8");
    const expectedText = stripHtmlComments(raw);
    const enc = getEncoding(report.tokenizer);
    const row = report.agents
      .find((a) => a.agent === "claude")
      ?.rows.find((r) => r.path.endsWith("CLAUDE.md") && r.inclusion === "startup");
    assert.ok(row);
    assert.equal(row.tokens, enc.encode(expectedText).length);
  });

  it("Claude AGENTS.md dormant when project CLAUDE.md exists", () => {
    const report = scan(scanOptions());
    const row = report.agents
      .find((a) => a.agent === "claude")
      ?.rows.find((r) => r.path.endsWith("/AGENTS.md") && !r.path.includes("nested"));
    assert.ok(row);
    assert.equal(row.inclusion, "dormant");
    assert.equal(row.reason, "suppressed-by-claude-md");
  });

  it("Claude AGENTS.md startup when no CLAUDE in chain", () => {
    const cwd = path.join(fixtureProject, "agents-only");
    const report = scan({ cwd, home: fixtureHome, walkRoot: cwd, codexHome: fixtureCodexHome });
    const row = report.agents
      .find((a) => a.agent === "claude")
      ?.rows.find((r) => r.path.endsWith("agents-only/AGENTS.md"));
    assert.ok(row);
    assert.equal(row.inclusion, "startup");
    const text = fs.readFileSync(row.path, "utf8");
    assert.equal(row.tokens, getEncoding(report.tokenizer).encode(text).length);
  });

  it("unscoped claude rule is startup with frontmatter removed", () => {
    const report = scan(scanOptions());
    const row = report.agents
      .find((a) => a.agent === "claude")
      ?.rows.find((r) => r.path.endsWith("global-rule.md"));
    assert.ok(row);
    assert.equal(row.inclusion, "startup");
    const raw = fs.readFileSync(row.path, "utf8");
    const fields = parseRule(raw);
    assert.equal(row.tokens, getEncoding(report.tokenizer).encode(fields.body).length);
  });

  it("claude rule with paths is dormant", () => {
    const report = scan(scanOptions());
    const row = report.agents
      .find((a) => a.agent === "claude")
      ?.rows.find((r) => r.path.endsWith("scoped-paths.md"));
    assert.ok(row);
    assert.equal(row.inclusion, "dormant");
    assert.equal(row.reason, "paths");
    const listed = report.agents
      .find((a) => a.agent === "claude")
      ?.rows.find((r) => r.path.endsWith("list-paths.md"));
    assert.equal(listed?.inclusion, "dormant");
    if (listed?.inclusion === "dormant") {
      assert.equal(listed.reason, "paths");
    }
  });

  it("home skill listing and home cursor rule are startup", () => {
    const report = scan(scanOptions());
    const skill = report.agents
      .find((a) => a.agent === "claude")
      ?.rows.find((r) => r.path.endsWith("home-skill/SKILL.md"));
    assert.ok(skill);
    assert.equal(skill.inclusion, "startup");
    assert.equal(
      skill.tokens,
      getEncoding(report.tokenizer).encode("home-skill\nHome skill description counted at startup").length,
    );
    const homeRule = report.agents
      .find((a) => a.agent === "cursor")
      ?.rows.find((r) => r.path.endsWith("home-always.mdc"));
    assert.equal(homeRule?.inclusion, "startup");
    assert.equal(homeRule?.tokens, getEncoding(report.tokenizer).encode("Home cursor rule body\n").length);
  });

  it("@import expanded with importer not double-counted", () => {
    const cwd = path.join(fixtureProject, "import-claude");
    const report = scan(scanOptions(cwd));
    const importExtra = fs.readFileSync(path.join(fixtureProject, "import-extra.md"), "utf8");
    const claudeRaw = fs.readFileSync(path.join(cwd, "CLAUDE.md"), "utf8");
    const combined = stripHtmlComments(claudeRaw).replace("@../import-extra.md", importExtra.trimEnd());
    const enc = getEncoding(report.tokenizer);
    const row = report.agents
      .find((a) => a.agent === "claude")
      ?.rows.find((r) => r.path.endsWith("import-claude/CLAUDE.md") && r.inclusion === "startup");
    assert.ok(row);
    assert.equal(row.tokens, enc.encode(combined).length);
    const duplicate = report.agents
      .find((a) => a.agent === "claude")
      ?.rows.find((r) => r.path.endsWith("import-extra.md"));
    assert.equal(duplicate, undefined);
  });

  it("claude skill listing uses name description only with cap", () => {
    const report = scan(scanOptions());
    const row = report.agents
      .find((a) => a.agent === "claude")
      ?.rows.find((r) => r.path.includes("auto-skill/SKILL.md"));
    assert.ok(row);
    assert.equal(row.inclusion, "startup");
    const skillText = fs.readFileSync(row.path, "utf8");
    const fields = parseSkill("claude", skillText, null);
    const parts = [fields.name, fields.description];
    if (fields.whenToUse) {
      parts.push(fields.whenToUse);
    }
    assert.equal(row.tokens, getEncoding(report.tokenizer).encode(parts.join("\n")).length);
  });

  it("MCP row startup estimate tools null name only and no secret", () => {
    const report = scan(scanOptions());
    const human = render(report, "human");
    const json = render(report, "json");
    assert.ok(!human.includes("fixture-token-xyz"));
    assert.ok(!json.includes("fixture-token-xyz"));
    const row = report.agents
      .find((a) => a.agent === "claude")
      ?.rows.find((r) => r.kind === "mcp" && r.path.includes("fixture-docs"));
    assert.ok(row);
    assert.equal(row.inclusion, "startup");
    if (row.kind === "mcp") {
      assert.equal(row.estimate.tools, null);
      assert.equal(row.tokens, getEncoding(report.tokenizer).encode("fixture-docs").length);
    }
  });

  it("Codex prefers AGENTS.override.md and skips empty", () => {
    const cwd = path.join(fixtureProject, "sub");
    const report = scan(scanOptions(cwd));
    const startupPaths = report.agents
      .find((a) => a.agent === "codex")
      ?.rows.filter((r) => r.inclusion === "startup" && r.kind === "instruction")
      .map((r) => r.path);
    assert.ok(startupPaths?.some((p) => p.endsWith("sub/AGENTS.override.md")));
    assert.ok(!startupPaths?.some((p) => p.endsWith("sub/AGENTS.md")));
  });

  it("Codex byte cap truncates and marks past-cap dormant", () => {
    const cwd = path.join(fixtureProject, "codex-byte-cap");
    const report = scan({
      cwd,
      home: fixtureHome,
      walkRoot: cwd,
      codexHome: fixtureCodexHome,
    });
    const codex = report.agents.find((a) => a.agent === "codex");
    assert.ok(codex);
    const truncated = codex.rows.find(
      (r) => r.inclusion === "startup" && r.kind === "instruction" && r.truncation !== null,
    );
    assert.ok(truncated);
    const past = codex.rows.find((r) => r.inclusion === "dormant" && r.reason === "past-byte-cap");
    assert.ok(past);
  });

  it("Cursor rules and agents behavior", () => {
    const report = scan(scanOptions());
    const cursor = report.agents.find((a) => a.agent === "cursor");
    assert.ok(cursor);
    const always = cursor.rows.find((r) => r.path.endsWith("always-apply.mdc"));
    assert.equal(always?.inclusion, "startup");
    const req = cursor.rows.find((r) => r.path.endsWith("requestable.mdc"));
    assert.ok(req && req.inclusion === "startup" && req.kind === "rule" && req.counted === "description");
    const globs = cursor.rows.find((r) => r.path.endsWith("globs-rule.mdc"));
    assert.equal(globs?.inclusion, "dormant");
    const manual = cursor.rows.find((r) => r.path.endsWith("manual-rule.mdc"));
    assert.equal(manual?.inclusion, "dormant");
    const ignored = cursor.rows.find((r) => r.path.endsWith("ignored-plain.md"));
    assert.equal(ignored?.inclusion, "dormant");
    assert.equal(ignored?.tokens, 0);
    const legacy = cursor.rows.find((r) => r.path.endsWith(".cursorrules"));
    assert.equal(legacy?.inclusion, "startup");
    const rootAgents = cursor.rows.find(
      (r) => r.path.endsWith("/AGENTS.md") && !r.path.includes("packages") && !r.path.includes("nested"),
    );
    assert.equal(rootAgents?.inclusion, "startup");
    const nested = cursor.rows.find((r) => r.path.includes("packages/nested/AGENTS.md"));
    assert.equal(nested?.inclusion, "dormant");
  });

  it("json totals match human measured sums", () => {
    const report = scan(scanOptions());
    const human = render(report, "human");
    const parsed = JSON.parse(render(report, "json")) as typeof report;
    for (const agent of parsed.agents) {
      const match = human.match(new RegExp(`${agent.agent} measured (\\d+)`));
      assert.ok(match);
      assert.equal(agent.measuredTokens, Number(match[1]));
    }
  });
});

describe("cli", () => {
  it("parseArgs rejects unknown flags with exit 2", () => {
    assert.equal(parseArgs(["--nope"]).type, "error");
    assert.equal(main(["node", "agent-context-tax", "--nope"]), 2);
  });

  it("cli scan hides fixture token", () => {
    setupClaudeJson(fixtureProject);
    const cliPath = cliEntry;
    const res = spawnSync(
      process.execPath,
      [
        cliPath,
        "--cwd",
        fixtureProject,
        "--home",
        fixtureHome,
        "--walk-root",
        fixtureProject,
        "--codex-home",
        fixtureCodexHome,
      ],
      { encoding: "utf8" },
    );
    assert.equal(res.status, 0, res.stderr || res.stdout);
    assert.ok(!res.stdout.includes("fixture-token-xyz"));
  });
});

