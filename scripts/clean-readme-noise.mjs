#!/usr/bin/env node
// 清理 README 中被重复注入的「语言栏 + 版本行」（只保留文档头部那一处）。
//
// 背景：早期版本用脚本给每个章节都插入了一行语言切换栏和版本行，
// 结果这些行被粘在 Markdown 表格行尾（如 `| ... |**语言 / Languages:** ...`），
// 破坏表格渲染，也让读者难以阅读。本脚本把它们收回到文档头部一处。
import { readFileSync, writeFileSync } from "node:fs";

const NOISE = /\*\*语言 \/ Languages:\*\*|\*\*Language \/ Languages:\*\*|\*\*版本 \/ Version:\*\*|\*\*Version:\*\*/;

const files = process.argv.slice(2);
for (const f of files) {
  const text = readFileSync(f, "utf8");
  const lines = text.split("\n");
  const out = [];
  let navSeen = 0;
  let verSeen = 0;
  let removed = 0;

  for (const line of lines) {
    const isNav = /\*\*语言 \/ Languages:\*\*|\*\*Language \/ Languages:\*\*/.test(line);
    const isVer = /\*\*版本 \/ Version:\*\*|\*\*Version:\*\*/.test(line);

    if (isNav || isVer) {
      const counter = isNav ? "nav" : "ver";
      if (counter === "nav") navSeen += 1; else verSeen += 1;
      const keepFirst = counter === "nav" ? navSeen === 1 : verSeen === 1;
      if (!keepFirst) {
        removed += 1;
        // 若这一行还粘着表格内容，说明它是被拼到行尾的，把表格内容保留下来
        const cleaned = line
          .replace(/\*\*语言 \/ Languages:\*\*[^\n]*$/u, "")
          .replace(/\*\*Language \/ Languages:\*\*[^\n]*$/u, "")
          .replace(/\*\*版本 \/ Version:\*\*[^\n]*$/u, "")
          .replace(/\*\*Version:\*\*[^\n]*$/u, "")
          .trimEnd();
        if (cleaned) out.push(cleaned);
        continue;
      }
    }
    out.push(line);
  }

  // 折叠 3 个以上连续空行
  const text2 = out.join("\n").replace(/\n{3,}/g, "\n\n");

  if (text2 !== text) {
    writeFileSync(f, text2, "utf8");
    console.log(`cleaned ${f}: removed ${removed} noise line(s)`);
  } else {
    console.log(`no change ${f}`);
  }
}
