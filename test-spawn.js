import { spawn } from 'node:child_process';
const child = spawn(process.execPath, ['-e', 'console.log("test"); setTimeout(() => {}, 5000)'], {
  windowsHide: true
});
console.log(`Child PID: ${child.pid}`);
setTimeout(() => { child.kill(); }, 6000);
