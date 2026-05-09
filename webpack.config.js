const path = require('path');
const CopyWebpackPlugin = require('copy-webpack-plugin');

const isProduction = process.env.NODE_ENV === 'production';

/** @type {import('webpack').Configuration} */
const config = {
  mode: isProduction ? 'production' : 'development',
  entry: {
    background: path.resolve(__dirname, 'src/background.js'),
    popup: path.resolve(__dirname, 'src/popup.js'),
    settings: path.resolve(__dirname, 'src/settings.js'),
    offscreen: path.resolve(__dirname, 'src/offscreen.js'),
    'content/bubble': path.resolve(__dirname, 'src/content/bubble.js')
  },
  output: {
    filename: 'src/[name].js',
    path: path.resolve(__dirname, 'dist'),
    clean: true
  },
  devtool: isProduction ? false : 'source-map',
  resolve: {
    extensions: ['.js'],
    // Disable "browser" field so turndown uses Node build with domino DOM parser
    // (Service Worker has no `document` object)
    aliasFields: [],
    fallback: {
      fs: false,
      stream: false,
    },
  },
  performance: {
    hints: false
  },
  plugins: [
    new CopyWebpackPlugin({
      patterns: [
        { from: 'manifest.json', to: '.' },
        { from: '_locales', to: '_locales' },
        { from: 'icons/icon16.png', to: 'icons/icon16.png' },
        { from: 'icons/icon32.png', to: 'icons/icon32.png' },
        { from: 'icons/icon48.png', to: 'icons/icon48.png' },
        { from: 'icons/icon64.png', to: 'icons/icon64.png' },
        { from: 'icons/icon128.png', to: 'icons/icon128.png' },
        { from: 'icons/icon-round.png', to: 'icons/icon-round.png' },
        { from: 'assets', to: 'assets' },
        {
          from: 'src',
          to: 'src',
          globOptions: { ignore: ['**/*.js'] }
        }
      ]
    })
  ]
};

module.exports = config;
