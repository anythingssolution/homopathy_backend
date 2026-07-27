# Backend project requirements

This backend is a Node.js project.

## Source of truth for dependencies

- `package.json` -> declares project dependencies
- `package-lock.json` -> locks exact dependency versions

These are the Node.js equivalent of a Python `requirements.txt`.

## Install dependencies for this project

Use:

```bash
nvm use
npm ci
```

If `nvm` is not installed, use Node.js `20.x` and then run:

```bash
npm ci
```

## Important note

Project packages are **not taken from the OS package manager**.

- Node.js / npm runtime comes from the server environment
- project packages come from `package.json` / `package-lock.json`
- packages install locally inside this project’s `node_modules/`

## Recommended production behavior

- keep Node.js on `20.x`
- install with `npm ci` instead of `npm install`
- do not rely on globally installed npm packages
