import path from "node:path";
import { type RenderFormat, type Report, type Row } from "./types.js";

function displayPath(filePath: string, report: Report): string {
  if (filePath.startsWith(report.home + path.sep) || filePath === report.home) {
    const rest = filePath.slice(report.home.length);
    return `~${rest.split(path.sep).join("/")}`;
  }
  const rel = path.relative(report.cwd, filePath);
  if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
    return rel.split(path.sep).join("/") || ".";
  }
  return filePath;
}

function loadLabel(row: Row): string {
  if (row.inclusion === "startup") {
    if (row.kind === "mcp") {
      return "startup estimate";
    }
    return "startup";
  }
  return `dormant ${row.reason}`;
}

function col(s: string, width: number): string {
  return (s.length >= width ? s : s.padEnd(width)) + "  ";
}

export function render(report: Report, format: RenderFormat): string {
  switch (format) {
    case "json":
      return `${JSON.stringify(report, null, 2)}\n`;
    case "human": {
      const startup = report.agents.flatMap((agent) =>
        agent.rows.filter((row) => row.inclusion === "startup").map((row) => displayPath(row.path, report)),
      );
      const dormant = report.agents.flatMap((agent) =>
        agent.rows.filter((row) => row.inclusion === "dormant").map((row) => displayPath(row.path, report)),
      );
      const fileWidth = Math.min(72, Math.max(4, ...[...startup, ...dormant, "file"].map((s) => s.length)));
      const lines: string[] = [];
      lines.push(col("file", fileWidth) + col("tool", 8) + col("tokens", 8) + col("percent", 9) + "load");
      for (const agent of report.agents) {
        for (const row of agent.rows) {
          if (row.inclusion !== "startup") {
            continue;
          }
          lines.push(
            col(displayPath(row.path, report), fileWidth) +
              col(agent.agent, 8) +
              col(String(row.tokens), 8) +
              col(String(row.percent), 9) +
              loadLabel(row),
          );
        }
        lines.push(`${agent.agent} measured ${agent.measuredTokens}`);
      }
      const notes = new Set<string>();
      for (const agent of report.agents) {
        for (const row of agent.rows) {
          if (row.inclusion === "startup" && row.kind === "mcp") {
            notes.add(row.estimate.note);
          }
        }
      }
      for (const note of notes) {
        lines.push(note);
      }
      lines.push("");
      lines.push("What to trim");
      for (const item of report.trim.largest) {
        lines.push(`  ${item.tokens} tokens  ${displayPath(item.path, report)} (${item.agent})`);
      }
      for (const dup of report.trim.duplicates) {
        lines.push(
          `  overlap ${dup.overlapPercentOfSmaller}%  ${displayPath(dup.agentsPath, report)} vs ${displayPath(dup.claudePath, report)}`,
        );
      }
      for (const dead of report.trim.dead) {
        lines.push(`  dead ${dead.why}  ${displayPath(dead.path, report)} (${dead.agent})`);
      }
      for (const manual of report.trim.manualListings) {
        lines.push(`  manual skill listing  ${displayPath(manual.path, report)} (${manual.agent})`);
      }
      lines.push("");
      lines.push("Not in the startup total");
      lines.push(col("file", fileWidth) + col("tool", 8) + col("reason", 24) + "tokens");
      for (const agent of report.agents) {
        for (const row of agent.rows) {
          if (row.inclusion !== "dormant") {
            continue;
          }
          lines.push(
            col(displayPath(row.path, report), fileWidth) +
              col(agent.agent, 8) +
              col(row.reason, 24) +
              String(row.tokens),
          );
        }
      }
      lines.push("");
      lines.push("Not scanned");
      for (const ns of report.notScanned) {
        if (ns.topics.length === 0) {
          continue;
        }
        lines.push(`  ${ns.agent}: ${ns.topics.join("; ")}`);
      }
      return `${lines.join("\n")}\n`;
    }
    default: {
      const exhaustive: never = format;
      throw new Error(`unhandled format: ${exhaustive}`);
    }
  }
}
