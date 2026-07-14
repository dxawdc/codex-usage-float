const fs = require('node:fs/promises');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const root = path.join(__dirname, '..');
const screenshotsDir = path.join(root, 'docs', 'screenshots');

async function waitForPaint(window, times = 2) {
  for (let index = 0; index < times; index += 1) {
    await window.webContents.executeJavaScript('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  }
}

async function capture(window, fileName, selector = null) {
  await waitForPaint(window);
  let image;
  if (selector) {
    const rect = await window.webContents.executeJavaScript(`
      (() => {
        const node = document.querySelector(${JSON.stringify(selector)});
        if (!node) return null;
        const rect = node.getBoundingClientRect();
        return {
          x: Math.max(0, Math.floor(rect.x)),
          y: Math.max(0, Math.floor(rect.y)),
          width: Math.ceil(rect.width),
          height: Math.ceil(rect.height)
        };
      })()
    `);
    if (!rect || rect.width <= 0 || rect.height <= 0) throw new Error(`Missing screenshot selector: ${selector}`);
    image = await window.webContents.capturePage(rect);
  } else {
    image = await window.webContents.capturePage();
  }
  await fs.writeFile(path.join(screenshotsDir, fileName), image.toPNG());
}

async function createWindow(partition) {
  const window = new BrowserWindow({
    width: 980,
    height: 860,
    show: false,
    backgroundColor: '#0f1420',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition,
      preload: path.join(__dirname, 'readme-screenshot-preload.cjs')
    }
  });
  await window.loadFile(path.join(root, 'src', 'renderer', 'index.html'));
  await waitForPaint(window, 3);
  return window;
}

async function main() {
  await app.whenReady();
  await fs.mkdir(screenshotsDir, { recursive: true });

  const dashboard = await createWindow('readme-dashboard');
  await dashboard.webContents.executeJavaScript(`
    (async () => {
      document.getElementById('orb').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 180));
    })()
  `);
  await capture(dashboard, 'multi-account-dashboard.png', '#panel');

  await dashboard.webContents.executeJavaScript(`
    (async () => {
      document.querySelector('.account-card:not(.is-current) .mini-button')?.click();
      await new Promise((resolve) => setTimeout(resolve, 120));
    })()
  `);
  await capture(dashboard, 'account-switch-confirm.png', '#confirmDialog .confirm-card');

  const settings = await createWindow('readme-settings');
  try {
    await settings.webContents.executeJavaScript(`
      (async () => {
        localStorage.setItem('codexUsageTheme', 'light');
        location.reload();
      })()
    `);
    await new Promise((resolve) => settings.webContents.once('did-finish-load', resolve));
    await waitForPaint(settings, 3);
    await settings.webContents.executeJavaScript(`
      (async () => {
        document.getElementById('orb').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        await new Promise((resolve) => setTimeout(resolve, 100));
        document.getElementById('pricingSettingsButton').click();
        await new Promise((resolve) => setTimeout(resolve, 100));
        document.getElementById('settingsPricingTab').click();
        await new Promise((resolve) => setTimeout(resolve, 100));
      })()
    `);
    await capture(settings, 'pricing-settings-light.png', '#pricingDialog .confirm-card');
  } finally {
    if (!settings.isDestroyed()) settings.destroy();
    if (!dashboard.isDestroyed()) dashboard.destroy();
  }

  app.quit();
}

main().catch((error) => {
  console.error(error);
  app.exit(1);
});
