const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

// Hidden-window screenshots need a software compositor on headless Windows.
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 744, height: 850, show: false, webPreferences: {
    preload: path.join(__dirname, 'electron-reset-credit-preload.cjs'),
    contextIsolation: true, sandbox: true, backgroundThrottling: false, partition: 'reset-credit-smoke'
  } });
  const errors = [];
  window.webContents.on('console-message', (_event, details) => {
    if (details.level === 'error') errors.push(details.message);
  });
  const run = (source) => window.webContents.executeJavaScript(source);
  try {
    await window.loadFile(path.join(__dirname, '..', 'src/renderer/index.html'));
    await run('setPanelOpen(true)');
    await run(`document.querySelector('.reset-card-use').click()`);
    assert.equal(await run('els.resetCreditDialog.hidden'), false);
    assert.match(await run('els.resetCreditBody.textContent'), /测试账号.*1 张.*不可撤销/);
    await run('els.cancelResetCreditButton.click()');
    assert.equal(await run('window.resetCreditTest.calls().length'), 0);
    await run(`document.querySelector('.reset-card-use').click()`);
    await run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await fs.mkdir(path.join(__dirname, '..', 'dist', 'verification'), { recursive: true });
    await fs.writeFile(path.join(__dirname, '..', 'dist', 'verification', 'reset-credit-confirm.png'), (await window.webContents.capturePage()).toPNG());
    for (const height of [650, 850]) {
      window.setSize(744, height);
      assert.equal(await run(`(() => {
        const r = els.resetCreditDialog.querySelector('.confirm-card').getBoundingClientRect();
        return r.width > 0 && r.x >= 0 && r.right <= innerWidth && r.y >= 0 && r.bottom <= innerHeight;
      })()`), true, `confirmation must fit ${height}px window`);
    }
    await run(`window.resetCreditTest.setFailure(true); els.useResetCreditButton.click(); els.useResetCreditButton.click()`);
    await run('new Promise(resolve => setTimeout(resolve, 160))');
    assert.equal(await run('window.resetCreditTest.calls().length'), 1);
    assert.match(await run('els.resetCreditStatus.textContent'), /无法确认/);
    assert.equal(await run('els.useResetCreditButton.textContent'), '重试此卡');
    await run('window.resetCreditTest.setFailure(false); els.useResetCreditButton.click()');
    await run('new Promise(resolve => setTimeout(resolve, 160))');
    const calls = await run('window.resetCreditTest.calls()');
    assert.deepEqual(calls[0], { accountKey: 'account-a', creditId: 'credit-1' });
    assert.deepEqual(calls[0], calls[1]);
    assert.match(await run('els.resetCreditStatus.textContent'), /使用成功/);
    assert.equal(await run('els.useResetCreditButton.hidden'), true);
    assert.equal(await run('document.querySelectorAll(".reset-card-use").length'), 0);
    await run('els.cancelResetCreditButton.click(); state.snapshot = window.resetCreditTest.reset(); state.snapshot.resetCards[0].id = null; render()');
    assert.equal(await run('document.querySelector(".reset-card-use").disabled'), true);
    await run('state.usedResetCredits.clear(); state.snapshot = window.resetCreditTest.reset(); render(); window.resetCreditTest.setRefreshPending(true); document.querySelector(".reset-card-use").click(); els.useResetCreditButton.click()');
    await run('new Promise(resolve => setTimeout(resolve, 160))');
    assert.equal(await run('els.useResetCreditButton.hidden'), true);
    assert.equal(await run('document.querySelector(".reset-card-use").disabled'), true);
    assert.equal(await run('document.querySelector(".reset-card-use").textContent'), '已使用');
    assert.match(await run('els.resetCreditStatus.textContent'), /使用成功.*手动刷新/);
    assert.deepEqual(errors, []);
    console.log('Reset credit UI smoke passed: confirmation, cancellation, double-click, retry, success, missing ID, compact window; no console errors');
  } finally { window.destroy(); }
  app.exit(0);
}).catch((error) => { console.error(error); app.exit(1); });
