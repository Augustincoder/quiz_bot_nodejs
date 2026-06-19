const nodePlugin = require("eslint-plugin-node");

module.exports = [
    {
        files: ["**/*.js"],
        languageOptions: {
            ecmaVersion: "latest",
            sourceType: "commonjs",
            globals: {
                process: "readonly",
                __dirname: "readonly",
                require: "readonly",
                module: "readonly",
                console: "readonly",
                setTimeout: "readonly",
                clearTimeout: "readonly",
                Buffer: "readonly"
            }
        },
        plugins: {
            node: nodePlugin
        },
        rules: {
            "no-unused-vars": "warn",
            "no-console": "off",
            "no-undef": "error"
        }
    }
];
