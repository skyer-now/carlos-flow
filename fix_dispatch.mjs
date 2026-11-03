import fs from 'fs';

const filePath = 'D:/cindy/publish-output/carlos-flow-cindy/src/index.js';
let content = fs.readFileSync(filePath, 'utf8');

// Find the exact pattern
const idx = content.indexOf('if (!state.card) return fail("没有留痕，不允许派发。")');
console.log('Found at:', idx);

if (idx > 0) {
    console.log('Context:', JSON.stringify(content.substring(idx, idx + 150)));
} else {
    console.error('Pattern not found');
}

// Try the replacement
const old = `              if (!state.card) return fail("没有留痕，不允许派发。");

            const prompt = buildContractPrompt(role, state.card, a.message);`;

const newStr = `              if (!state.card) return fail("没有留痕，不允许派发。");

            // Phase 1-1: dispatch 时才增加 dispatch_count
            state.dispatch_count = (Number(state.dispatch_count) || 0) + 1;
            const prompt = buildContractPrompt(role, state.card, a.message);`;

if (content.includes(old)) {
    content = content.replace(old, newStr);
    fs.writeFileSync('D:/cindy/publish-output/carlos-flow-cindy/src/index.js', content, 'utf8');
    console.log("Replacement done");
} else {
    console.error("Pattern not found");
    console.log('Searching for similar...');
    // Try to find similar
    const idx2 = content.indexOf('if (!state.card)');
    if (idx2 > 0) {
        console.log('Found similar at:', idx2);
        console.log(JSON.stringify(content.substring(idx2, idx2 + 200)));
    }
}

fs.writeFileSync('D:/cindy/publish-output/carlos-flow-cindy/src/index.js', content, 'utf8');