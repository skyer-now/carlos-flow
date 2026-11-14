import fs from 'node:fs';

const files = fs.readdirSync('test').filter((f) => /\.(mjs|js)$/.test(f));
const counts = {};

for (const f of files) {
  const s = fs.readFileSync('test/' + f, 'utf8');
  const tools = [...new Set([...s.matchAll(/["'](flow_[a-z_]+)["']/g)].map((m) => m[1]))];
  for (const t of tools) {
    // 各种真实调用形式，逐个计数
    const patterns = [
      new RegExp(`(?:call|tool)\\s*\\(\\s*["']${t}["']`, 'g'),
      new RegExp(`name:\\s*["']${t}["']`, 'g'),
      new RegExp(`carlos\\.js\\"?\\s*\\)?\\s*,\\s*["']${t}["']`, 'g'),
      new RegExp(`\\.tool\\s*===?\\s*["']${t}["']`, 'g'),
    ];
    let n = 0;
    for (const p of patterns) {
      const m = s.match(p);
      if (m) n += m.length;
    }
    counts[t] = (counts[t] || 0) + n;
  }
}

console.log('工具'.padEnd(26) + '调用次数');
console.log('-'.repeat(40));
for (const t of Object.keys(counts).sort((a, b) => counts[b] - counts[a])) {
  console.log(t.padEnd(26) + String(counts[t]).padStart(6));
}
console.log('\n合计: ' + Object.values(counts).reduce((a, b) => a + b, 0));