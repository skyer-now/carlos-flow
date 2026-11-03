import fs from 'fs';

const filePath = 'D:/cindy/publish-output/carlos-flow-cindy/src/index.js';
let content = fs.readFileSync(filePath, 'utf8');

// Find the exact position
const idx = content.indexOf('handler: async (args) => {', content.indexOf('name: "flow_dispatch"'));
console.log('Handler at:', idx);

// Get the exact text to replace
const searchStart = content.indexOf('handler: async (args) => {', content.indexOf('name: "flow_dispatch"'));
const searchEnd = content.indexOf('const prompt = buildContractPrompt', content.indexOf('handler: async (args) => {', content.indexOf('name: "flow_dispatch"')));

const oldText = content.substring(idx, content.indexOf('const prompt = buildContractPrompt', idx));
console.log('OLD TEXT TO REPLACE:');
console.log(JSON.stringify(content.substring(idx, idx + 400)));

process.exit(0);