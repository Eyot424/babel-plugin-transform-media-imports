const path = require('path')
const mkdirp = require('mkdirp')
const imgSize = require('image-size')
const fs = require('fs')
const crypto = require('crypto')
const { execFileSync } = require('child_process')
// 获取项目根路径
const appDirectory = fs.realpathSync(process.cwd())
const manifest = require(path.join(appDirectory, './dist/OutputClient/asset-manifest.json'))

// get-video-dimensions package is async only which
// makes it harder to use with babel. This is a "sync"
// copy of the original as of 04-08-2019.
function videoSize(path) {
  const result = execFileSync('ffprobe', [
    '-v',
    'error',
    '-of',
    'flat=s=_',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=height,width',
    path
  ]).toString()
  const width = parseInt(/width=(\d+)/.exec(result)[1] || 0)
  const height = parseInt(/height=(\d+)/.exec(result)[1] || 0)
  const type = path.split('.').pop().toLowerCase()

  return { width, height, type }
}

function createMediaObject(importedPath, { file, normalizedOpts: opts }) {
  const { root, filename } = file.opts
  const mediaPath = importedPath.startsWith('/')
    ? importedPath
    : path.resolve(path.join(filename ? path.dirname(filename) : root, importedPath))
  const isVideo = mediaPath.match(opts.videoExtensionRegex)
  const isSVG = mediaPath.toLowerCase().endsWith('.svg')
  const { width, height, type } = (isVideo ? videoSize : imgSize)(mediaPath)

  let pathname = mediaPath.replace(opts.baseDir, '')
  let _fileBuffer
  const fileContents = () => (_fileBuffer = _fileBuffer || fs.readFileSync(mediaPath))
  let content = undefined
  let base64 = null
  let hash = null

  if (isSVG) content = fileContents().toString()
  if (opts.pathnamePrefix) pathname = path.join(opts.pathnamePrefix, pathname)
  if (opts.hash) {
    const splatOpts = opts.hash.constructor === Object ? opts.hash : {}
    const { delimiter, length, algo } = {
      delimiter: '-',
      length: null,
      algo: 'md5',
      ...splatOpts
    }
    const [ fname, ...rest ] = path.basename(pathname).split('.')
    hash = crypto.createHash(algo).update(fileContents()).digest('hex')

    if (length) hash = hash.slice(0, Math.max(4, length))

    pathname = path.join(path.dirname(pathname), `${fname}${delimiter}${hash}.${rest.join('.')}`)
  }

  if (opts.base64) {
    const splatOpts = opts.base64.constructor === Object ? opts.base64 : {}
    const fileSize = fs.statSync(mediaPath).size
    const { maxSize } = { maxSize: 8192, ...splatOpts }

    if (maxSize > fileSize) {
      const b64str = fileContents().toString('base64')
      base64 = `data:${isVideo ? 'video' : 'image'}/${type};base64,${b64str}`
    }
  }

  if (opts.outputRoot) {
    const outputPath = path.join(opts.outputRoot, pathname)
    mkdirp.sync(path.dirname(outputPath))
    fs.writeFileSync(outputPath, fileContents())
  }

  pathname = manifest.files[`client/media${pathname}`]
  return pathname
}

function toBabelMediaObject(m, t) {
  return t.stringLiteral(m)
}

module.exports = ({ types: t }) => ({
  name: 'transform-media-imports',

  pre() {
    const {
      baseDir = process.cwd(),
      pathnamePrefix = '',
      outputRoot = null,
      imageExtensions = [ 'jpeg', 'apng', ...imgSize.types ],
      videoExtensions = [ 'mp4', 'webm', 'ogv' ],
      md5 = false, // kept for backwards compatibility, it is only ever assigned to hash below
      hash = md5,
      base64 = false
    } = this.opts

    this.normalizedOpts = {
      baseDir: path.resolve(baseDir),
      outputRoot: outputRoot && path.resolve(outputRoot),
      pathnamePrefix,
      imageExtensions,
      videoExtensions,
      hash,
      base64,
      imageExtensionRegex: new RegExp(`\.(?:${imageExtensions.join('|')})$`, 'i'),
      videoExtensionRegex: new RegExp(`\.(?:${videoExtensions.join('|')})$`, 'i'),
      extensionRegex: new RegExp('\\.(?:' + [ ...imageExtensions, ...videoExtensions ].join('|') + ')$', 'i')
    }
  },

  visitor: {
    ImportDeclaration(p) {
      const transforms = []
      const { specifiers, source: { value: rawImportPath } } = p.node

      if (rawImportPath.match(this.normalizedOpts.extensionRegex)) {
        const defaultImport = specifiers.find(t.isImportDefaultSpecifier)
        const namedImports = specifiers.filter(t.isImportSpecifier)
        const media = toBabelMediaObject(createMediaObject(rawImportPath, this), t)

        if (defaultImport) {
          transforms.push(
            t.variableDeclaration('const', [ t.variableDeclarator(t.identifier(defaultImport.local.name), media) ])
          )
        }

        transforms.push(
          ...namedImports
            .filter((namedImport) => media[namedImport.imported.name])
            .map((namedImport) =>
              t.variableDeclaration('const', [
                t.variableDeclarator(t.identifier(namedImport.local.name), media[namedImport.imported.name])
              ])
            )
        )
      }

      if (transforms.length) {
        p.replaceWithMultiple(transforms)
        p.skip()
      }
    }
  }
})
