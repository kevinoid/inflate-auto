// ESLint configuration <https://eslint.org/docs/user-guide/configuring>

'use strict';

const { default: nodejs } = require('@kevinoid/eslint-config/nodejs.js');
const globals = require('globals');

module.exports = [
  {
    ignores: [
      'coverage/',
      'doc/',
    ],
  },

  ...nodejs,

  {
    rules: {
      // allow dangling underscores in identifiers
      // this is the convention used in Zlib, so we adopt it for this project
      'no-underscore-dangle': 'off',

      // Allow requiring devDependencies for build and test
      'import/no-extraneous-dependencies': ['error', {
        devDependencies: [
          ...nodejs
            .findLast(
              (conf) => conf.rules?.['import/no-extraneous-dependencies'],
            )
            .rules['import/no-extraneous-dependencies'][1].devDependencies,
          'gulpfile.js',
          'test-bin/**',
          'test-lib/**',
          'test/**',
        ],
      }],

      // Allow CommonJS modules
      'unicorn/prefer-module': 'off',

      // Don't prefer top-level await
      // Since top-level await is only supported in ECMAScript Modules (ESM)
      'unicorn/prefer-top-level-await': 'off',
    },
  },

  {
    name: 'errors.js config',
    files: [
      'lib/errors.js',
    ],
    rules: {
      curly: 'off',
      'new-cap': 'off',
      'no-restricted-syntax': 'off',
      'no-unassigned-vars': 'off',
      '@stylistic/comma-dangle': ['error', 'only-multiline'],
      '@stylistic/indent': 'off',
      '@stylistic/indent-binary-ops': 'off',
      '@stylistic/nonblock-statement-body-position': ['error', 'below'],
      '@stylistic/operator-linebreak': ['error', 'after'],
      'n/global-require': 'off',
      'no-use-before-define': ['error', { functions: false }],
      'unicorn/no-null': 'off',
      'unicorn/prefer-prototype-methods': 'off',
    },
  },

  {
    name: 'zlib-internal.js config',
    files: [
      'lib/zlib-internal.js',
    ],
    rules: {
      curly: 'off',
      'no-use-before-define': ['error', { functions: false }],
      '@stylistic/comma-dangle': ['error', 'only-multiline'],
      '@stylistic/indent-binary-ops': 'off',
      '@stylistic/no-extra-parens': ['error', 'functions'],
      '@stylistic/nonblock-statement-body-position': ['error', 'below'],
      '@stylistic/operator-linebreak': ['error', 'after'],
      'import/order': 'off',
      'unicorn/no-null': 'off',
      'unicorn/prefer-spread': 'off',
    },
  },

  {
    name: 'bin config',
    basePath: 'bin',
    rules: {
      // Executable scripts should have a shebang
      'n/hashbang': 'off',
    },
  },

  {
    name: 'test config',
    basePath: 'test',
    languageOptions: {
      globals: globals.mocha,
    },
    rules: {
      // Allow, but don't require, braces around function body
      // Braces around body of it() function is more consistent/readable
      'arrow-body-style': 'off',

      // Allow null use in tests
      'unicorn/no-null': 'off',

      // Allow EventEmitter use in tests
      'unicorn/prefer-event-target': 'off',
    },
  },
];
