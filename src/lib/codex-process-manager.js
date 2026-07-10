const { execFile } = require('child_process');

const DEFAULT_CODEX_APP_ID = 'OpenAI.Codex_2p2nqsd0c76g0!App';

function defaultPowerShellRunner(script, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: timeoutMs },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(String(stderr || error.message || error).trim()));
          return;
        }
        resolve(String(stdout || '').trim());
      }
    );
  });
}

function normalizeProcessList(value) {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list.map((item) => ({
    processId: Number(item.ProcessId ?? item.processId),
    parentProcessId: Number(item.ParentProcessId ?? item.parentProcessId),
    name: item.Name ?? item.name ?? '',
    executablePath: item.ExecutablePath ?? item.executablePath ?? '',
    commandLine: item.CommandLine ?? item.commandLine ?? ''
  })).filter((item) => Number.isFinite(item.processId));
}

function parsePowerShellJson(output, fallback = {}) {
  if (!output) return fallback;
  try {
    return JSON.parse(output);
  } catch {
    return fallback;
  }
}

function codexShellFilter() {
  return "$_.Name -eq 'ChatGPT.exe' -and $_.ExecutablePath -match '\\\\WindowsApps\\\\OpenAI\\.Codex_[^\\\\]+\\\\app\\\\ChatGPT\\.exe$'";
}

function relatedProcessBootstrap() {
  return `
    $all = @(Get-CimInstance Win32_Process)
    $shells = @($all | Where-Object { ${codexShellFilter()} })
    $orphanBackends = @($all | Where-Object {
      $_.Name -eq 'codex.exe' -and
      $_.ExecutablePath -match '\\\\WindowsApps\\\\OpenAI\\.Codex_[^\\\\]+\\\\app\\\\resources\\\\codex\\.exe$' -and
      $_.CommandLine -match 'app-server'
    })
    $tracked = New-Object 'System.Collections.Generic.HashSet[int]'
    $queue = New-Object 'System.Collections.Generic.Queue[int]'
    foreach ($item in @($shells) + @($orphanBackends)) {
      [void]$tracked.Add([int]$item.ProcessId)
      $queue.Enqueue([int]$item.ProcessId)
    }
    while ($queue.Count -gt 0) {
      $parentId = $queue.Dequeue()
      foreach ($child in @($all | Where-Object { [int]$_.ParentProcessId -eq $parentId })) {
        if ($tracked.Add([int]$child.ProcessId)) { $queue.Enqueue([int]$child.ProcessId) }
      }
    }
    $related = @($all | Where-Object { $tracked.Contains([int]$_.ProcessId) })
  `;
}

