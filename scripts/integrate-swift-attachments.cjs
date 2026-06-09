#!/usr/bin/env node
const fs = require('fs')
const path = require('path')

const projectRoot = path.resolve(process.argv[2] || '/Users/struggling/Downloads/slack-objc')
const sourceRoot = path.join(projectRoot, 'RecoveredReferences', 'UploadedSwiftAttachments')

const mapping = new Map([
  ['OrganizationPickerDataTypes.swift', 'Features/OrganizationPicker/OrganizationPickerDataTypes.swift'],
  ['OrganizationPickerFeature.swift', 'Features/OrganizationPicker/OrganizationPickerFeature.swift'],
  ['OrganizationPickerFeature+Dependencies.swift', 'Features/OrganizationPicker/OrganizationPickerFeature+Dependencies.swift'],
  ['OrganizationPickerInteractor.swift', 'Features/OrganizationPicker/OrganizationPickerInteractor.swift'],
  ['OrganizationPickerPresenter.swift', 'Features/OrganizationPicker/OrganizationPickerPresenter.swift'],
  ['OrganizationPickerRouteExecution.swift', 'Features/OrganizationPicker/OrganizationPickerRouteExecution.swift'],
  ['OrganizationPickerViewController.swift', 'Features/OrganizationPicker/OrganizationPickerViewController.swift'],

  ['SearchFiltersPickerFeature.swift', 'Features/SearchFiltersPicker/SearchFiltersPickerFeature.swift'],
  ['SearchFiltersPickerInteractor.swift', 'Features/SearchFiltersPicker/SearchFiltersPickerInteractor.swift'],
  ['SearchFiltersPickerPresenter.swift', 'Features/SearchFiltersPicker/SearchFiltersPickerPresenter.swift'],
  ['SearchFiltersPickerDataTypes.swift', 'Features/SearchFiltersPicker/SearchFiltersPickerDataTypes.swift'],
  ['SearchFiltersPickerViewController.swift', 'Features/SearchFiltersPicker/SearchFiltersPickerViewController.swift'],

  ['SearchFiltersCollectionEntity.swift', 'Features/SearchFilters/SearchFiltersCollectionEntity.swift'],
  ['SearchFiltersInteractor.swift', 'Features/SearchFilters/SearchFiltersInteractor.swift'],
  ['SearchFiltersPresenter.swift', 'Features/SearchFilters/SearchFiltersPresenter.swift'],
  ['SearchFilterToggle.swift', 'Features/SearchFilters/SearchFilterToggle.swift'],
  ['SearchFilterConstants.swift', 'Features/SearchFilters/SearchFilterConstants.swift'],
  ['SearchFiltersDataTypes.swift', 'Features/SearchFilters/SearchFiltersDataTypes.swift'],
  ['SearchFiltersFeature.swift', 'Features/SearchFilters/SearchFiltersFeature.swift'],
  ['SearchFiltersView.swift', 'Features/SearchFilters/SearchFiltersView.swift'],

  ['SearchCanvasesInteractorTests.swift', 'Tests/Search/SearchCanvasesInteractorTests.swift'],
  ['SearchMessagesResultsInteractorTests.swift', 'Tests/Search/SearchMessagesResultsInteractorTests.swift'],
  ['SearchWorkflowsInteractorTests.swift', 'Tests/Search/SearchWorkflowsInteractorTests.swift'],
  ['MessageActionsViewModelTests.swift', 'Tests/Message/MessageActionsViewModelTests.swift'],
  ['SearchFiltersInteractorTests.swift', 'Tests/SearchFilters/SearchFiltersInteractorTests.swift'],
  ['MockSearchMessagesResultsDataSource.swift', 'Tests/Mocks/MockSearchMessagesResultsDataSource.swift'],
  ['MockSearchFiltersPickerFeature.swift', 'Tests/Mocks/MockSearchFiltersPickerFeature.swift'],

  ['APIAiChannelDigest.swift', 'Models/SlackAPI/APIAiChannelDigest.swift'],
  ['APIAutocompleteSuggestions.swift', 'Models/SlackAPI/APIAutocompleteSuggestions.swift'],
  ['SlackAPI+AiAlphaChannelDigestList.swift', 'Services/SlackAPI/SlackAPI+AiAlphaChannelDigestList.swift'],
  ['SlackAPI+UsersSlackConnectOrgList.swift', 'Services/SlackAPI/SlackAPI+UsersSlackConnectOrgList.swift'],

  ['UIColor+FileTypeExtensions.swift', 'Utils/FileTypeUI/UIColor+FileTypeExtensions.swift'],
  ['SKOrnamentBox+FileTypeExtension.swift', 'Utils/FileTypeUI/SKOrnamentBox+FileTypeExtension.swift'],
  ['SKGenericEntity+Extensions.swift', 'Utils/FileTypeUI/SKGenericEntity+Extensions.swift'],
])

