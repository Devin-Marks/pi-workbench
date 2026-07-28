import {
  completeSlashCommand,
  fuzzyFilterSlashCommands,
  fuzzyMatch,
} from "../packages/client/src/lib/slash-command-fuzzy.js";

let failures = 0;
function assert(label: string, ok: boolean): void {
  if (ok) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${label}`);
  }
}

const commands = [
  { name: "/compact" },
  { name: "/clear" },
  { name: "/skill:code-review" },
  { name: "/skill:commit" },
];

assert(
  "matches non-consecutive command-name characters",
  fuzzyFilterSlashCommands(commands, "cpt")
    .map((command) => command.name)
    .join(",") === "/compact",
);
assert(
  "ranks exact command names ahead of partial matches",
  fuzzyFilterSlashCommands(commands, "clear")[0]?.name === "/clear",
);
assert(
  "uses case-insensitive matching and preserves catalog order for an empty query",
  fuzzyFilterSlashCommands(commands, "CR")[0]?.name === "/skill:code-review" &&
    fuzzyFilterSlashCommands(commands, "")
      .map((command) => command.name)
      .join(",") === commands.map((command) => command.name).join(","),
);
assert("supports Console numeric-alpha query normalization", fuzzyMatch("2fa", "fa2").matches);
assert(
  "returns no match when all query characters are unavailable",
  fuzzyFilterSlashCommands(commands, "xyz").length === 0,
);
assert(
  "completion appends a trailing space without dispatching",
  completeSlashCommand("/compact") === "/compact ",
);

if (failures > 0) {
  console.log(`\n[test-slash-command-fuzzy] FAIL — ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\n[test-slash-command-fuzzy] PASS");
