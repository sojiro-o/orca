import { describe, expect, it } from 'vitest'
import {
  canCopySelectionWithContext,
  formatCopiedSelectionWithContext,
  getContextualCopyLineRange,
  getRemoteUrlLineRange
} from './selection-copy'

describe('contextual copy eligibility', () => {
  it('matches formatting eligibility for line boundaries and whitespace-only selections', () => {
    for (const startLineNumber of [1, 2, 44]) {
      for (const endLineNumber of [1, 2, 3, 44, 45]) {
        for (const endColumn of [1, 2, 15]) {
          const selection = { startLineNumber, startColumn: 1, endLineNumber, endColumn }
          const expected =
            endLineNumber !== startLineNumber &&
            (endColumn === 1 ? endLineNumber - 1 : endLineNumber) >= startLineNumber
          expect(canCopySelectionWithContext(selection)).toBe(expected)
          expect(
            formatCopiedSelectionWithContext({
              relativePath: '',
              language: 'plaintext',
              selection,
              selectedText: ' \n'
            }) !== null
          ).toBe(expected)
        }
      }
    }
  })
})

describe('getRemoteUrlLineRange', () => {
  const selection = {
    startLineNumber: 10,
    startColumn: 4,
    endLineNumber: 20,
    endColumn: 9
  }

  it('includes the selected lines only when they cover the clicked gutter line', () => {
    for (const line of [10, 15, 20]) {
      expect(getRemoteUrlLineRange(line, selection)).toEqual({ line: 10, endLine: 20 })
    }
    for (const line of [9, 21]) {
      expect(getRemoteUrlLineRange(line, selection)).toEqual({ line })
    }
  })

  it('excludes the ending column-1 line from both the range and its coverage', () => {
    const fullLineSelection = { ...selection, endLineNumber: 21, endColumn: 1 }
    expect(getRemoteUrlLineRange(20, fullLineSelection)).toEqual({ line: 10, endLine: 20 })
    expect(getRemoteUrlLineRange(21, fullLineSelection)).toEqual({ line: 21 })
  })

  it('keeps a single line for empty, partial-line and full-line selections', () => {
    expect(getRemoteUrlLineRange(10, null)).toEqual({ line: 10 })
    expect(getRemoteUrlLineRange(10, { ...selection, endLineNumber: 10 })).toEqual({ line: 10 })
    expect(getRemoteUrlLineRange(10, { ...selection, endLineNumber: 10, endColumn: 4 })).toEqual({
      line: 10
    })
    expect(getRemoteUrlLineRange(10, { ...selection, endLineNumber: 11, endColumn: 1 })).toEqual({
      line: 10
    })
  })
})

describe('formatCopiedSelectionWithContext', () => {
  it('formats multi-line selections with file and line context', () => {
    expect(
      formatCopiedSelectionWithContext({
        relativePath: 'src/main/git/status.ts',
        language: 'typescript',
        selection: {
          startLineNumber: 44,
          startColumn: 1,
          endLineNumber: 47,
          endColumn: 9
        },
        selectedText: "if (line.startsWith('1 ')) {\n  const parts = line.split(' ')\n}"
      })
    ).toBe(
      [
        'File: src/main/git/status.ts',
        'Lines: 44-47',
        '',
        '```ts',
        "if (line.startsWith('1 ')) {\n  const parts = line.split(' ')\n}",
        '```'
      ].join('\n')
    )
  })

  it('treats column-1 end positions as the previous line for full-line selections', () => {
    const selection = {
      startLineNumber: 44,
      startColumn: 1,
      endLineNumber: 48,
      endColumn: 1
    }

    expect(getContextualCopyLineRange(selection)).toEqual({
      startLine: 44,
      endLine: 47
    })

    expect(
      formatCopiedSelectionWithContext({
        relativePath: 'src/main/git/status.ts',
        language: 'typescript',
        selection,
        selectedText: 'line 44\nline 45\nline 46\nline 47\n'
      })
    ).toContain('Lines: 44-47')
  })

  it('keeps full-line single-line selections copyable', () => {
    expect(
      formatCopiedSelectionWithContext({
        relativePath: 'src/main/git/status.ts',
        language: 'typescript',
        selection: {
          startLineNumber: 44,
          startColumn: 1,
          endLineNumber: 45,
          endColumn: 1
        },
        selectedText: 'line 44\n'
      })
    ).toContain('Line: 44')
  })

  it('leaves single-line selections alone', () => {
    expect(
      formatCopiedSelectionWithContext({
        relativePath: 'src/main/git/status.ts',
        language: 'typescript',
        selection: {
          startLineNumber: 44,
          startColumn: 4,
          endLineNumber: 44,
          endColumn: 15
        },
        selectedText: 'line.startsWith'
      })
    ).toBeNull()
  })
})
