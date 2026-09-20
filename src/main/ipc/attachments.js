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
    // Electron 44 起 clipboard 收敛为 W3C 风格：read() 返回 ClipboardItem[]，
    // readImage/readBuffer/availableFormats 已移除，图片字节走 item.getType(mime)。
    try {
      const items = await clipboard.read();
      for (const item of items || []) {
        const imgType = ((item && item.types) || []).find(
          (t) => typeof t === 'string' && /^image\//i.test(t)
        );
        if (!imgType) continue;
        const blob = await item.getType(imgType);
        if (!blob) continue;
        let buf = Buffer.from(await blob.arrayBuffer());
        if (!buf.length) continue;
        let mime = imgType;
        if (imgType !== 'image/png') {
          const asImg = nativeImage.createFromBuffer(buf);
          if (asImg && !asImg.isEmpty()) {
            buf = asImg.toPNG();
            mime = 'image/png';
          }
        }
        if (buf.length) {
          const ext =
            mime === 'image/png'
              ? 'png'
              : String(mime.slice('image/'.length) || '').replace(/[^a-z0-9]/gi, '') || 'png';
          return {
            base64: buf.toString('base64'),
            mime,
            name: `paste-${Date.now()}.${ext}`
          };
        }
      }
      return null;
    } catch {
      return null;
    }
  });
}

module.exports = { registerAttachmentsIpc };
