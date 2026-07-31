# Contributing

Artifacts is unversioned pre-alpha software. Discuss substantial behavior, storage, protocol, or
package-boundary changes before implementation; compatibility is not promised, but changes should
still be intentional and documented.

1. Create a branch. Do not push changes directly to `main`.
2. Install dependencies with `corepack enable` and `pnpm install --frozen-lockfile`.
3. Make a focused change using existing project patterns.
4. Run `pnpm fmt`, `pnpm lint`, `pnpm test`, and `pnpm build`.
5. For Docker changes, also run `pnpm docker:check` and build the image.
6. Open a pull request that explains the behavior change and verification performed.

Security reports do not belong in public issues; follow [SECURITY.md](SECURITY.md).