const duplicateMapping = [
  {
    source: 'RecoveredReferences/UploadedSwiftAttachments/SearchFiltersPicker/MockSearchResultAction.swift',
    dest: 'Tests/Mocks/SearchFiltersPicker/MockSearchResultAction.swift',
  },
  {
    source: 'RecoveredReferences/UploadedSwiftAttachments/SlackAPI/MockSearchResultAction.swift',
    dest: 'Tests/Mocks/SlackAPI/MockSearchResultAction.swift',
  },
]

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const filePath = path.join(dir, entry.name)
    if (entry.isDirectory()) return walk(filePath)
    return filePath.endsWith('.swift') ? [filePath] : []
  })
}

function byteEqual(a, b) {
  if (!fs.existsSync(a) || !fs.existsSync(b)) return false
  return fs.readFileSync(a).equals(fs.readFileSync(b))
}

if (!fs.existsSync(sourceRoot)) {
  throw new Error(`Recovered attachment export not found: ${sourceRoot}`)
}

const copied = []
const skipped = []
const unmatched = []

for (const source of walk(sourceRoot)) {
  const name = path.basename(source)
  const relSource = path.relative(projectRoot, source)
  const duplicate = duplicateMapping.find((item) => item.source === relSource)
  const destRel = duplicate?.dest || mapping.get(name)
  if (!destRel) {
    unmatched.push(relSource)
    continue
  }

  const dest = path.join(projectRoot, destRel)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  if (byteEqual(source, dest)) {
    skipped.push(destRel)
    continue
  }
  fs.copyFileSync(source, dest)
  copied.push({ source: relSource, dest: destRel })
}

const report = {
  generated_at: new Date().toISOString(),
  note: 'Integrated exact Swift file attachments shared on Jan 9, 2025 America/Los_Angeles. Source database timestamps are Jan 10, 2025 UTC.',
  source_root: path.relative(projectRoot, sourceRoot),
  copied,
  skipped,
  unmatched,
}

const reportPath = path.join(projectRoot, 'RecoveredReferences', 'UploadedSwiftAttachments', 'INTEGRATION_MAP.json')
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')

const lines = [
  '# Uploaded Swift Attachment Integration Map',
  '',
  report.note,
  '',
  `Source root: \`${report.source_root}\``,
  `Copied/updated files: ${copied.length}`,
  `Already current: ${skipped.length}`,
  `Unmatched files: ${unmatched.length}`,
  '',
  '| Source | Integrated path |',
  '|---|---|',
  ...copied.map((item) => `| \`${item.source}\` | \`${item.dest}\` |`),
  ...skipped.map((dest) => `| already current | \`${dest}\` |`),
]
fs.writeFileSync(path.join(projectRoot, 'RecoveredReferences', 'UploadedSwiftAttachments', 'INTEGRATION_MAP.md'), lines.join('\n') + '\n')

console.log(JSON.stringify({
  projectRoot,
  copied: copied.length,
  skipped: skipped.length,
  unmatched: unmatched.length,
  reportPath,
}, null, 2))
