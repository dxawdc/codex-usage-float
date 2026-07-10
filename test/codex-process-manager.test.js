const test = require('node:test');
const assert = require('node:assert/strict');
const { createCodexProcessManager, normalizeProcessList } = require('../src/lib/codex-process-manager');

test('normalizes singleton PowerShell process results', () => {
  assert.deepEqual(normalizeProcessList({
    ProcessId: 12,
    ParentProcessId: 3,
    Name: 'codex.exe',
    ExecutablePath: 'C:\\codex.exe'
  }), [{
    processId: 12,
    parentProcessId: 3,
    name: 'codex.exe',
    executablePath: 'C:\\codex.exe',
    commandLine: ''
  }]);
});

test('treats an orphan app-server as a running Codex instance', async () => {
  let scriptSeen = '';
  const manager = createCodexProcessManager({
    platform: 'win32',
    runPowerShell: async (script) => {
      scriptSeen = script;
      return JSON.stringify({
        appId: 'OpenAI.Codex_test!App',
        canAutoRestart: true,
        shells: [],
        related: [{ ProcessId: 9, ParentProcessId: 1, Name: 'codex.exe', CommandLine: 'app-server' }]
      });
    }
  });
  const status = await manager.getStatus();
  assert.equal(status.running, true);
  assert.equal(status.relatedProcesses.length, 1);
  assert.match(scriptSeen, /orphanBackends/);
  assert.match(scriptSeen, /app-server/);
});

test('requires backend readiness when launching', async () => {
  let scriptSeen = '';
  const manager = createCodexProcessManager({
    platform: 'win32',
    runPowerShell: async (script) => {
      scriptSeen = script;
      return JSON.stringify({ ok: true, restarted: true, backendReady: true, count: 7 });
    }
  });
  const result = await manager.launch();
  assert.equal(result.ok, true);
  assert.equal(result.backendReady, true);
  assert.match(scriptSeen, /stableChecks/);
  assert.match(scriptSeen, /codex\.exe/);
});
