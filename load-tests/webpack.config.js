const path = require('path');
const { readdirSync } = require('fs');

// Auto-discover all .ts files in src/ and create a bundle for each.
// This way each test file becomes a standalone k6 script.
const srcDir = path.join(__dirname, 'src');
const entry = {};
readdirSync(srcDir)
  .filter((f) => f.endsWith('.ts'))
  .forEach((f) => {
    entry[f.replace('.ts', '')] = path.join(srcDir, f);
  });

module.exports = {
  mode: 'production',
  entry,
  output: {
    path: path.join(__dirname, 'dist'),
    filename: '[name].js',
    libraryTarget: 'commonjs',
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      },
    ],
  },
  externals: [/^k6(\/.*)?$/], // k6 modules are provided at runtime, don't bundle them
  target: 'web',
  stats: 'minimal',
};
