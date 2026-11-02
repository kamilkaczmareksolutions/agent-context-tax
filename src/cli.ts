import { render } from "./render.js";
import { scan } from "./scan.js";
import { type RenderFormat, type ScanOptions } from "./types.js";

export const HELP =
  "agent-context-tax [--json] [--cwd dir] [--home dir] [--codex-home dir] [--walk-root dir]";

export type CliRequest =
  | { type: "help" }
  | { type: "scan"; options: ScanOptions; format: RenderFormat }
  | { type: "error"; message: string };

function readFlagValue(argv: readonly string[], i: number): { value: string; next: number } | null {
  const arg = argv[i];
  if (arg.includes("=")) {
    const [, value] = arg.split("=", 2);
    return { value, next: i + 1 };
  }
  if (i + 1 >= argv.length) {
    return null;
  }
  return { value: argv[i + 1], next: i + 2 };
}

export function parseArgs(argv: readonly string[]): CliRequest {
  let format: RenderFormat = "human";
  const options: ScanOptions = {};
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      return { type: "help" };
    }
    if (arg === "--json") {
      format = "json";
      i += 1;
      continue;
    }
    if (arg === "--cwd" || arg.startsWith("--cwd=")) {
      const parsed = readFlagValue(argv, i);
      if (!parsed) {
        return { type: "error", message: "missing value for --cwd" };
      }
      options.cwd = parsed.value;
      i = parsed.next;
      continue;
    }
    if (arg === "--home" || arg.startsWith("--home=")) {
      const parsed = readFlagValue(argv, i);
      if (!parsed) {
        return { type: "error", message: "missing value for --home" };
      }
      options.home = parsed.value;
      i = parsed.next;
      continue;
    }
    if (arg === "--codex-home" || arg.startsWith("--codex-home=")) {
      const parsed = readFlagValue(argv, i);
      if (!parsed) {
        return { type: "error", message: "missing value for --codex-home" };
      }
      options.codexHome = parsed.value;
      i = parsed.next;
      continue;
    }
    if (arg === "--walk-root" || arg.startsWith("--walk-root=")) {
      const parsed = readFlagValue(argv, i);
      if (!parsed) {
        return { type: "error", message: "missing value for --walk-root" };
      }
      options.walkRoot = parsed.value;
      i = parsed.next;
      continue;
    }
    if (arg.startsWith("-")) {
      return { type: "error", message: `unknown flag: ${arg}` };
    }
    i += 1;
  }
  return { type: "scan", options, format };
}

export function main(argv: readonly string[]): number {
  const args = argv.slice(2);
  const req = parseArgs(args);
  switch (req.type) {
    case "help":
      process.stdout.write(`${HELP}\n`);
      return 0;
    case "error":
      process.stderr.write(`${req.message}\n`);
      return 2;
    case "scan": {
      try {
        const report = scan(req.options);
        process.stdout.write(render(report, req.format));
        return 0;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        process.stderr.write(`${msg}\n`);
        return 1;
      }
    }
    default: {
      const exhaustive: never = req;
      throw new Error(`unhandled request: ${exhaustive}`);
    }
  }
}
