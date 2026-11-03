import fs from 'fs';

const filePath = 'D:/cindy/publish-output/carlos-flow-cindy/src/index.js';
let content = fs.readFileSync(filePath, 'utf8');

// Build the exact search string from the file
const searchLines = [
    '        handler: async (args) => {',
    '      try {',
    '        const a = args || {};',
    '        const sessionId = a.sessionId || "unknown";',
    '        const role = a.role === "auditor" ? "auditor" : "executor";',
    '        const cwd = a.cwd || process.cwd();',
    '        const state = loadState(sessionId);',
    '',
    '        if (!state.card) return fail("没有留痕，不允许派发。");'
];

const searchText = searchLines.join('\n');

console.log('Search text length:', searchText.length);
console.log('Search text:');
console.log(JSON.stringify(searchText));

const idx = content.indexOf(searchText);
console.log('Index:', idx);

if (idx === -1) {
    console.error('ERROR: Pattern not found');
    // Debug: show what we're looking for vs what's there
    const idx2 = content.indexOf('handler: async (args) => {', content.indexOf('name: "flow_dispatch"'));
    console.log('Found handler at:', content.indexOf('handler: async (args) => {', content.indexOf('name: "flow_dispatch"')));
    const context = content.substring(content.indexOf('handler: async (args) => {', content.indexOf('name: "flow_dispatch"')), content.indexOf('handler: async (args) => {', content.indexOf('name: "flow_dispatch"')) + 400);
    console.log('Context:', JSON.stringify(content.substring(content.indexOf('handler: async (args) => {', content.indexOf('name: "flow_dispatch"')), content.indexOf('handler: async (args) => {', content.indexOf('name: "flow_dispatch"')) + 400)));
    process.exit(1);
}

console.log('Found at:', idx);