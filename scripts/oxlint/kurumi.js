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

function isRequire(callee) {
  if (callee.type === 'Identifier') return callee.name === 'require'
  if (callee.type !== 'MemberExpression' || callee.object.type !== 'MetaProperty') return false
  return (callee.computed ? callee.property.value : callee.property.name) === 'require'
}

function specifierOf(node) {
  if (node?.type === 'Literal') return typeof node.value === 'string' ? node.value : undefined
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked
  }
  return undefined
}

const SCHEMA_ENTRY = /^@kurumi\/([^/]+)\/schema$/

function isFunction(node) {
  return node?.type === 'ArrowFunctionExpression' || node?.type === 'FunctionExpression'
}

function isAsyncFunction(node) {
  return isFunction(node) && node.async
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
            if (isRequire(node.callee)) check(node, specifierOf(node.arguments[0]))
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
    // bun:sqlite の transaction は同期で、async 関数を渡すと await の後の throw で rollback されない。
    'sync-transaction': {
      create(context) {
        const asyncNames = new Set()
        const passedByName = []
        const report = (node) =>
          context.report({
            node,
            message:
              'transaction に async 関数を渡さない。throw しても rollback されない。network や fs は transaction の外で呼び、結果を同期の transaction で書く',
          })
        return {
          FunctionDeclaration(node) {
            if (node.async && node.id) asyncNames.add(node.id.name)
          },
          VariableDeclarator(node) {
            if (node.id.type === 'Identifier' && isAsyncFunction(node.init)) {
              asyncNames.add(node.id.name)
            }
          },
          CallExpression(node) {
            const { callee } = node
            if (callee.type !== 'MemberExpression' || callee.property.name !== 'transaction') return
            const [callback] = node.arguments
            if (isAsyncFunction(callback)) report(node)
            else if (callback?.type === 'Identifier')
              passedByName.push({ node, name: callback.name })
          },
          'Program:exit'() {
            for (const { node, name } of passedByName) if (asyncNames.has(name)) report(node)
          },
        }
      },
    },
    // 別の domain の table を書けるのはその domain だけ。他の domain の schema entry から import した table への insert、update、delete を止める。
    'cross-domain-write': {
      create(context) {
        const own = /\/packages\/([^/]+)\/src\//.exec(context.filename)?.[1]
        const tables = new Set()
        const namespaces = new Set()
        const isForeignTable = (node) =>
          node?.type === 'Identifier'
            ? tables.has(node.name)
            : node?.type === 'MemberExpression' && namespaces.has(node.object.name)
        return {
          ImportDeclaration(node) {
            const domain = SCHEMA_ENTRY.exec(node.source.value)?.[1]
            if (!domain || domain === own || node.importKind === 'type') return
            for (const specifier of node.specifiers) {
              const names = specifier.type === 'ImportNamespaceSpecifier' ? namespaces : tables
              names.add(specifier.local.name)
            }
          },
          CallExpression(node) {
            const { callee } = node
            if (callee.type !== 'MemberExpression') return
            if (!['insert', 'update', 'delete'].includes(callee.property.name)) return
            if (!isForeignTable(node.arguments[0])) return
            context.report({
              node,
              message:
                '他の domain の table に直接書かない。書き込みは相手の domain の ledger の method を通す（docs/design/module-map.md）',
            })
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
