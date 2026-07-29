import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(__filename), "..");
const appPath = resolve(repoRoot, "packages/client/src/App.tsx");
const sidebarPath = resolve(repoRoot, "packages/client/src/components/ProjectSidebar.tsx");

let failures = 0;
function assert(label: string, ok: boolean): void {
  if (ok) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${label}`);
  }
}

async function main(): Promise<void> {
  const [app, sidebar] = await Promise.all([
    readFile(appPath, "utf8"),
    readFile(sidebarPath, "utf8"),
  ]);

  assert(
    "defines a dedicated persisted project sidebar width key",
    app.includes('PROJECTS_WIDTH_KEY = "pi-forge/projects-width"'),
  );
  assert("clamps persisted project sidebar widths", app.includes("readPersistedProjectsWidth"));
  assert(
    "renders a desktop-only divider after the project sidebar",
    /<ResizableDivider[\s\S]*?getStartSize=\{\(\) => projectsWidthRef\.current\}/.test(app),
  );
  assert(
    "keeps the mobile drawer free of an inline desktop width",
    app.includes("...(isMobile ? {} : { style: { width: `${projectsWidth}px` } })"),
  );
  assert(
    "uses the live project width in right-pane constraints",
    !app.includes("240 ≈ ProjectSidebar") && app.includes("projectsWidth + 4"),
  );
  assert(
    "accepts App-owned desktop sidebar sizing",
    sidebar.includes("style?: CSSProperties") && sidebar.includes("...style,"),
  );

  if (failures > 0) process.exitCode = 1;
}

void main();
