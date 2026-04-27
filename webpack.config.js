const path = require('path');
const CopyWebpackPlugin = require('copy-webpack-plugin');

const isProduction = process.env.NODE_ENV === 'production';

/** @type {import('webpack').Configuration} */
const config = {
  mode: isProduction ? 'production' : 'development',
  entry: {
    background: path.resolve(__dirname, 'src/background.js'),
    popup: path.resolve(__dirname, 'src/popup.js'),
    settings: path.resolve(__dirname, 'src/settings.js')
  },
  output: {
    filename: 'src/[name].js',
    path: path.resolve(__dirname, 'dist'),
    clean: true
  },
  devtool: isProduction ? false : 'source-map',
  resolve: {
    extensions: ['.js']
  },
  performance: {
    hints: false
  },
  plugins: [
    new CopyWebpackPlugin({
      patterns: [
        { from: 'manifest.json', to: '.' },
        { from: '_locales', to: '_locales' },
        { from: 'icons', to: 'icons' },
        { from: 'asserts', to: 'asserts' },
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
