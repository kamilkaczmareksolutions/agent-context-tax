import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const workspaceRoot = path.join(here, "..", "..");
export const fixtureHome = path.join(workspaceRoot, "test", "fixtures", "home");
export const fixtureProject = path.join(workspaceRoot, "test", "fixtures", "project");
export const cliEntry = path.join(workspaceRoot, "dist", "src", "cli.js");
export const fixtureCodexHome = path.join(fixtureHome, ".codex");

export function scanOptions(cwd: string = fixtureProject) {
  return {
    cwd,
    home: fixtureHome,
    walkRoot: fixtureProject,
    codexHome: fixtureCodexHome,
  };
}
