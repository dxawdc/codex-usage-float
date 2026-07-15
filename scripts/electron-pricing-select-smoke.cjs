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
        const resetCardInlines = [...document.querySelectorAll('.account-reset-card-inline')];
        const resetCardInline = resetCardInlines[0];
        const emptyResetCardInline = resetCardInlines[1];
        const resetCardText = resetCardInline?.textContent;
        const emptyResetCardText = emptyResetCardInline?.textContent;
        const resetCardWeight = getComputedStyle(resetCardInline).fontWeight;
        const resetCardColor = getComputedStyle(resetCardInline).color;
        const emptyResetCardColor = getComputedStyle(emptyResetCardInline).color;
        const colorProbe = document.createElement('span');
        document.body.appendChild(colorProbe);
        colorProbe.style.color = 'var(--success-ink)';
        const successColor = getComputedStyle(colorProbe).color;
        colorProbe.style.color = 'var(--muted)';
        const mutedColor = getComputedStyle(colorProbe).color;
        colorProbe.remove();
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
        const orbTab = document.getElementById('settingsOrbTab');
        const refreshPanel = document.getElementById('refreshSettingsPanel');
        const pricingPanel = document.getElementById('pricingSettingsPanel');
        const displayPanel = document.getElementById('displaySettingsPanel');
        const orbPanel = document.getElementById('orbSettingsPanel');
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
        orbTab.click();
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const orbTabVisible = !orbPanel.hidden && refreshPanel.hidden && pricingPanel.hidden && displayPanel.hidden;
        const orbStyleFields = [...document.querySelectorAll('input[name="orbStyle"]')];
        const orbStyleIds = orbStyleFields.map((field) => field.value);
        const setRemaining = (remaining) => {
          const currentAccount = {
            ...state.snapshot.currentAccount,
            usageWindows: { fiveHour: { remainingPercent: remaining } }
          };
          state.snapshot = {
            ...state.snapshot,
            currentAccount,
            accounts: (state.snapshot.accounts || []).map((account) => ({
              ...account,
              usageWindows: { fiveHour: { remainingPercent: remaining } }
            }))
          };
          render();
        };
        const accentProbe = document.createElement('span');
        document.body.appendChild(accentProbe);
        const percentageColorChecks = [];
        const indicatorSignatures = Object.fromEntries(orbStyleIds.map((style) => [style, []]));
        for (const remaining of [69, 42, 18, 8]) {
          setRemaining(remaining);
          accentProbe.style.color = 'var(--accent)';
          const expectedColor = getComputedStyle(accentProbe).color;
          for (const style of orbStyleIds) {
            applyOrbStyle(style);
            const percentColor = getComputedStyle(document.getElementById('percentText')).color;
            percentageColorChecks.push({ remaining, style, matches: percentColor === expectedColor });
            const ring = document.querySelector('.ring');
            const signature = style === 'pixel'
              ? getComputedStyle(document.querySelector('.pixel-eyes i')).backgroundColor
              : style === 'flip'
                ? getComputedStyle(ring, '::before').backgroundImage
                : getComputedStyle(ring).backgroundImage + getComputedStyle(ring, '::before').backgroundImage;
            indicatorSignatures[style].push(signature);
          }
        }
        accentProbe.remove();
        const indicatorColorsFollowQuota = Object.fromEntries(
          Object.entries(indicatorSignatures).map(([style, signatures]) => [style, new Set(signatures).size === 4])
        );
        const themeSurfaceChanges = {};
        for (const style of ['aurora', 'pixel', 'flip']) {
          applyOrbStyle(style);
          applyTheme('dark');
          const darkSurface = getComputedStyle(document.querySelector('.ring')).backgroundImage
            + getComputedStyle(document.querySelector('.orb-core')).backgroundImage;
          applyTheme('light');
          const lightSurface = getComputedStyle(document.querySelector('.ring')).backgroundImage
            + getComputedStyle(document.querySelector('.orb-core')).backgroundImage;
          themeSurfaceChanges[style] = darkSurface !== lightSurface;
        }
        applyTheme('dark');
        const auroraField = orbStyleFields.find((field) => field.value === 'aurora');
        auroraField.checked = true;
        auroraField.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const livePreviewStyle = document.getElementById('orb').dataset.orbStyle;
        document.getElementById('closePricingButton').click();
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const unsavedStyleReverted = document.getElementById('orb').dataset.orbStyle;
        document.getElementById('pricingSettingsButton').click();
        orbTab.click();
        const pixelField = orbStyleFields.find((field) => field.value === 'pixel');
        pixelField.checked = true;
        pixelField.dispatchEvent(new Event('change', { bubbles: true }));
        document.getElementById('savePricingButton').click();
        await new Promise((resolve) => setTimeout(resolve, 20));
        document.getElementById('closePricingButton').click();
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const savedOrbStyle = document.getElementById('orb').dataset.orbStyle;
        document.getElementById('pricingSettingsButton').click();
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
          emptyResetCardText,
          resetCardWeight,
          resetCardColor,
          emptyResetCardColor,
          successColor,
          mutedColor,
          orbAnimationTriggered,
          refreshedPercent,
          theme: document.documentElement.dataset.theme,
          colorScheme: selectStyle.colorScheme,
          optionBackground: optionStyle.backgroundColor,
          optionColor: optionStyle.color,
          settingsTabs: Boolean(refreshTab && pricingTab && displayTab && orbTab),
          pricingTabVisible,
          displayTabVisible,
          orbTabVisible,
          orbStyleCount: orbStyleFields.length,
          percentageColorChecks,
          indicatorColorsFollowQuota,
          themeSurfaceChanges,
          livePreviewStyle,
          unsavedStyleReverted,
          savedOrbStyle,
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
    assert.equal(result.resetCardText, 'reset*3', 'account card does not show its available reset-card count');
    assert.equal(result.emptyResetCardText, 'reset*0', 'empty account card does not show zero reset-card count');
    assert.equal(result.resetCardWeight, '400', 'account reset-card count should not be bold');
    assert.equal(result.resetCardColor, result.successColor, 'positive reset-card count should use the success color');
    assert.equal(result.emptyResetCardColor, result.mutedColor, 'zero reset-card count should use the regular color');
    assert.equal(result.orbAnimationTriggered, true, 'orb did not animate when the remaining percentage changed');
    assert.equal(result.refreshedPercent, '57%', 'orb did not finish at the refreshed percentage');
    assert.equal(result.theme, 'dark', 'smoke window did not start in dark theme');
    assert.equal(result.colorScheme, 'dark', 'pricing select does not declare a dark native control scheme');
    assert.notEqual(result.optionBackground, 'rgba(0, 0, 0, 0)', 'pricing option background is transparent');
    assert.notEqual(result.optionColor, 'rgba(0, 0, 0, 0)', 'pricing option text color is transparent');
    assert.equal(result.settingsTabs, true, 'settings center tabs are missing');
    assert.equal(result.pricingTabVisible, true, 'pricing tab did not switch');
    assert.equal(result.displayTabVisible, true, 'display mode tab did not switch');
    assert.equal(result.orbTabVisible, true, 'orb style tab did not switch');
    assert.equal(result.orbStyleCount, 4, 'orb style chooser must offer four styles');
    assert.equal(result.percentageColorChecks.every((check) => check.matches), true, 'orb percentage color does not follow the quota color rule');
    assert.deepEqual(result.indicatorColorsFollowQuota, { classic: true, aurora: true, pixel: true, flip: true }, 'orb indicators do not follow quota colors');
    assert.deepEqual(result.themeSurfaceChanges, { aurora: true, pixel: true, flip: true }, 'custom orb surfaces do not react to theme changes');
    assert.equal(result.livePreviewStyle, 'aurora', 'orb style did not preview immediately');
    assert.equal(result.unsavedStyleReverted, 'classic', 'closing settings did not revert an unsaved orb preview');
    assert.equal(result.savedOrbStyle, 'pixel', 'saved orb style did not remain active after closing settings');
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
