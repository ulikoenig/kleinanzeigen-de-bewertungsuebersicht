// Lint-Grundlage für Skript, Build-Werkzeug und Tests.
// Die GM_*-Funktionen kommen vom Userscript-Manager, nicht vom Browser.
export default [
    {
        ignores: ['node_modules/**', 'test/fixtures/**']
    },
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'script',
            globals: {
                // Browser
                window: 'readonly', document: 'readonly', console: 'readonly',
                setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly',
                clearInterval: 'readonly', fetch: 'readonly', AbortController: 'readonly',
                DOMParser: 'readonly', MutationObserver: 'readonly', location: 'readonly',
                localStorage: 'readonly', matchMedia: 'readonly', URL: 'readonly',
                navigator: 'readonly', Node: 'readonly',
                // Userscript-Manager (Tampermonkey/Violentmonkey)
                GM_xmlhttpRequest: 'readonly', GM_setValue: 'readonly',
                GM_getValue: 'readonly', GM_registerMenuCommand: 'readonly',
                // Node (Tests, Build)
                require: 'readonly', module: 'writable', process: 'readonly',
                __dirname: 'readonly', globalThis: 'readonly'
            }
        },
        rules: {
            'no-undef': 'error',
            'no-unused-vars': ['warn', { args: 'none' }],
            'no-empty': ['warn', { allowEmptyCatch: true }],
            'no-constant-condition': ['warn', { checkLoops: false }],
            'no-fallthrough': 'error',
            'no-dupe-keys': 'error',
            'no-unreachable': 'error'
        }
    }
];
