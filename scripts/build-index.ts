import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildIndex } from "../src/build-index.ts";

const root = join(import.meta.dirname, "..");
const index = buildIndex(join(root, "entries"));
writeFileSync(
  join(root, "index.json"),
  JSON.stringify(index, null, 2) + "\n",
);
console.log(
  `index.json built: ${Object.keys(index.entries).length} entries`,
);
