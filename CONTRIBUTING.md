Thanks for contributing to DocNode!

## Contributor License Agreement (CLA)

By submitting a contribution to this repository, you agree to the following:

1. You grant the repository owner a perpetual, worldwide, royalty-free license to use, modify, distribute and sublicense your contribution.
2. You affirm that your contribution does not contain any third-party code or intellectual property that could violate the repository’s license terms.

## Release Process

1. **Update version in `package.json`**
   - Modify **only** the `version` field of the packages you are releasing.
   - Commit the changes to `main` with the message: `chore: release v${version}`

2. **Publish packages to npm**
   - `pnpm publish`. You'll need to add the 2FA code with --otp=XXXXXX.

3. **Create GitHub release notes**
   - Use Automatic Release Notes. Assign a tag v${version} to the commit you created in step 1.
