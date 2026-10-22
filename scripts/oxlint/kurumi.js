// oxlint は node で動き、node の版によっては TS の plugin を読めないので JS で書く。

import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const TESTING_ENTRY = /^@kurumi\/[^/]+\/testing$/
const PACKAGE_DIR = /^((?:packages|apps)\/[^/]+)\//
const ROOT_PACKAGE = '.'
const OUTSIDE_REPOSITORY = '(outside the repository)'

function realPathOf(path) {
  const missing = []
  for (let existing = path; ; existing = dirname(existing)) {
    try {
      return join(realpathSync(existing), ...missing)
    } catch {
      if (dirname(existing) === existing) return path
      missing.unshift(basename(existing))
    }
  }
}

function packageOf(path, root) {
  const fromRoot = relative(root, path)
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    return OUTSIDE_REPOSITORY
  }
  return PACKAGE_DIR.exec(`${fromRoot}/`)?.[1] ?? ROOT_PACKAGE
}

function specifierOf(node) {
  if (node?.type === 'Literal') return typeof node.value === 'string' ? node.value : undefined
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked
  }
  return undefined
}

export default {
  meta: { name: 'kurumi' },
  rules: {
    // no-restricted-imports は override をまたいで重ならないので、file の集合ごとの制限と別の rule にする。
    'testing-entry': {
      create(context) {
        const check = (node) => {
          if (!TESTING_ENTRY.test(node.source?.value)) return
          context.report({
            node,
            message:
              'testing entry を import するのはテストと testing.ts だけ（docs/design/module-map.md の entry）',
          })
        }
        return {
          ImportDeclaration: check,
          ExportNamedDeclaration: check,
          ExportAllDeclaration: check,
        }
      },
    },
    'no-relative-package-import': {
      create(context) {
        const root = realPathOf(context.cwd)
        const file = realPathOf(context.filename)
        const ownPackage = packageOf(file, root)
        const check = (node, specifier) => {
          if (typeof specifier !== 'string' || !specifier.startsWith('.')) return
          const target = realPathOf(resolve(dirname(file), specifier))
          if (packageOf(target, root) === ownPackage) return
          context.report({
            node,
            message:
              '相対 path で package の外の file を import しない。他の package の entry は @kurumi/<package>/<entry> で import する（docs/design/module-map.md）',
          })
        }
        const checkSource = (node) => check(node, specifierOf(node.source))
        return {
          ImportDeclaration: checkSource,
          ExportNamedDeclaration: checkSource,
          ExportAllDeclaration: checkSource,
          ImportExpression: checkSource,
          CallExpression: (node) => {
            if (node.callee.type === 'Identifier' && node.callee.name === 'require') {
              check(node, specifierOf(node.arguments[0]))
            }
          },
          Literal: (node) => {
            const { type } = node.parent ?? {}
            if (type === 'TSImportType' || type === 'TSExternalModuleReference') {
              check(node, specifierOf(node))
            }
          },
        }
      },
    },
    'disable-reason': {
      create(context) {
        return {
          Program() {
            for (const comment of context.sourceCode.getAllComments()) {
              if (!/^\s*(oxlint|eslint)-disable/.test(comment.value)) continue
              if (/\s--\s+\S/.test(comment.value)) continue
              context.report({
                node: comment,
                message: 'lint を黙らせるときは、rule の後に `-- 理由` を 1 文書く',
              })
            }
          },
        }
      },
    },
  },
}
