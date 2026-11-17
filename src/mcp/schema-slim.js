'use strict';

/**
 * MCP 远端工具的参数瘦身：远端 schema 常常又深又长，直接塞进工具表会吃掉上下文。
 * 唯一用途是「给模型看的精简版」——真实校验仍用远端原 schema（`validateMcpInputArgs`）。
 */

function slimMcpProp(prop, depth) {
  if (!prop || typeof prop !== 'object') return { type: 'string' };
  const out = {};
  if (prop.type) out.type = prop.type;
  if (prop.description) {
    out.description = String(prop.description).replace(/\s+/g, ' ').trim().slice(0, 120);
  }
  if (Array.isArray(prop.enum) && prop.enum.length && prop.enum.length <= 16) {
    out.enum = prop.enum;
  }
  const nestedObject = prop.type === 'object' || (prop.properties && typeof prop.properties === 'object');
  if (prop.type === 'array' && prop.items && depth < 2) {
    out.items = slimMcpProp(prop.items, depth + 1);
  } else if (nestedObject && depth < 1) {
    out.properties = slimMcpProperties(prop.properties, depth + 1);
    if (Array.isArray(prop.required) && prop.required.length) out.required = prop.required.slice();
  } else if (nestedObject) {
    out.type = out.type || 'object';
    out.description = `${out.description || '对象'}（嵌套字段见 mcp_tool_schema）`;
  }
  return out;
}

function slimMcpProperties(properties, depth) {
  const src = properties && typeof properties === 'object' ? properties : {};
  const out = {};
  for (const key of Object.keys(src)) {
    out[key] = slimMcpProp(src[key], depth);
  }
  return out;
}

/** Keep required + first-level types so models do not call mcp_* with {}. */
function slimMcpInputSchema(schema) {
  const src = schema && typeof schema === 'object' ? schema : {};
  if (src.type && src.type !== 'object' && !src.properties) {
    return { type: src.type, description: String(src.description || '').slice(0, 120) };
  }
  const out = {
    type: 'object',
    properties: slimMcpProperties(src.properties, 0)
  };
  if (Array.isArray(src.required) && src.required.length) out.required = src.required.slice();
  if (src.additionalProperties === false) out.additionalProperties = false;
  return out;
}

function compactMcpToolDef(entry) {
  const fn = entry.tool && entry.tool.function ? entry.tool.function : {};
  const shortDesc = String(fn.description || (entry.candidate && entry.candidate.description) || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 96);
  const rawSchema =
    fn.parameters && typeof fn.parameters === 'object'
      ? fn.parameters
      : { type: 'object', properties: {} };
  const parameters = slimMcpInputSchema(rawSchema);
  const hasProps = Object.keys(parameters.properties || {}).length > 0;
  return {
    type: 'function',
    function: {
      name: fn.name,
      description: hasProps ? shortDesc : `${shortDesc}（无列出参数时用 mcp_tool_schema）`,
      parameters
    }
  };
}

module.exports = {
  slimMcpInputSchema,
  compactMcpToolDef
};
