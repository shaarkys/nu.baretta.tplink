const globals = require('globals');

module.exports = [
  {
    ignores: ['.homeybuild/**'],
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: {
        ...globals.browser,
        ...globals.commonjs,
        ...globals.es2021,
        ...globals.node,
      },
    },
    rules: {},
  },
];
