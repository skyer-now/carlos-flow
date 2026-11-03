import fs from 'fs';

const filePath = 'D:/cindy/publish-output/carlos-flow-cindy/src/index.js';
let content = fs.readFileSync(filePath, 'utf8');

// Use the exact bytes from the file
const oldText = `        handler: async (args) => {
      try {
        const a = args || {};
        const sessionId = a.sessionId || "unknown";
        const role = a.role === "auditor" ? "auditor" : "executor";
        const cwd = a.cwd || process.cwd();
        const state = loadState(sessionId);

        if (!state.card) return fail("没有留痕，不允许派发。");

        
            // Phase 1-1: dispatch 时才增加 dispatch_count
            state.dispatch_count = (Number(state.dispatch_count) || 0) + 1;
const prompt = buildContractPrompt(role, state.card, a.message);`;

const newText = `        handler: async (args) => {
      try {
        const a = args || {};
        // Phase 1-1: role 白名单校验
        const role = a.role === "auditor" ? "auditor" : "executor";
        if (role !== "executor" && role !== "auditor") return fail("非法 role：" + role + "，必须是 executor 或 auditor");

        // Phase 1-1: dispatch 前强制校验 stale / dispatch_count / claim
        const sessionId = a.sessionId || "unknown";
        const state = loadState(sessionId);
        if (!state.card) return fail("没有留痕，不允许派发。");
        if (isStale(state)) return fail("留痕已过期（stale），请重新提交任务卡。");
        if (state.dispatch_count >= MAX_DISPATCH) return fail("派发次数已达上限 " + MAX_DISPATCH + "，停止派发并向用户汇报。");
        // 简单检查是否有过 claim（dispatch_count > 0 视为已 claim）
        if ((Number(state.dispatch_count) || 0) === 0) return fail("未 claim，请先 flow_claim 领取派发名额。");

        const role = a.role === "auditor" ? "auditor" : "executor";
        const cwd = a.cwd || process.cwd();
        const state = loadState(sessionId);

        if (!state.card) return fail("没有留痕，不允许派发。");`;

if (!content.includes(oldText)) {
    console.error("ERROR: Pattern not found");
    process.exit(1);
}
content = content.replace(oldText, newText);
fs.writeFileSync('D:/cindy/publish-output/carlos-flow-cindy/src/index.js', content, 'utf8');
console.log("Fixed flow_dispatch prechecks");