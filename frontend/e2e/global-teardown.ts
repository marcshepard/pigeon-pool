import { execSync } from "child_process";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");

export default async function globalTeardown() {
  execSync("conda run -n pigeon python -m backend.cli teardown-fe-tests", {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: { ...process.env },
  });
}
