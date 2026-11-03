import fs from 'fs';

const filePath = 'D:/cindy/publish-output/carlos-flow-cindy/src/index.js';
let content = fs.readFileSync(filePath, 'utf8');

const searchText = '        handler: async (args) => {\n      try {\n        const a = args || {};\n        const sessionId = a.sessionId || "unknown";\n        const role = a.role === "auditor" ? "auditor" : "executor";\n        const cwd = a.cwd || process.cwd();\n        const state = loadState(sessionId);\n\n        if (!state.card) return fail("没有留痕，不允许派发。");';

const idx = content.indexOf('        handler: async (args) => {\n      try {\n        const a = args || {};\n        const sessionId = a.sessionId || "unknown";\n        const role = a.role === "auditor" ? "auditor" : "executor";\n        const cwd = a.cwd || process.cwd();\n        const state = loadState(sessionId);\n\n        if (!state.card) return fail("没有留痕，不允许派发。");');

if (idx === -1) {
    console.error("ERROR: Pattern not found");
    // Debug: find similar
    const idx2 = content.indexOf('handler: async (args) => {');
    console.log('Found handler at:', idx2);
    if (idx2 >= 0) {
        console.log(content.substring(idx2, idx2 + 300));
    }
    process.exit(1);
}

console.log('Found at index:', idx);
console.log('Pattern matched successfully');