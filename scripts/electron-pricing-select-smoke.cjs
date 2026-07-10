const assert = require('node:assert/strict');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

async function main() {
  await app.whenReady();
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: 'pricing-select-smoke',
      preload: path.join(__dirname, 'electron-pricing-select-preload.cjs')
    }
  });

  try {
    await window.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
    const result = await window.webContents.executeJavaScript(`
      (async () => {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        document.getElementById('pricingSettingsButton').click();
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const select = document.getElementById('pricingModelSelect');
        const option = select.options[0];
        const selectStyle = getComputedStyle(select);
        const optionStyle = getComputedStyle(option);
        return {
          dialogOpen: !document.getElementById('pricingDialog').hidden,
          optionCount: select.options.length,
          theme: document.documentElement.dataset.theme,
          colorScheme: selectStyle.colorScheme,
          optionBackground: optionStyle.backgroundColor,
          optionColor: optionStyle.color
        };
      })();
    `);

    assert.equal(result.dialogOpen, true, 'pricing dialog did not open');
    assert.ok(result.optionCount >= 1, 'pricing select has no options');
    assert.equal(result.theme, 'dark', 'smoke window did not start in dark theme');
    assert.equal(result.colorScheme, 'dark', 'pricing select does not declare a dark native control scheme');
    assert.notEqual(result.optionBackground, 'rgba(0, 0, 0, 0)', 'pricing option background is transparent');
    assert.notEqual(result.optionColor, 'rgba(0, 0, 0, 0)', 'pricing option text color is transparent');
    console.log(`Pricing select smoke test passed: ${result.optionCount} options, ${result.colorScheme} native scheme`);
  } finally {
    if (!window.isDestroyed()) window.destroy();
    app.quit();
  }
}

main().catch((error) => {
  console.error(error);
  app.exit(1);
});
