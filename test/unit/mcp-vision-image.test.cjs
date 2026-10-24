'use strict';
/**
 * MCP 返回的图片必须真正进模型的眼睛。
 *
 * 背景（实测）：blender-mcp 的 `look` / `viewport_capture` / `viewport_latest` 都靠
 * MCP `content: [{type:'image'}]` 回传画面，而 runtime-manager 以前把它压成三个字
 * `[image]`，base64 塞进 `raw` 后被 spill 截断——模型知道「有图」，但永远看不到像素。
 *
 * 这里钉住两段契约：
 *   1) formatMcpCallResult：图片本体移到 visionImages，raw 里不留 base64；
 *   2) 视觉缓冲：source=mcp 能入队并出现在注入消息里。
 */
const assert = require('node:assert/strict');

const { formatMcpCallResult, extractMcpImages } = require('../../src/mcp/runtime-manager.js');
const {
  recordVisionImage,
  takePendingVisionImages,
  clearPendingVisionImages,
  buildVisionMessage,
  SOURCE_MCP,
  resolveVisionLimits
} = require('../../src/agent/browser-vision.js');

// 1x1 PNG
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function imageResult(extraParts = []) {
  return {
    content: [
      { type: 'text', text: 'viewport captured 1280x720' },
      { type: 'image', mimeType: 'image/png', data: PNG_BASE64 },
      ...extraParts
    ]
  };
}

describe('MCP 图片 → 视觉缓冲', () => {
  it('formatMcpCallResult 把图片移到 visionImages，raw 里不留 base64', () => {
    const out = formatMcpCallResult(imageResult());
    assert.equal(out.ok, true);
    assert.match(out.content, /viewport captured/);
    assert.match(out.content, /\[image\]/, '文本里保留 [image] 占位，纯文本模型也能知道有图');
    assert.equal(out.visionImages.length, 1);
    assert.equal(out.visionImages[0].mime, 'image/png');
    assert.equal(out.visionImages[0].base64, PNG_BASE64);

    // 关键：结果 JSON 里不能再出现 base64（否则会被 spill/cap 截断成乱码）
    const rest = { ...out };
    delete rest.visionImages;
    assert.equal(JSON.stringify(rest).includes(PNG_BASE64), false);
    assert.equal(JSON.stringify(out.raw || {}).includes(PNG_BASE64), false);
  });

  it('没有图片时不多出字段', () => {
    const out = formatMcpCallResult({ content: [{ type: 'text', text: 'ok' }] });
    assert.equal(out.visionImages, undefined);
    assert.equal(extractMcpImages({ content: [{ type: 'text', text: 'ok' }] }), null);
  });

  it('isError 时即使是图片结果也按错误返回', () => {
    const out = formatMcpCallResult({
      isError: true,
      content: [{ type: 'text', text: 'blender addon not connected' }]
    });
    assert.match(out.error, /not connected/);
  });

  it('source=mcp 能入队，并出现在注入消息里', () => {
    clearPendingVisionImages('run-mcp-1');
    const ok = recordVisionImage(
      'run-mcp-1',
      { source: SOURCE_MCP, tool: 'mcp_blender_look', mime: 'image/png', base64: PNG_BASE64 },
      undefined
    );
    assert.equal(ok, true);

    const images = takePendingVisionImages('run-mcp-1');
    assert.equal(images.length, 1);
    assert.equal(images[0].source, 'mcp', '不能被归一到 browser');

    const msg = buildVisionMessage(images);
    assert.equal(msg.role, 'user');
    assert.match(msg.content[0].text, /MCP 工具返回的画面/);
    assert.equal(msg.content.filter((p) => p.type === 'image_url').length, 1);
  });

  it('mcp 与 attachment 的来源分组互不影响', () => {
    clearPendingVisionImages('run-mcp-2');
    const limits = resolveVisionLimits({
      visionShotsPerRound: 2,
      visionReattachPerRound: 2,
      visionMaxBase64Chars: 4 * 1024 * 1024
    });
    recordVisionImage('run-mcp-2', { source: SOURCE_MCP, mime: 'image/png', base64: PNG_BASE64 }, limits);
    recordVisionImage(
      'run-mcp-2',
      { source: 'attachment', path: 'a.png', mime: 'image/png', base64: PNG_BASE64 },
      limits
    );
    const images = takePendingVisionImages('run-mcp-2');
    const msg = buildVisionMessage(images);
    const text = msg.content[0].text;
    assert.match(text, /历史附件图片（1 张/);
    assert.match(text, /MCP 工具返回的画面（1 张）/);
  });
});
