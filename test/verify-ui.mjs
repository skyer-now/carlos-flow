import { narrate } from "../ui/narrator.js";

const mock = { kind: "blocked", reason: "操作范围越界" };
const res = narrate(mock);

if (res.text.includes("抱歉") && res.text.includes("越界")) {
  console.log("✅ 语义翻译风格校验通过");
  process.exit(0);
} else {
  console.error("❌ 风格不符，实际输出: " + res.text);
  process.exit(1);
}
