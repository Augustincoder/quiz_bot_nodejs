module.exports = {
    "env": {
        "node": true,
        "commonjs": true,
        "es2021": true
    },
    "extends": "eslint:recommended",
    "parserOptions": {
        "ecmaVersion": "latest"
    },
    "globals": {
        "setInterval": "readonly",
        "clearInterval": "readonly",
        "setTimeout": "readonly",
        "clearTimeout": "readonly"
    },
    "rules": {
        "no-unused-vars": "warn",
        "no-console": "off",
        "no-undef": "error"
    }
};
