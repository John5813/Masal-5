import path from "node:path";
import os from "node:os";

export const PROJECTS_WORKDIR_ROOT = path.join(os.tmpdir(), "uzcoder-projects");
