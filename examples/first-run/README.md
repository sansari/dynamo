# First-run demo repository

This directory is a source template for exercising Dynamo against an existing
repository that has no Dynamo or 2119 setup.

Create a fresh copy with:

```bash
npm run demo:create
```

Pass a nonexistent destination when you need a stable path:

```bash
npm run demo:create -- /tmp/dynamo-promotion-shop
```

The generator refuses every existing destination rather than risking an
overwrite; choose a new path when resetting the demo.

The command materializes the `.tmpl` files with their real names, initializes a
Git repository, and creates an initial commit. The generated project uses only
Node's built-in test runner, so it needs no dependency installation.

A useful first-run concern is:

> Promotion eligibility and discount limits worry me because only the happy
> path is tested.

The templates deliberately keep real `*.test.js` files out of this repository,
preventing Dynamo's own Vitest and 2119 discovery from treating demo evidence as
project evidence.
