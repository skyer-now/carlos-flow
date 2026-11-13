import net from 'node:net';
import { performance } from 'node:perf_hooks';

const PORT = 19099;
const EXPECTED_TOOLS_COUNT = 19;

async function runRpcTest() {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const client = net.createConnection({ port: PORT, host: '127.0.0.1' }, () => {
      console.log('>>> Connected to Bridge.');
      
      // 1. Send Initialize
      const initReq = {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "smoke-test", version: "1.0.0" }
        }
      };
      client.write(JSON.stringify(initReq) + '\n');
    });

    let buffer = '';
    let initialized = false;

    client.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          
          if (msg.id === 1 && msg.result) {
            console.log('✅ Initialize response received.');
            initialized = true;
            
            // 2. Send tools/list
            const listReq = {
              jsonrpc: "2.0",
              id: 2,
              method: "tools/list",
              params: {}
            };
            client.write(JSON.stringify(listReq) + '\n');
          } 
          else if (msg.id === 2 && msg.result) {
            const toolCount = msg.result.tools?.length || 0;
            const end = performance.now();
            
            console.log(`>>> Total time: ${(end - start).toFixed(2)}ms`);
            console.log(`>>> Tools discovered: ${toolCount}`);
            
            if (toolCount === EXPECTED_TOOLS_COUNT) {
              resolve(true);
            } else {
              reject(new Error(`Expected ${EXPECTED_TOOLS_COUNT} tools, got ${toolCount}. Compatibility FAILED.`));
            }
            client.end();
          }
        } catch (e) {
          // Ignore parse errors for partial lines
        }
      }
    });

    client.on('error', (err) => reject(err));
    
    // Timeout safety
    setTimeout(() => {
      client.destroy();
      reject(new Error('RPC Test timed out'));
    }, 5000);
  });
}

// Start Bridge first
import { spawn } from 'node:child_process';
const bridgeProc = spawn(process.execPath, ['bridge/mcp-bridge.js'], { stdio: 'ignore' });

await new Promise(r => setTimeout(r, 1500)); // Wait for bridge startup

try {
  await runRpcTest();
  console.log('🎉 SUCCESS: Deep compatibility verified via real RPC round-trip.');
  process.exit(0);
} catch (err) {
  console.error(`💥 FAILURE: ${err.message}`);
  process.exit(1);
} finally {
  bridgeProc.kill();
}