'use strict';

const { nativeImage } = require('electron');
const { stageAttachment, stageAttachmentFiles } = require('../../attachment-store');
const { pruneAttachmentImages } = require('../../attachment-retention');
const { getAgentLimits } = require('../../agent/agent-limits');

/**
 * @param {object} ctx
 */
function registerAttachmentsIpc(ctx) {
  const { ipcMain, clipboard, getLocalGateway, getReadableDirPath, getUserDataPath } = ctx;

  /**
   * 附件落盘后后台修剪：容量超限时从最旧的图片开始原地降采样。
   * 不 await、失败静默——保留策略绝不能拖慢或影响正常发送。
   */
  function scheduleAttachmentRetention() {
    Promise.resolve()
      .then(() => {
        const userData = typeof getUserDataPath === 'function' ? getUserDataPath() : '';
        return pruneAttachmentImages({
          localGateway: getLocalGateway(),
          limits: getAgentLimits(userData, 'default')
        });
      })
      .catch(() => {
        /* 保留策略失败不影响发送 */
      });
  }

  ipcMain.handle('files:stage', async (_evt, filePaths) => {
    if (!Array.isArray(filePaths) || !filePaths.length) return [];
    const staged = await stageAttachmentFiles(
      { localGateway: getLocalGateway(), readableDirPath: getReadableDirPath(), userData: getUserDataPath() },
      filePaths
    );
    scheduleAttachmentRetention();
    return staged;
  });

  ipcMain.handle('files:stage-base64', async (_evt, payload) => {
    const name = payload && payload.name != null ? String(payload.name) : '';
    const base64 = payload && payload.base64 != null ? String(payload.base64) : '';
    const mime = payload && payload.mime ? String(payload.mime) : '';
    if (!name || !base64) return null;
    const buf = Buffer.from(base64, 'base64');
    const staged = await stageAttachment({
      localGateway: getLocalGateway(),
      readableDirPath: getReadableDirPath(),
      userData: getUserDataPath(),
      buffer: buf,
      originalName: name,
      mime: mime || 'application/octet-stream'
    });
    scheduleAttachmentRetention();
    return staged;
  });

  ipcMain.handle('clipboard:read-image', async () => {
    try {
      const img = clipboard.readImage();
      if (img && !img.isEmpty()) {
        const png = img.toPNG();
        if (png && png.length) {
          return {
            base64: png.toString('base64'),
            mime: 'image/png',
            name: `paste-${Date.now()}.png`
          };
        }
      }
      const formats = clipboard.availableFormats();
      for (const fmt of formats) {
        if (!/^image\//i.test(fmt) && fmt !== 'PNG' && fmt !== 'Device Independent Bitmap') continue;
        const buf = fmt === 'PNG' || /^image\//i.test(fmt) ? clipboard.readBuffer(fmt) : null;
        if (buf && buf.length) {
          const asImg = nativeImage.createFromBuffer(buf);
          const png = asImg && !asImg.isEmpty() ? asImg.toPNG() : buf;
          if (png && png.length) {
            return {
              base64: png.toString('base64'),
              mime: /^image\//i.test(fmt) ? fmt : 'image/png',
              name: `paste-${Date.now()}.png`
            };
          }
        }
      }
      return null;
    } catch {
      return null;
    }
  });
}

module.exports = { registerAttachmentsIpc };
