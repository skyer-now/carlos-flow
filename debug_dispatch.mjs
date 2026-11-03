import fs from 'fs';

const filePath = 'D:/cindy/publish-output/carlos-flow-cindy/src/index.js';
let content = fs.readFileSync(filePath, 'utf8');

// Find the exact handler text
const startIdx = content.indexOf('handler: async (args) => {', content.indexOf('name: "flow_dispatch"'));
console.log('Handler at:', startIdx);

// Find the exact old text
const searchStart = content.indexOf('handler: async (args) => {', content.indexOf('name: "flow_dispatch"'));
const handlerEnd = content.indexOf('const prompt = buildContractPrompt', content.indexOf('handler: async (args) => {', content.indexOf('name: "flow_dispatch"')));

const oldText = content.substring(handlerEnd, content.indexOf('const prompt = buildContractPrompt', handlerEnd) + 50);

console.log('Found text:');
console.log(JSON.stringify(content.substring(startIdx, startIdx + 800)));

process.exit(0);