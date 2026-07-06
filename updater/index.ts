import { app, dialog } from 'electron'
import type { BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { logService } from '../backend/services/log.service'

export function initUpdater(win: BrowserWindow): void {
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false

  autoUpdater.on('checking-for-update', () => {
    logService.info('UPDATER', `Provjera azuriranja launchera (${app.getVersion()})...`)
    win.webContents.send('update:checking')
  })

  autoUpdater.on('update-available', async (info) => {
    logService.info('UPDATER', `Dostupna nova verzija: ${info.version}`)
    win.webContents.send('update:available', info)

    const choice = await dialog.showMessageBox(win, {
      type: 'info',
      title: 'Dostupno azuriranje',
      message: `Dostupna je nova verzija launchera: ${info.version}`,
      detail: `Trenutna verzija: ${app.getVersion()}\n\nZelis li sada preuzeti azuriranje? Ako odaberes kasnije, mozes nastaviti koristiti staru verziju.`,
      buttons: ['Preuzmi update', 'Kasnije'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    })

    if (choice.response !== 0) {
      logService.info('UPDATER', `Korisnik je preskocio update ${info.version}`)
      return
    }

    logService.info('UPDATER', `Preuzimanje update-a ${info.version}`)
    autoUpdater.downloadUpdate().catch((err) => {
      const msg = err instanceof Error ? err.message : String(err)
      logService.warning('UPDATER', `Greska preuzimanja azuriranja: ${msg}`)
    })
  })

  autoUpdater.on('update-not-available', () => {
    logService.success('UPDATER', 'Koristite najnoviju verziju launchera')
    win.webContents.send('update:not-available')
  })

  autoUpdater.on('download-progress', (progress) => {
    win.webContents.send('update:progress', progress)
  })

  autoUpdater.on('update-downloaded', async (info) => {
    logService.success('UPDATER', `Azuriranje preuzeto: ${info.version}. Restart za instalaciju.`)
    win.webContents.send('update:downloaded', info)

    const choice = await dialog.showMessageBox(win, {
      type: 'info',
      title: 'Azuriranje je spremno',
      message: `Verzija ${info.version} je preuzeta.`,
      detail: 'Zelis li odmah restartati launcher i instalirati update?',
      buttons: ['Restartaj sada', 'Kasnije'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    })

    if (choice.response === 0) {
      autoUpdater.quitAndInstall(false, true)
    }
  })

  autoUpdater.on('error', (err) => {
    logService.warning('UPDATER', `Greska provjere azuriranja: ${err.message}`)
  })

  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {
      // Ignore update check errors in dev mode or unpacked builds.
    })
  }, 5000)
}
