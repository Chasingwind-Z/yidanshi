// Taro 构建配置。designWidth 取 375 + deviceRatio 375:2，
// 这样 scss 里的 px 值与 web/src/index.css 一一对应（16px 就是 16pt）。
const config = {
  projectName: 'yidanshi-miniapp',
  date: '2026-7-20',
  designWidth: 375,
  deviceRatio: {
    640: 2.34 / 2,
    750: 1,
    828: 1.81 / 2,
    375: 2 / 1,
  },
  sourceRoot: 'src',
  outputRoot: 'dist',
  plugins: [],
  defineConstants: {},
  copy: { patterns: [], options: {} },
  framework: 'react',
  compiler: { type: 'webpack5', prebundle: { enable: false } },
  cache: { enable: false },
  mini: {
    postcss: {
      pxtransform: { enable: true, config: {} },
      cssModules: { enable: false },
    },
    miniCssExtractPluginOption: { ignoreOrder: true },
  },
  h5: {
    publicPath: '/',
    staticDirectory: 'static',
    miniCssExtractPluginOption: { ignoreOrder: true },
    postcss: {
      pxtransform: { enable: true, config: {} },
      autoprefixer: { enable: true, config: {} },
      cssModules: { enable: false },
    },
  },
}

module.exports = function (merge) {
  if (process.env.NODE_ENV === 'development') {
    return merge({}, config, require('./dev'))
  }
  return merge({}, config, require('./prod'))
}
