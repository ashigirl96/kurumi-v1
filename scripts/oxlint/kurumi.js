// oxlint は node で動き、node の版によっては TS の plugin を読めないので JS で書く。

import { dirname, relative, resolve } from 'node:path'

const TESTING_ENTRY = /^@kurumi\/[^/]+\/testing$/
const PACKAGE_DIR = /^((?:packages|apps)\/[^/]+)\//

const packageOf = (path, root) => PACKAGE_DIR.exec(`${relative(root, path)}/`)?.[1] ?? null

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
        const root = context.cwd
        const ownPackage = packageOf(context.filename, root)
        const check = (node, specifier) => {
          if (typeof specifier !== 'string' || !specifier.startsWith('.')) return
          const target = packageOf(resolve(dirname(context.filename), specifier), root)
          if (target === null || target === ownPackage) return
          context.report({
            node,
            message:
              '相対 path で他の package の file を import しない。entry は @kurumi/<package>/<entry> で import する（docs/design/module-map.md）',
          })
        }
        const checkSource = (node) => check(node, node.source?.value)
        return {
          ImportDeclaration: checkSource,
          ExportNamedDeclaration: checkSource,
          ExportAllDeclaration: checkSource,
          ImportExpression: checkSource,
          Literal: (node) => {
            if (node.parent?.type === 'TSImportType') check(node, node.value)
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
