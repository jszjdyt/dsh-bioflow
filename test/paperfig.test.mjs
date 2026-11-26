/**
 * 论文图注拆解：分类器 + PMC XML 解析 + action=paper_figures（粘贴图注，不联网）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { classifyCaption, parseFiguresFromPmcXml, extractCaptionsFromText } from '../lib/paperfig.mjs'
import * as impl from '../lib/impl.mjs'

test('图注分类：常见图型都能对应到模板/图表', () => {
  const cases = [
    ['Figure 1. Kaplan-Meier survival curves of overall survival (log-rank P=0.01).', 'km', 'bulk-two-group', 'km'],
    ['Fig. 3 Volcano plot showing differentially expressed genes (log2FC > 1, P < 0.05).', 'volcano', 'bulk-two-group', null],
    ['Figure 2. UMAP embedding of single-cell RNA-seq colored by cell type.', 'umap', 'scrna-composition', null],
    ['Figure 4. Heatmap of z-score normalized gene expression across samples.', 'heatmap', 'bulk-two-group', 'heatmap'],
    ['Fig 5. GO enrichment dot plot of biological processes.', 'enrichment', 'bulk-two-group', 'dotplot'],
    ['Figure 6. Forest plot of hazard ratios across cohorts.', 'forest', 'bulk-two-group', 'forest'],
    ['Figure 7. Receiver operating characteristic (ROC) curves with AUC values.', 'roc', 'plotlab-figure', 'roc'],
  ]
  for (const [caption, chart, template, plotlab] of cases) {
    const blueprint = classifyCaption(caption)
    assert.equal(blueprint.chart, chart, `${caption} 应识别为 ${chart}，实际 ${blueprint.chart}`)
    assert.equal(blueprint.template, template, `${caption} 模板应为 ${template}`)
    assert.equal(blueprint.plotlab_chart, plotlab)
    assert.ok(blueprint.wish_text.includes('原图注'), '许愿里应带原图注，便于回查')
  }
  const unknown = classifyCaption('Figure 8. Something with no recognizable chart words.')
  assert.equal(unknown.chart, 'unknown')
  assert.equal(unknown.confidence, 0)
})

test('PMC XML：抽取 label/caption，跳过无图注的图', () => {
  const xml = `<article><body>
    <fig id="f1"><label>Figure 1</label><caption><p>Kaplan-Meier <italic>survival</italic> curves of OS.</p></caption></fig>
    <fig id="f2"><caption><p>Volcano plot of DEGs.</p></caption></fig>
    <fig id="f3"><graphic/></fig>
  </body></article>`
  const figures = parseFiguresFromPmcXml(xml)
  assert.equal(figures.length, 2)
  assert.equal(figures[0].label, 'Figure 1')
  assert.ok(figures[0].caption.includes('Kaplan-Meier'))
  assert.equal(figures[1].label, 'Figure 2')
})

test('PDF 文本：按 Figure N 启发式抽图注', () => {
  const text = [
    'Results', 'Figure 1. Box plot of NK cell proportion between tumor and normal (P < 0.05).',
    'Some results text.', 'Fig. 2 Volcano plot of differentially expressed genes.', 'Table 1. Clinical features.',
  ].join('\n')
  const figures = extractCaptionsFromText(text)
  assert.equal(figures.length, 2)
  assert.equal(figures[0].label, 'Figure 1')
  assert.equal(figures[1].label, 'Figure 2')
  assert.ok(figures[1].caption.includes('Volcano'))
})

test('action=paper_figures：粘贴图注直接出蓝图（不联网）', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'bf-paper-'))
  const runtime = { version: 'test', config: { dataDir: root }, invocation: 'test' }
  try {
    const result = await impl.runTool(runtime, {
      action: 'paper_figures',
      figure_caption: 'Figure 2. Kaplan-Meier survival curves of overall survival in gastric cancer (log-rank P=0.01).',
    })
    assert.equal(result.ok, true)
    assert.equal(result.figures.length, 1)
    assert.equal(result.figures[0].chart, 'km')
    assert.equal(result.figures[0].plotlab_chart, 'km')
    assert.ok(result.figures[0].wish_text.includes('Kaplan-Meier'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})
