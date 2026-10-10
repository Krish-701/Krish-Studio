/** Seeds a demo film from samples/the-last-lighthouse.fountain (rule-based breakdown, no API keys needed). */
import { readFileSync } from "fs";
import path from "path";
import { db } from "../src/lib/db";
import { heuristicParse } from "../src/lib/script/parse";
import { applyParsedScript } from "../src/lib/services";

async function main() {
  const text = readFileSync(path.join(__dirname, "..", "samples", "the-last-lighthouse.fountain"), "utf8");
  const project = await db.project.create({
    data: {
      title: "The Last Lighthouse",
      logline: "A keeper and a stranger wait out the storm of the century.",
      scriptText: text,
      defaults: { image: "seedream-5-pro", video: "bytedance-seedance-pro-2.5" },
      styleLock: { enabled: true, prompt: "moody maritime drama, 35mm film grain, anamorphic", mood: "lonely, tense", tone: "restrained", palette: ["slate blue", "lamp amber", "storm grey"], lighting: "single warm practical against cold blue night" },
    },
  });
  await applyParsedScript(project.id, heuristicParse(text));
  console.log(`Seeded "${project.title}" → /projects/${project.id}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
