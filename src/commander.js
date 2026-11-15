// ESM 模式入口
export async function executeRecipe(recipe) {
  console.log(recipe.plan, recipe.steps);
  return true;
}
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
export function execSyncSafe(cmd) { return execFileSync(cmd, { shell: true }); }
export function generateUUID() { return randomUUID(); }
export function captureFileHashes(files) { return "hash_placeholder"; }