function createCodexProcessManager({
  platform = process.platform,
  runPowerShell = defaultPowerShellRunner,
  defaultAppId = DEFAULT_CODEX_APP_ID
} = {}) {
  async function getStatus() {
    if (platform !== 'win32') {
      return { platform, running: false, count: 0, processes: [], relatedProcesses: [], canAutoRestart: false };
    }
    const output = await runPowerShell(`
      ${relatedProcessBootstrap()}
      $startApp = @(Get-StartApps | Where-Object { $_.AppID -like 'OpenAI.Codex*!App' } | Select-Object -First 1)
      @{
        appId = if ($startApp.Count -gt 0) { $startApp[0].AppID } else { '${defaultAppId}' }
        canAutoRestart = $startApp.Count -gt 0
        shells = @($shells | Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine)
        related = @($related | Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine)
      } | ConvertTo-Json -Depth 5 -Compress
    `, 10000);
    const parsed = parsePowerShellJson(output);
    const processes = normalizeProcessList(parsed.shells);
    const relatedProcesses = normalizeProcessList(parsed.related);
    return {
      platform,
      running: relatedProcesses.length > 0,
      count: processes.length,
      processes,
      relatedProcesses,
      appId: parsed.appId || defaultAppId,
      canAutoRestart: Boolean(parsed.canAutoRestart)
    };
  }

  async function stop() {
    if (platform !== 'win32') {
      return { ok: false, runningBefore: false, stopped: false, message: '当前平台暂不支持自动关闭 Codex' };
    }
    const output = await runPowerShell(`
      ${relatedProcessBootstrap()}
      if ($related.Count -eq 0) {
        @{ ok = $true; runningBefore = $false; stopped = $true; graceful = $true; shellCount = 0; relatedCount = 0; remaining = @() } | ConvertTo-Json -Depth 4 -Compress
        exit 0
      }
      $shellIds = @($shells | ForEach-Object { [int]$_.ProcessId })
      $roots = @($shells | Where-Object { $shellIds -notcontains [int]$_.ParentProcessId })
      foreach ($item in $roots) {
        try {
          $process = Get-Process -Id ([int]$item.ProcessId) -ErrorAction Stop
          if ($process.MainWindowHandle -ne 0) { [void]$process.CloseMainWindow() }
        } catch {}
      }
      $deadline = (Get-Date).AddSeconds(8)
      do {
        Start-Sleep -Milliseconds 250
        $remaining = @($tracked | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
      } while ($remaining.Count -gt 0 -and (Get-Date) -lt $deadline)
      $graceful = $remaining.Count -eq 0
      if (-not $graceful) {
        foreach ($processId in @($remaining | Sort-Object -Descending)) {
          Stop-Process -Id ([int]$processId) -Force -ErrorAction SilentlyContinue
        }
        $forceDeadline = (Get-Date).AddSeconds(3)
        do {
          Start-Sleep -Milliseconds 200
          $remaining = @($tracked | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
        } while ($remaining.Count -gt 0 -and (Get-Date) -lt $forceDeadline)
      }
      $stopped = $remaining.Count -eq 0
      @{
        ok = $stopped
        runningBefore = $true
        stopped = $stopped
        graceful = $graceful
        shellCount = $shells.Count
        relatedCount = $related.Count
        remaining = @($remaining)
      } | ConvertTo-Json -Depth 4 -Compress
    `, 20000);
    const parsed = parsePowerShellJson(output, { ok: false, stopped: false });
    return {
      ...parsed,
      message: parsed.ok ? 'Codex 已完全关闭' : '仍检测到 Codex 后台进程，请手动结束后重试'
    };
  }

  async function launch() {
    if (platform !== 'win32') {
      return { ok: false, restarted: false, message: '当前平台暂不支持自动启动 Codex' };
    }
    try {
      const output = await runPowerShell(`
        $startApp = @(Get-StartApps | Where-Object { $_.AppID -like 'OpenAI.Codex*!App' } | Select-Object -First 1)
        $appId = if ($startApp.Count -gt 0) { $startApp[0].AppID } else { '${defaultAppId}' }
        Start-Process -FilePath 'explorer.exe' -ArgumentList "shell:AppsFolder\\$appId" | Out-Null
        $deadline = (Get-Date).AddSeconds(15)
        $stableChecks = 0
        do {
          Start-Sleep -Milliseconds 300
          ${relatedProcessBootstrap()}
          $hasBackend = @($related | Where-Object { $_.Name -eq 'codex.exe' }).Count -gt 0
          if ($shells.Count -gt 0 -and $hasBackend) { $stableChecks += 1 } else { $stableChecks = 0 }
        } while ($stableChecks -lt 4 -and (Get-Date) -lt $deadline)
        $ready = $stableChecks -ge 4
        @{
          ok = $ready
          restarted = $ready
          count = $shells.Count
          backendReady = $hasBackend
          appId = $appId
        } | ConvertTo-Json -Compress
      `, 22000);
      const result = parsePowerShellJson(output, { ok: false, restarted: false });
      return result.ok
        ? { ...result, message: 'Codex 已重新启动并检测到后台服务' }
        : { ...result, message: '未检测到 Codex 后台服务就绪，请手动打开应用' };
    } catch (error) {
      return {
        ok: false,
        restarted: false,
        message: `自动启动 Codex 失败：${String(error?.message || error || '未知错误')}`
      };
    }
  }

  return { getStatus, stop, launch };
}

module.exports = {
  DEFAULT_CODEX_APP_ID,
  createCodexProcessManager,
  defaultPowerShellRunner,
  normalizeProcessList,
  parsePowerShellJson
};
