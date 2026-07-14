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
        const resetCardInline = document.querySelector('.account-reset-card-inline');
        const resetCardText = resetCardInline?.textContent;
        const resetCardWeight = getComputedStyle(resetCardInline).fontWeight;
        document.getElementById('refreshButton').click();
        await new Promise((resolve) => setTimeout(resolve, 100));
        const orbAnimationTriggered = document.getElementById('orb').classList.contains('is-updating');
        await new Promise((resolve) => setTimeout(resolve, 620));
        const refreshedPercent = document.getElementById('percentText').textContent;
        const selectStyle = getComputedStyle(select);
        const optionStyle = getComputedStyle(option);
        const refreshTab = document.getElementById('settingsRefreshTab');
        const pricingTab = document.getElementById('settingsPricingTab');
        const displayTab = document.getElementById('settingsDisplayTab');
        const refreshPanel = document.getElementById('refreshSettingsPanel');
        const pricingPanel = document.getElementById('pricingSettingsPanel');
        const displayPanel = document.getElementById('displaySettingsPanel');
        const tabsLayout = getComputedStyle(document.querySelector('.settings-tabs')).flexDirection;
        const defaultInterval = document.getElementById('refreshIntervalField').value;
        document.querySelector('[data-local-range="lifetime"]').click();
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const lifetimeCompactVisible = !document.getElementById('localCompactGrid').hidden;
        const modelColumns = getComputedStyle(document.getElementById('localModelBreakdown')).gridTemplateColumns;
        pricingTab.click();
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const pricingTabVisible = !pricingPanel.hidden && refreshPanel.hidden;
        displayTab.click();
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const displayTabVisible = !displayPanel.hidden && refreshPanel.hidden && pricingPanel.hidden;
        refreshTab.click();
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const dialogOpen = !document.getElementById('pricingDialog').hidden;
        const closeButton = document.getElementById('closePricingButton');
        closeButton.click();
        await new Promise((resolve) => requestAnimationFrame(resolve));
        return {
          dialogOpen,
          optionCount: select.options.length,
          resetCardText,
          resetCardWeight,
          orbAnimationTriggered,
          refreshedPercent,
          theme: document.documentElement.dataset.theme,
          colorScheme: selectStyle.colorScheme,
          optionBackground: optionStyle.backgroundColor,
          optionColor: optionStyle.color,
          settingsTabs: Boolean(refreshTab && pricingTab && displayTab),
          pricingTabVisible,
          displayTabVisible,
          tabsLayout,
          defaultInterval,
          lifetimeCompactVisible,
          modelColumns,
          closeButtonWorks: document.getElementById('pricingDialog').hidden
        };
      })();
    `);

    assert.equal(result.dialogOpen, true, 'pricing dialog did not open');
    assert.ok(result.optionCount >= 1, 'pricing select has no options');
    assert.equal(result.resetCardText, '可用重置卡 3 张', 'account card does not show its available reset-card count');
    assert.equal(result.resetCardWeight, '400', 'account reset-card count should not be bold');
    assert.equal(result.orbAnimationTriggered, true, 'orb did not animate when the remaining percentage changed');
    assert.equal(result.refreshedPercent, '57%', 'orb did not finish at the refreshed percentage');
    assert.equal(result.theme, 'dark', 'smoke window did not start in dark theme');
    assert.equal(result.colorScheme, 'dark', 'pricing select does not declare a dark native control scheme');
    assert.notEqual(result.optionBackground, 'rgba(0, 0, 0, 0)', 'pricing option background is transparent');
    assert.notEqual(result.optionColor, 'rgba(0, 0, 0, 0)', 'pricing option text color is transparent');
    assert.equal(result.settingsTabs, true, 'settings center tabs are missing');
    assert.equal(result.pricingTabVisible, true, 'pricing tab did not switch');
    assert.equal(result.displayTabVisible, true, 'display mode tab did not switch');
    assert.equal(result.tabsLayout, 'column', 'settings tabs are not displayed on the left');
    assert.equal(result.defaultInterval, '30', 'refresh interval default is not 30 minutes');
    assert.equal(result.lifetimeCompactVisible, true, 'lifetime local summary is not visible');
    assert.match(result.modelColumns, /repeat\(2,/, 'local model usage is not displayed in two columns');
    assert.equal(result.closeButtonWorks, true, 'settings close button did not close the dialog');
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
