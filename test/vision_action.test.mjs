/**
 * 多模态看图：用假的宿主 llm/attachments 验证 action=figure_from_image 真的走模型，
 * 以及「模型不支持图片」时明确报错（不退化成瞎猜）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import * as impl from '../lib/impl.mjs'

const ONE_PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function mockCtx({ vision = true, output = null } = {}) {
  const calls = { stream: [], saved: [] }
  const payload = output === null
    ? JSON.stringify({
      chart: 'volcano',
      chart_label_zh: '火山图',
      x_axis: 'log2 fold change',
      y_axis: '-log10(P)',
      group_or_color: '上调/下调',
      stats: 'FDR < 0.05',
      data_kind: 'bulk',
      need_data: '两组 bulk 表达矩阵 + 分组',
      caption_guess: '差异表达基因火山图',
      confidence: 0.82,
    })
    : output
  const ctx = {
    get(name) {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-v4' }) }
      if (name === 'attachments') return { saveImage: async (input) => { calls.saved.push(input); return { id: 'attachment-1' } } }
      if (name === 'llm') {
        return {
          resolveModelInfo: async () => ({ inputModalities: vision ? ['text', 'image'] : ['text'], defaultMaxTokens: 4096 }),
          stream: (options) => {
            calls.stream.push(options)
            return (async function* () {
              yield { type: 'text-delta', text: payload }
              yield { type: 'finish', reason: { kind: 'stop' } }
            })()
          },
        }
      }
      return undefined
    },
  }
  return { ctx, calls }
}

test('figure_from_image：图片交给多模态模型，输出结构化蓝图', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'bf-vision-'))
  const mock = mockCtx({ vision: true })
  const runtime = { version: 'test', config: { dataDir: root }, invocation: 'test', ctx: mock.ctx }
  try {
    const result = await impl.runTool(runtime, {
      action: 'figure_from_image',
      image_base64: `data:image/png;base64,${ONE_PIXEL_PNG}`,
      image_name: 'figure.png',
    })
    assert.equal(result.ok, true, result.message || result.summary)
    assert.equal(result.figures.length, 1)
    const figure = result.figures[0]
    assert.equal(figure.recognized_by, 'vision')
    assert.equal(figure.chart, 'volcano')
    assert.equal(figure.template, 'bulk-two-group')
    assert.equal(figure.confidence, 0.82)
    assert.ok(figure.wish_text.includes('火山'), '许愿文本应包含识别出的图型')
    assert.equal(result.model.vision, true)
    assert.equal(mock.calls.stream.length, 1)
    assert.ok(mock.calls.stream[0].messages[0].content.some((part) => part.type === 'image'), '消息里必须带 image 块')
    assert.ok(result.image_path && existsSync(result.image_path), '上传图片应落盘留痕')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('figure_from_image：模型不支持图片时明确报错，不乱猜', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'bf-vision-novision-'))
  const mock = mockCtx({ vision: false })
  const runtime = { version: 'test', config: { dataDir: root }, invocation: 'test', ctx: mock.ctx }
  try {
    const result = await impl.runTool(runtime, { action: 'figure_from_image', image_base64: ONE_PIXEL_PNG })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'unsupported')
    assert.match(String(result.message), /多模态|图片输入/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('figure_from_image：模型返回非 JSON 时降级为规则分类，并保留原文', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'bf-vision-raw-'))
  const mock = mockCtx({ vision: true, output: '这是一张 Kaplan-Meier 生存曲线，横轴是时间，纵轴是生存率。' })
  const runtime = { version: 'test', config: { dataDir: root }, invocation: 'test', ctx: mock.ctx }
  try {
    const result = await impl.runTool(runtime, { action: 'figure_from_image', image_base64: ONE_PIXEL_PNG })
    assert.equal(result.ok, true)
    assert.equal(result.figures[0].recognized_by, 'vision')
    assert.equal(result.figures[0].chart, 'km')
    assert.ok(String(result.figures[0].raw_text).includes('Kaplan-Meier'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})
