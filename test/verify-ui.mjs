import { narrate } from "../ui/narrator.js";
if (typeof narrate !== "function") process.exit(1);
console.log("UI Narrator 验证通过");