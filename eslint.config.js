const js = require("@eslint/js");

module.exports = [
  { ignores: ["node_modules/**", "client/dist/**", "coverage/**"] },
  js.configs.recommended,
  {
    files: ["**/*.js", "**/*.jsx"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: {
        Buffer: "readonly",
        __dirname: "readonly",
        atob: "readonly",
        btoa: "readonly",
        clearInterval: "readonly",
        clearTimeout: "readonly",
        console: "readonly",
        crypto: "readonly",
        document: "readonly",
        exports: "readonly",
        fetch: "readonly",
        FormData: "readonly",
        global: "readonly",
        importScripts: "readonly",
        location: "readonly",
        module: "readonly",
        process: "readonly",
        require: "readonly",
        setInterval: "readonly",
        setTimeout: "readonly",
        TextDecoder: "readonly",
        TextEncoder: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        XMLHttpRequest: "readonly",
        Blob: "readonly",
        Uint8Array: "readonly",
      },
    },
    rules: {
      "no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["client/src/**/*.{js,jsx}"],
    languageOptions: {
      globals: {
        window: "readonly",
        navigator: "readonly",
        btoa: "readonly",
        atob: "readonly",
      },
    },
  },
  {
    files: ["tests/**/*.js"],
    languageOptions: { globals: { Buffer: "readonly", process: "readonly" } },
  },
];
