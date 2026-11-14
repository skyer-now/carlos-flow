import fs from 'node:fs';

const files = fs.readdirSync('test').filter((f) => /\.(mjs|js)$/.test(f));
const realFiles = {};   // 工具 -> Set(文件名)，存在真实调用
const onlyRef = {};     // 工具 -> Set(文件名)，只被提及（注释/断言检查）

for (const f of files) {
  const s = fs.readFileSync('test/' + f, 'utf8');
  const tools = [...new Set([...s.matchAll(/["'](flow_[a-z_]+)["']/g)].map((m) => m[1]))];
  for (const t of tools) {
    // 真实调用的几种形式
    const patterns = [
      new RegExp(`(?:call|tool)\\s*\\(\\s*["']${t}["']`),
      new RegExp(`name:\\s*["']${t}["']`),
      new RegExp('carlos\\.js\"?\\s*\\)?\\s*,\\s*["\']' + t + '["\']'),
      new RegExp(`\\.tool\\s*===?\\s*["']${t}["']`),
    ];
    const isReal = patterns.some((p) => p.test(s));
    const bucket = isReal ? realFiles : onlyRef;
    (bucket[t] = bucket[t] || new Set()).add(f);
  }
}

console.log('工具'.padEnd(26) + '真调用文件'.padStart(10) + '  仅提及文件');
console.log('-'.repeat(64));
const all = [...new Set([...Object.keys(realFiles), ...Object.keys(onlyRef)])].sort();
for (const t of all) {
  const r = realFiles[t] ? realFiles[t].size : 0;
  const o = onlyRef[t] ? onlyRef[t].size : 0;
  console.log(t.padEnd(26) + String(r).padStart(10) + '  ' + o);
}
console.log('\n=== 真调用文件明细 ===');
for (const t of Object.keys(realFiles).sort()) {
  console.log(t + ' [' + realFiles[t].size + ']: ' + [...realFiles[t]].sort().join(', '));
}