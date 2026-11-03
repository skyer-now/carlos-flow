import fs from 'fs';

const filePath = 'D:/cindy/publish-output/carlos-flow-cindy/src/index.js';
let content = fs.readFileSync(filePath, 'utf8');

// Find the exact location
const idx = content.indexOf('if (!state.card) return fail("没有留痕，不允许派发。")');
console.log('Found at:', idx);

if (idx > 0) {
    // Find the position after the semicolon and newline
    const afterFail = content.indexOf(';', idx);
    const afterSemicolon = content.indexOf('\n', afterFail);
    
    // Find the next line with "const prompt"
    const promptIdx = content.indexOf('const prompt = buildContractPrompt', afterSemicolon);
    
    console.log('After fail at:', afterFail);
    console.log('After semicolon at:', afterSemicolon);
    console.log('Prompt at:', promptIdx);
    
    // Insert the dispatch_count increment between the fail check and the prompt line
    const insertPoint = promptIdx;
    const insertText = `\n            // Phase 1-1: dispatch 时才增加 dispatch_count\n            state.dispatch_count = (Number(state.dispatch_count) || 0) + 1;\n`;
    
    content = content.slice(0, insertPoint) + insertText + content.slice(insertPoint);
    
    fs.writeFileSync('D:/cindy/publish-output/carlos-flow-cindy/src/index.js', content, 'utf8');
    console.log("Inserted dispatch_count increment");
} else {
    console.error("Could not find the pattern");
}