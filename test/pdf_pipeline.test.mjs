/**
 * PDF 上传链路：真实生成一份 PDF（图注 + 内嵌图）→ paper_pdf 抽图 + 多模态识别。
 * 也验证「矢量图/无位图」时退化为图注拆解并注明原因。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

import * as impl from '../lib/impl.mjs'

function buildPdf(dir, { withImage }) {
  const chart = path.join(dir, 'chart.png')
  const pdf = path.join(dir, withImage ? 'paper-with-figure.pdf' : 'paper-text-only.pdf')
  const py = [
    'import sys, fitz, matplotlib',
    'matplotlib.use("Agg")',
    'import matplotlib.pyplot as plt',
    'chart, pdf, with_image = sys.argv[1], sys.argv[2], sys.argv[3] == "1"',
    'if with_image:',
    '    fig, ax = plt.subplots(figsize=(3,2), dpi=150)',
    '    ax.boxplot([[1,2,3,4],[2,3,4,5]], tick_labels=["Tumor","Normal"])',
    '    ax.set_ylabel("NK proportion")',
    '    fig.tight_layout(); fig.savefig(chart)',
    'doc = fitz.open()',
    'page = doc.new_page()',
    'page.insert_text((60, 80), "Results", fontsize=14)',
    'if with_image:',
    '    page.insert_image(fitz.Rect(60, 100, 360, 300), filename=chart)',
    '    page.insert_text((60, 330), "Figure 1. Kaplan-Meier survival curves of overall survival in gastric cancer (log-rank P=0.01).", fontsize=10)',
    'else:',
    '    page.insert_text((60, 110), "Figure 1. Volcano plot of differentially expressed genes (log2FC > 1, P < 0.05).", fontsize=10)',
    'doc.save(pdf)',
  ].join('\n')
  const result = spawnSync('python3', ['-c', py, chart, pdf, withImage ? '1' : '0'], { encoding: 'utf8', timeout: 120_000 })
  assert.equal(result.status, 0, `生成测试 PDF 失败：${result.stderr}`)
  return pdf
}

function mockCtx() {
  const ctx = {
    get(name) {
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'deepseek', model: 'v4-vision' }) }
      if (name === 'attachments') return { saveImage: async () => ({ id: 'att-1' }) }
      if (name === 'llm') {
        return {
          resolveModelInfo: async () => ({ inputModalities: ['text', 'image'], defaultMaxTokens: 4096 }),
          stream: () => (async function* () {
            yield { type: 'text-delta', text: JSON.stringify({ chart: 'km', chart_label_zh: 'Kaplan-Meier 生存曲线', data_kind: 'bulk', need_data: '带随访队列', caption_guess: '生存曲线', confidence: 0.9 }) }
            yield { type: 'finish', reason: { kind: 'stop' } }
          })(),
        }
      }
      return undefined
    },
  }
  return { ctx }
}

test('paper_pdf：真实 PDF → 图注 + 内嵌图 → 多模态识别', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'bf-pdf-'))
  const runtime = { version: 'test', config: { dataDir: root }, invocation: 'test', ctx: mockCtx().ctx }
  try {
    const pdf = buildPdf(root, { withImage: true })
    const result = await impl.runTool(runtime, { action: 'paper_pdf', pdf_path: pdf, vision_limit: 2 })
    assert.equal(result.ok, true, result.summary)
    assert.ok(result.page_count >= 1)
    assert.ok(result.figures.length >= 1, '至少抽出一张图')
    const figure = result.figures[0]
    assert.ok(figure.caption.includes('Kaplan-Meier'), '应抽到图注')
    assert.equal(figure.chart, 'km', '多模态应识别为 km')
    assert.equal(figure.recognized_by, 'vision')
    assert.ok(figure.image_path && existsSync(figure.image_path), '抽出的图应落盘')
    assert.match(String(figure.image_url), /^\/bioflow\/files\/uploads\/figures\//)
    assert.equal(result.model.vision, true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('paper_pdf：矢量图/无位图 → 退化为图注拆解并注明原因', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'bf-pdf-vector-'))
  const runtime = { version: 'test', config: { dataDir: root }, invocation: 'test', ctx: mockCtx().ctx }
  try {
    const pdf = buildPdf(root, { withImage: false })
    const result = await impl.runTool(runtime, { action: 'paper_pdf', pdf_path: pdf })
    assert.equal(result.ok, true)
    assert.ok(result.figures.length >= 1)
    assert.equal(result.figures[0].chart, 'volcano')
    assert.equal(result.figures[0].image_path, null)
    assert.ok(result.notes.some((note) => note.includes('矢量图') || note.includes('没抽到位图')))
  } finally { rmSync(root, { recursive: true, force: true }) }
})
