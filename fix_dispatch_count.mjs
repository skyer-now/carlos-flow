import fs from 'fs';

const filePath = 'D:/cindy/publish-output/carlos-flow-cindy/src/index.js';
let content = fs.readFileSync(filePath, 'utf8');

const old = `              if (!state.card) return fail("没有留痕，不允许派发。");

            const prompt = buildContractPrompt(role, state.card, a.message);`;

const newStr = `              if (!state.card) return fail("没有留痕，不允许派发。");

            // Phase 1-1: dispatch 时才增加 dispatch_count
            state.dispatch_count = (Number(state.dispatch_count) || 0) + 1;
            const prompt = buildContractPrompt(role, state.card, a.message);`;

if (!content.includes(old)) {
    console.error("ERROR: pattern not found");
    process.exit(1);
}

content = content.replace(old, newStr);
fs.writeFileSync('D:/cindy/publish-output/carlos-flow-cindy/src/index.js', content, 'utf8');
console.log("dispatch_count fix applied");